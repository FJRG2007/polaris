/**
 * Who may read and close the host ports a firewall scope's services answer on.
 *
 * The same checks the scope's rule is read and written under: `deploy.manage`,
 * `system.manage` for the two scopes nobody owns, and ownership of the scope - so
 * a customer never learns, or closes, the ports of somebody else's services.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CUSTOMER = { id: "00000000-0000-7000-8000-00000000000c" };
const PROJECT = "00000000-0000-7000-8000-0000000000e1";
const SERVICE = "00000000-0000-7000-8000-0000000000a1";

/** The permissions the caller holds. */
let holds: string[] = [];
let owns = true;

class Forbidden extends Error {}

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/session", () => ({
    requirePermission: async (permission: string) => {
        if (!holds.includes(permission)) throw new Forbidden(`missing ${permission}`);
        return CUSTOMER;
    },
    userHasManage: async () => false
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/waf-intel-service", () => ({}));
const recordAudit = vi.fn(async () => undefined);
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes: async () => undefined }));
vi.mock("@/lib/domain-edge", () => ({ syncDashboardRoute: async () => undefined }));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: async () => "203.0.113.7" }));
vi.mock("@/lib/address-accounts", () => ({ accountsAtAddress: async () => [] }));
vi.mock("@/lib/waf-ssh-service", () => ({ liftHostBlocks: async () => undefined }));
vi.mock("@/lib/waf-ban-service", () => ({ getWafJails: async () => [], setWafJails: async () => undefined }));
vi.mock("@/lib/waf-analytics-service", () => ({}));
vi.mock("@/lib/waf-anomaly-service", () => ({}));
vi.mock("@/lib/people-search", () => ({ findPeople: vi.fn(), findAccountsAsAdmin: vi.fn(), SHORTEST_SEARCH: 2 }));
vi.mock("@/lib/rich-text/mention-service", () => ({ like: () => ({}) }));
vi.mock("@/lib/privacy-service", () => ({ discoverableBy: async () => new Set() }));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set() }));
const assertScopeOwner = vi.fn(async () => {
    if (!owns) throw new Error("Project not found");
});
vi.mock("@/lib/waf-service", () => ({ assertScopeOwner, getWafRule: vi.fn(), setWafRule: vi.fn() }));
const directAccessIn = vi.fn(async () => [
    { applicationId: SERVICE, name: "web", address: "203.0.113.7:21234", held: null }
]);
vi.mock("@/lib/deploy/direct-port", async () => ({
    ...(await vi.importActual<object>("../../src/lib/deploy/direct-port")),
    directAccessIn
}));
const closeDirectPorts = vi.fn(async () => ({ closed: [SERVICE], failed: [], deferred: [] }));
vi.mock("@/lib/deploy/direct-port-close", () => ({ closeDirectPorts }));

const { closeDirectAccessAction, getDirectAccessAction } = await import(
    "../../src/app/(app)/apps/firewall/actions"
);

const SCOPE = { scopeType: "project" as const, scopeId: PROJECT };

beforeEach(() => {
    holds = ["deploy.manage"];
    owns = true;
    directAccessIn.mockClear();
    closeDirectPorts.mockClear();
    assertScopeOwner.mockClear();
    recordAudit.mockClear();
});

describe("reading what answers round a scope", () => {
    it("lists the owner's own services in the scope", async () => {
        const result = await getDirectAccessAction(SCOPE);
        expect(result.reachable).toHaveLength(1);
        expect(assertScopeOwner).toHaveBeenCalledWith(CUSTOMER.id, "project", PROJECT);
        expect(directAccessIn).toHaveBeenCalledWith(
            { AND: [{ environment: { project: { ownerId: CUSTOMER.id } } }, { environment: { projectId: PROJECT } }] },
            "203.0.113.7"
        );
    });

    it("refuses without deploy.manage", async () => {
        holds = [];
        await expect(getDirectAccessAction(SCOPE)).rejects.toBeInstanceOf(Forbidden);
        expect(directAccessIn).not.toHaveBeenCalled();
    });

    it("refuses the instance-wide scope without system.manage", async () => {
        const result = await getDirectAccessAction({ scopeType: "global", scopeId: "" }).catch((error) => error);
        expect(result).toBeInstanceOf(Error);
        expect(directAccessIn).not.toHaveBeenCalled();
    });

    it("says nothing about a scope the caller does not own", async () => {
        owns = false;
        const result = await getDirectAccessAction(SCOPE);
        expect(result).toEqual({ error: "Project not found" });
        expect(directAccessIn).not.toHaveBeenCalled();
    });

    it("has nothing to say for Polaris's own scope", async () => {
        holds = ["deploy.manage", "system.manage"];
        expect(await getDirectAccessAction({ scopeType: "polaris", scopeId: "" })).toEqual({ reachable: [] });
    });
});

describe("closing them", () => {
    it("closes the scope's ports as the operator, and records it", async () => {
        const result = await closeDirectAccessAction(SCOPE);
        expect(result).toEqual({ closed: 1, failed: 0, failedIds: [] });
        expect(closeDirectPorts).toHaveBeenCalledWith(
            { AND: [{ environment: { project: { ownerId: CUSTOMER.id } } }, { environment: { projectId: PROJECT } }] },
            { mode: "operator", actorId: CUSTOMER.id }
        );
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.waf.closeDirectAccess", targetId: PROJECT })
        );
    });

    it("narrows to one service when one is named", async () => {
        await closeDirectAccessAction({ ...SCOPE, applicationId: SERVICE });
        const [where] = closeDirectPorts.mock.calls[0] as unknown as [{ AND: unknown[] }];
        expect(where.AND[1]).toEqual({ id: SERVICE });
    });

    it("refuses without deploy.manage, without ownership, and on a malformed id", async () => {
        holds = [];
        await expect(closeDirectAccessAction(SCOPE)).rejects.toBeInstanceOf(Forbidden);
        holds = ["deploy.manage"];
        owns = false;
        expect(await closeDirectAccessAction(SCOPE)).toEqual({ error: "Project not found" });
        owns = true;
        expect(await closeDirectAccessAction({ ...SCOPE, applicationId: "../etc" })).toEqual({
            error: "errors.save"
        });
        expect(closeDirectPorts).not.toHaveBeenCalled();
    });

    it("refuses the instance-wide scope without system.manage", async () => {
        await expect(closeDirectAccessAction({ scopeType: "global", scopeId: "" })).rejects.toBeInstanceOf(Error);
        expect(closeDirectPorts).not.toHaveBeenCalled();
    });

    it("says so when nothing could be closed", async () => {
        closeDirectPorts.mockResolvedValueOnce({ closed: [], failed: [SERVICE], deferred: [] });
        expect(await closeDirectAccessAction(SCOPE)).toEqual({ error: "direct.closeFailed" });
    });
});
