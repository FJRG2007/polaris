/**
 * Who a require-login rule can name, as each kind of caller is offered them.
 *
 * What a hosting company running Polaris for its customers depends on: a customer
 * who can deploy is offered the roles and groups they are in and nobody else's,
 * finds people only the way they could anywhere else in Polaris, and never
 * receives the instance's list of accounts. An administrator still finds anybody.
 * Entries a rule already names keep their names, whoever wrote them, and only
 * the entries the stored rule holds - never ids the request sends.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { id: "00000000-0000-7000-8000-00000000000a", isAdmin: true };
const CUSTOMER = { id: "00000000-0000-7000-8000-00000000000c", isAdmin: false };
const OTHER = "00000000-0000-7000-8000-0000000000f0";
const GROUP = "00000000-0000-7000-8000-0000000000a1";

let caller: { id: string; isAdmin: boolean } = ADMIN;
/** The roles and groups the customer holds, and the people they can find. */
let held: string[] = [];
let findable: string[] = [];
let blocked: string[] = [];
let asked: { model: string; args: { where?: Record<string, unknown>; take?: number } }[] = [];

function model(name: string, rows: Record<string, unknown>[]) {
    return {
        findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
            asked.push({ model: name, args });
            const ids = (args.where?.id as { in?: string[] } | undefined)?.in;
            return ids ? rows.filter((row) => ids.includes(row.id as string)) : rows;
        },
        findFirst: async (args: { where?: Record<string, unknown> }) => {
            asked.push({ model: `${name}.first`, args });
            return rows.find((row) => row.id === args.where?.id) ?? null;
        }
    };
}

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        role: model("role", [{ id: "00000000-0000-7000-8000-0000000000b1", name: "Staff" }]),
        group: model("group", [{ id: GROUP, name: "Customers of Acme" }]),
        userRole: {
            findMany: async (args: { where: { userId: string; roleId: { in: string[] } } }) =>
                args.where.roleId.in.filter((id) => held.includes(`role:${id}`)).map((roleId) => ({ roleId }))
        },
        groupMember: {
            findMany: async (args: { where: { userId: string; groupId: { in: string[] } } }) =>
                args.where.groupId.in.filter((id) => held.includes(`group:${id}`)).map((groupId) => ({ groupId }))
        },
        user: model("user", [
            { id: OTHER, name: "Other Customer", email: "other@example.com" },
            { id: CUSTOMER.id, name: "Me", email: "me@example.com" }
        ])
    }
}));
vi.mock("@/lib/session", () => ({
    requirePermission: async () => caller,
    userHasManage: async () => true
}));
const findPeople = vi.fn(async () => ({ people: [{ id: OTHER, name: "Other Customer" }], withheld: 0 }));
const findAccountsAsAdmin = vi.fn(async () => [{ id: OTHER, name: "Other Customer" }]);
vi.mock("@/lib/people-search", () => ({ findPeople, findAccountsAsAdmin, SHORTEST_SEARCH: 2 }));
vi.mock("@/lib/rich-text/mention-service", () => ({
    like: (term: string) => ({ contains: term, mode: "insensitive" })
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/waf-intel-service", () => ({}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/deploy-service", () => ({ syncAppRoutes: async () => undefined }));
vi.mock("@/lib/domain-edge", () => ({ syncDashboardRoute: async () => undefined }));
vi.mock("@/lib/address-accounts", () => ({ accountsAtAddress: async () => [] }));
vi.mock("@/lib/waf-ssh-service", () => ({ liftHostBlocks: async () => undefined }));
vi.mock("@/lib/waf-ban-service", () => ({ getWafJails: async () => [], setWafJails: async () => undefined }));
vi.mock("@/lib/waf-analytics-service", () => ({}));
let stored: string[] = [];
const getWafRule = vi.fn(async (_owner: string, _type: string, _id: string) => ({
    loginAllowPrincipals: stored.map((ref) => ({ ref })),
    loginDenyPrincipals: []
}));
const setWafRule = vi.fn(async () => undefined);
vi.mock("@/lib/waf-service", () => ({ getWafRule, setWafRule }));
vi.mock("@/lib/privacy-service", () => ({
    discoverableBy: async (_viewer: unknown, ids: string[]) => new Set(ids.filter((id) => findable.includes(id)))
}));
vi.mock("@/lib/blocks", () => ({
    blockedBetween: async (_id: string, ids: string[]) => new Set(ids.filter((id) => blocked.includes(id)))
}));
vi.mock("@/lib/waf-anomaly-service", () => ({}));

const { listWafPrincipalsAction, findWafPeopleAction, setWafRuleAction } = await import("../../src/app/(app)/apps/firewall/actions");

const SCOPE = { scopeType: "project" as const, scopeId: "00000000-0000-7000-8000-0000000000e1" };

beforeEach(() => {
    asked = [];
    stored = [];
    held = [];
    findable = [];
    blocked = [];
    getWafRule.mockClear();
    setWafRule.mockClear();
    findPeople.mockClear();
    findAccountsAsAdmin.mockClear();
});

describe("the roles and groups a rule can name", () => {
    it("never lists people", async () => {
        caller = ADMIN;
        const { principals } = await listWafPrincipalsAction();
        expect(principals?.some((option) => option.type === "user")).toBe(false);
        expect(asked.filter((query) => query.model === "user").every((query) => query.args.where?.id)).toBe(true);
    });

    it("offers a customer only the roles and groups they are in", async () => {
        caller = CUSTOMER;
        await listWafPrincipalsAction();
        const [role, group] = asked.filter((query) => query.model === "role" || query.model === "group");
        expect(role?.args.where).toEqual({ users: { some: { userId: CUSTOMER.id } } });
        expect(group?.args.where).toEqual({ members: { some: { userId: CUSTOMER.id } } });
    });

    it("offers an administrator every role and group, bounded", async () => {
        caller = ADMIN;
        await listWafPrincipalsAction();
        const [role, group] = asked.filter((query) => query.model === "role" || query.model === "group");
        expect(role?.args.where).toEqual({});
        expect(group?.args.where).toEqual({});
        expect(role?.args.take).toBeLessThanOrEqual(200);
    });

    it("names who the rule already names, without a stranger's email", async () => {
        caller = CUSTOMER;
        stored = [`user:${OTHER}`, `user:${CUSTOMER.id}`, "user:not-an-id"];
        const { principals } = await listWafPrincipalsAction(SCOPE);
        expect(getWafRule).toHaveBeenCalledWith(CUSTOMER.id, SCOPE.scopeType, SCOPE.scopeId);
        const other = principals?.find((option) => option.ref === `user:${OTHER}`);
        expect(other?.label).toBe("Other Customer");
        expect(other?.sublabel).toBeUndefined();
        expect(principals?.find((option) => option.ref === `user:${CUSTOMER.id}`)?.sublabel).toBe("me@example.com");
    });

    it("names nobody the stored rule does not, whatever the request carries", async () => {
        caller = CUSTOMER;
        const sent = [`user:${OTHER}`, `group:${GROUP}`] as unknown as typeof SCOPE;
        expect((await listWafPrincipalsAction(sent)).error).toBeTruthy();
        const { principals } = await listWafPrincipalsAction(SCOPE);
        expect(principals?.some((option) => option.ref === `user:${OTHER}`)).toBe(false);
        expect(asked.filter((query) => query.model === "user")).toEqual([
            { model: "user", args: expect.objectContaining({ where: { id: { in: [] } } }) }
        ]);
    });

    it("names nobody for a rule the caller cannot read", async () => {
        caller = CUSTOMER;
        getWafRule.mockRejectedValueOnce(new Error("Project not found"));
        const { principals, error } = await listWafPrincipalsAction(SCOPE);
        expect(principals).toBeUndefined();
        expect(error).toBeTruthy();
        expect(asked.filter((query) => query.model === "user")).toHaveLength(0);
    });

    it("refuses a rule naming more than any rule should", async () => {
        caller = ADMIN;
        stored = Array.from({ length: 201 }, (_, index) => `user:${index}`);
        expect((await listWafPrincipalsAction(SCOPE)).error).toBeTruthy();
    });
});

describe("finding a person to name", () => {
    it("asks nothing for fewer than two characters", async () => {
        caller = CUSTOMER;
        expect(await findWafPeopleAction("a")).toEqual({ results: [] });
        expect(asked).toHaveLength(0);
        expect(findPeople).not.toHaveBeenCalled();
    });

    it("finds a customer only who they could find anywhere else, and themselves", async () => {
        caller = CUSTOMER;
        const { results } = await findWafPeopleAction("  me ");
        expect(findPeople).toHaveBeenCalledWith({ id: CUSTOMER.id }, "me", expect.objectContaining({ limit: 20 }));
        expect(results?.map((person) => person.id)).toEqual([CUSTOMER.id, OTHER]);
        expect(findAccountsAsAdmin).not.toHaveBeenCalled();
    });

    it("finds an administrator anybody, a page at most", async () => {
        caller = ADMIN;
        const { results } = await findWafPeopleAction("other");
        expect(findPeople).not.toHaveBeenCalled();
        expect(findAccountsAsAdmin).toHaveBeenCalledWith("other", 20);
        expect(results).toEqual([{ id: OTHER, name: "Other Customer" }]);
    });
});

describe("saving who a rule names", () => {
    const ROLE = "00000000-0000-7000-8000-0000000000b1";
    function save(admitted: string[], refused: string[] = []) {
        return setWafRuleAction({
            ...SCOPE,
            ipAllowlist: [],
            ipDenylist: [],
            requireLogin: true,
            loginAllowPrincipals: admitted.map((ref) => ({ ref })),
            loginDenyPrincipals: refused.map((ref) => ({ ref })),
            browserIntegrity: false,
            sqlInjectionProtection: false,
            xssProtection: false,
            emailObfuscation: false,
            frameProtection: false,
            frameAncestors: [],
            presets: [],
            rules: []
        });
    }

    it("saves the roles, groups and people the customer could pick", async () => {
        caller = CUSTOMER;
        held = [`role:${ROLE}`, `group:${GROUP}`];
        findable = [OTHER];
        expect(await save([`role:${ROLE}`, `group:${GROUP}`, `user:${CUSTOMER.id}`], [`user:${OTHER}`])).toEqual({});
        expect(setWafRule).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["a role they do not hold", `role:00000000-0000-7000-8000-0000000000b2`],
        ["a group they are not in", `group:00000000-0000-7000-8000-0000000000a2`],
        ["a person they cannot find", `user:${OTHER}`],
        ["something that is not an id", "user:not-an-id"]
    ])("refuses %s, and saves nothing", async (_what, ref) => {
        caller = CUSTOMER;
        expect(await save([], [ref])).toEqual({ error: "errors.outOfReach" });
        expect(setWafRule).not.toHaveBeenCalled();
    });

    it("refuses a person either side has blocked", async () => {
        caller = CUSTOMER;
        findable = [OTHER];
        blocked = [OTHER];
        expect((await save([`user:${OTHER}`])).error).toBe("errors.outOfReach");
        expect(setWafRule).not.toHaveBeenCalled();
    });

    it("keeps what the stored rule already names, whoever added it", async () => {
        caller = CUSTOMER;
        stored = [`user:${OTHER}`, `group:00000000-0000-7000-8000-0000000000a2`];
        expect(await save(stored)).toEqual({});
        expect(setWafRule).toHaveBeenCalledTimes(1);
    });

    it("lets an administrator name anybody", async () => {
        caller = ADMIN;
        expect(await save([`user:${OTHER}`, `role:00000000-0000-7000-8000-0000000000b2`])).toEqual({});
        expect(getWafRule).not.toHaveBeenCalled();
        expect(setWafRule).toHaveBeenCalledTimes(1);
    });
});
