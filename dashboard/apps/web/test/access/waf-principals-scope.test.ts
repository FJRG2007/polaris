/**
 * Who a require-login rule can name, as each kind of caller is offered them.
 *
 * What a hosting company running Polaris for its customers depends on: a customer
 * who can deploy is offered the roles and groups they are in and nobody else's,
 * finds people only the way they could anywhere else in Polaris, and never
 * receives the instance's list of accounts. An administrator still finds anybody.
 * Entries a rule already names keep their names, whoever wrote them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { id: "00000000-0000-7000-8000-00000000000a", isAdmin: true };
const CUSTOMER = { id: "00000000-0000-7000-8000-00000000000c", isAdmin: false };
const OTHER = "00000000-0000-7000-8000-0000000000f0";
const GROUP = "00000000-0000-7000-8000-0000000000a1";

let caller: { id: string; isAdmin: boolean } = ADMIN;
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
vi.mock("@/lib/waf-service", () => ({}));
vi.mock("@/lib/waf-anomaly-service", () => ({}));

const { listWafPrincipalsAction, findWafPeopleAction } = await import("../../src/app/(app)/apps/firewall/actions");

beforeEach(() => {
    asked = [];
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
        const { principals } = await listWafPrincipalsAction([`user:${OTHER}`, `user:${CUSTOMER.id}`, "user:not-an-id"]);
        const other = principals?.find((option) => option.ref === `user:${OTHER}`);
        expect(other?.label).toBe("Other Customer");
        expect(other?.sublabel).toBeUndefined();
        expect(principals?.find((option) => option.ref === `user:${CUSTOMER.id}`)?.sublabel).toBe("me@example.com");
    });

    it("refuses a list of names longer than any rule", async () => {
        caller = ADMIN;
        const many = Array.from({ length: 201 }, (_, index) => `user:${index}`);
        expect((await listWafPrincipalsAction(many)).error).toBeTruthy();
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
