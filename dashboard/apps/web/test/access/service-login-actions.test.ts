/**
 * A service's "Require Polaris login" as Deploy writes it.
 *
 * It is the firewall's rule on the service's own scope, not a setting of its own: the
 * write has to land through `setWafRule` on ("application", id), keep every other
 * control the stored rule holds, and pass the same checks the firewall's own save
 * makes - `deploy.manage`, ownership, and entries the caller could have picked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = { id: "00000000-0000-7000-8000-00000000000c", isAdmin: false };
const APP = "00000000-0000-7000-8000-0000000000a1";
const MY_GROUP = "00000000-0000-7000-8000-0000000000b1";
const OTHER_GROUP = "00000000-0000-7000-8000-0000000000b2";

const STORED = {
    ipAllowlist: ["10.0.0.0/8"],
    ipDenylist: [],
    requireLogin: false,
    loginAllowPrincipals: [] as { ref: string }[],
    loginDenyPrincipals: [] as { ref: string }[],
    browserIntegrity: true,
    sqlInjectionProtection: true,
    xssProtection: false,
    emailObfuscation: true,
    frameProtection: true,
    frameAncestors: [],
    frameRules: [],
    presets: ["scanners"],
    rules: []
};

let canDeploy = true;
let owns = true;
let domains: { hostname: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userRole: { findMany: async () => [] },
        groupMember: {
            findMany: async (args: { where: { groupId: { in: string[] } } }) =>
                args.where.groupId.in.filter((id) => id === MY_GROUP).map((groupId) => ({ groupId }))
        },
        domain: {
            findMany: async (args: { take: number }) => domains.slice(0, args.take),
            count: async () => domains.length
        }
    }
}));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => ME,
    requireUser: async () => ME,
    userHasManage: async () => canDeploy
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/waf-intel-service", () => ({}));
const recordAudit = vi.fn(async () => undefined);
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
const syncAppRoutes = vi.fn(async () => undefined);
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes }));
vi.mock("@/lib/domain-edge", () => ({ syncDashboardRoute: async () => undefined }));
vi.mock("@/lib/domain-service", () => ({ getPublicIp: async () => null }));
vi.mock("@/lib/address-accounts", () => ({ accountsAtAddress: async () => [] }));
vi.mock("@/lib/waf-ssh-service", () => ({ liftHostBlocks: async () => undefined }));
vi.mock("@/lib/waf-ban-service", () => ({}));
vi.mock("@/lib/waf-analytics-service", () => ({}));
vi.mock("@/lib/waf-anomaly-service", () => ({}));
vi.mock("@/lib/privacy-service", () => ({ discoverableBy: async () => new Set() }));
vi.mock("@/lib/blocks", () => ({ blockedBetween: async () => new Set() }));
const getWafRule = vi.fn(async () => ({ ...STORED }));
const setWafRule = vi.fn(async () => undefined);
const assertScopeOwner = vi.fn(async () => {
    if (!owns) throw new Error("Service not found");
});
vi.mock("@/lib/waf-service", () => ({
    getWafRule,
    setWafRule,
    assertScopeOwner,
    getWafInherited: async () => ({ requireLogin: false })
}));

const { getServiceLoginAction, setServiceLoginAction, serviceLoginAccessAction } = await import(
    "../../src/app/(app)/apps/firewall/actions"
);

beforeEach(() => {
    canDeploy = true;
    owns = true;
    domains = [];
    getWafRule.mockClear();
    setWafRule.mockClear();
    recordAudit.mockClear();
    syncAppRoutes.mockClear();
});

describe("reading a service's login rule", () => {
    it("says why when the reader lacks deploy.manage, and reads nothing", async () => {
        canDeploy = false;
        expect(await getServiceLoginAction(APP)).toEqual({ refusal: "permission" });
        expect(getWafRule).not.toHaveBeenCalled();
    });

    it("says why when the project is not the reader's, and reads nothing", async () => {
        owns = false;
        expect(await getServiceLoginAction(APP)).toEqual({ refusal: "owner" });
        expect(getWafRule).not.toHaveBeenCalled();
    });

    it("refuses an id that is not one", async () => {
        expect((await getServiceLoginAction("../x")).error).toBeTruthy();
    });

    it("reads the firewall's own row for the service, with the addresses it covers", async () => {
        domains = [{ hostname: "a.example.test" }, { hostname: "b.example.test" }];
        const result = await getServiceLoginAction(APP);
        expect(getWafRule).toHaveBeenCalledWith(ME.id, "application", APP);
        expect(result.login).toMatchObject({
            requireLogin: false,
            requiredAbove: false,
            hostnames: ["a.example.test", "b.example.test"],
            hostnameCount: 2
        });
    });

    it("answers the new-service form's question with the environment's owner check", async () => {
        expect(await serviceLoginAccessAction(APP)).toEqual({});
        owns = false;
        expect(await serviceLoginAccessAction(APP)).toEqual({ refusal: "owner" });
    });
});

describe("writing a service's login rule", () => {
    it("writes only the login, keeping every other control as stored", async () => {
        const result = await setServiceLoginAction({
            applicationId: APP,
            requireLogin: true,
            loginAllowPrincipals: [{ ref: `group:${MY_GROUP}` }]
        });
        expect(result).toEqual({});
        expect(setWafRule).toHaveBeenCalledWith(ME.id, "application", APP, {
            ...STORED,
            requireLogin: true,
            loginAllowPrincipals: [{ ref: `group:${MY_GROUP}` }],
            loginDenyPrincipals: []
        });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.waf.set", targetType: "application" })
        );
        expect(syncAppRoutes).toHaveBeenCalled();
    });

    it("refuses an entry the caller could not have picked, and writes nothing", async () => {
        const result = await setServiceLoginAction({
            applicationId: APP,
            loginAllowPrincipals: [{ ref: `group:${OTHER_GROUP}` }]
        });
        expect(result.error).toBe("errors.outOfReach");
        expect(setWafRule).not.toHaveBeenCalled();
    });

    it("refuses a malformed request before touching anything", async () => {
        for (const input of [
            { applicationId: "nope", requireLogin: true },
            { applicationId: APP, requireLogin: "yes" },
            { applicationId: APP, loginAllowPrincipals: [{ ref: "admin" }] }
        ]) {
            expect((await setServiceLoginAction(input)).error).toBe("errors.save");
        }
        expect(getWafRule).not.toHaveBeenCalled();
    });

    it("passes the ownership refusal through without writing", async () => {
        getWafRule.mockImplementationOnce(async () => {
            throw new Error("Service not found");
        });
        const result = await setServiceLoginAction({ applicationId: APP, requireLogin: true });
        expect(result.error).toBe("Service not found");
        expect(setWafRule).not.toHaveBeenCalled();
    });
});
