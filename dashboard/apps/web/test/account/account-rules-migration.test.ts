/**
 * Carrying an account's old sign-in allowlist into its access rules, on the
 * database side: what `migrateAccountRules` writes, that it writes it once, and
 * that the rule it writes refuses and admits exactly what the old allowlist did.
 * Also the group change a list edit is judged with before it is written.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Group {
    id: string;
    ownerId: string;
    name: string;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
}
interface Rule {
    id: string;
    userId: string;
    name: string;
    position: number;
    enabled: boolean;
    action: string;
    timeZone: string;
    conditions: unknown;
}

const state = vi.hoisted(() => ({
    security: null as null | {
        userId: string;
        accessRulesMigratedAt: Date | null;
        allowedCidrs: string;
        allowedCountries: string;
        allowedContinents: string;
    },
    groups: [] as Group[],
    bindings: [] as { userId: string; groupId: string; enforced: boolean }[],
    rules: [] as Rule[],
    next: 0
}));

vi.mock("@polaris/db", () => {
    const tx = {
        userSecurity: {
            findUnique: async () => state.security,
            updateMany: async ({ where, data }: { where: { userId: string; accessRulesMigratedAt: null }; data: { accessRulesMigratedAt: Date } }) => {
                const row = state.security;
                if (!row || row.userId !== where.userId || row.accessRulesMigratedAt !== null) return { count: 0 };
                row.accessRulesMigratedAt = data.accessRulesMigratedAt;
                return { count: 1 };
            }
        },
        accessGroup: {
            findMany: async ({ where }: { where: { ownerId: string; id?: { in: string[] } } }) =>
                state.groups.filter(
                    (group) => group.ownerId === where.ownerId && (!where.id || where.id.in.includes(group.id))
                ),
            create: async ({ data }: { data: Omit<Group, "id"> }) => {
                const group = { id: `00000000-0000-4000-8000-${String((state.next += 1)).padStart(12, "0")}`, ...data };
                state.groups.push(group);
                return { id: group.id };
            }
        },
        userAccessGroup: {
            findMany: async ({ where }: { where: { userId: string; enforced: boolean } }) =>
                state.bindings.filter((row) => row.userId === where.userId && row.enforced === where.enforced)
        },
        accountAccessRule: {
            count: async ({ where }: { where: { userId: string } }) =>
                state.rules.filter((rule) => rule.userId === where.userId).length,
            create: async ({ data }: { data: Omit<Rule, "id"> }) => {
                state.rules.push({ id: `00000000-0000-4000-9000-${String((state.next += 1)).padStart(12, "0")}`, ...data });
            }
        }
    };
    return { prisma: { ...tx, $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } };
});
vi.mock("@polaris/auth", () => ({ resolveEnforcedRules: async () => null }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => ({ countryCode: null }) }));
vi.mock("@/lib/integrations/dymo", () => ({ verifyIp: async () => null }));
vi.mock("@/lib/network-rules", () => ({ evaluateNetworkRules: async () => null }));
vi.mock("@/lib/integrations/provider-pause", () => ({ takeServedLookup: async () => null }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null
}));

const { migrateAccountRules, resolveAccountRuleFacts } = await import("@/lib/account-rules");

const NAME = "Sign-in places (from earlier settings)";
const BOUND = "00000000-0000-4000-8000-0000000000b0";
const ENFORCED = "00000000-0000-4000-8000-0000000000e0";
const NO_CLIENT = { userAgent: null, brands: null, platform: null };

function storedRules(): core.AccountRule[] {
    return state.rules
        .sort((a, b) => a.position - b.position)
        .map(({ id, name, enabled, action, timeZone, conditions }) =>
            core.accountRuleSchema.parse({ id, name, enabled, action, timeZone, conditions })
        );
}

/** The verdict for an address under the account's rules as stored. */
async function verdict(ip: string) {
    const rules = storedRules();
    return core.evaluateAccountRules(rules, await resolveAccountRuleFacts("u1", rules, ip, NO_CLIENT, null)).action;
}

function security(cidrs: string[]) {
    return {
        userId: "u1",
        accessRulesMigratedAt: null,
        allowedCidrs: JSON.stringify(cidrs),
        allowedCountries: "[]",
        allowedContinents: "[]"
    };
}

function group(id: string, name: string, cidrs: string[]): Group {
    return { id, ownerId: "u1", name, allowedCidrs: JSON.stringify(cidrs), allowedCountries: "[]", allowedContinents: "[]" };
}

beforeEach(() => {
    state.security = null;
    state.groups = [];
    state.bindings = [];
    state.rules = [];
    state.next = 0;
});

describe("migrateAccountRules", () => {
    it("copies the inline allowlist into a saved list and names it, with the bound lists, in one block rule", async () => {
        state.security = security(["10.0.0.0/8"]);
        state.groups.push(group(BOUND, "Office", ["192.0.2.0/24"]));
        state.bindings.push({ userId: "u1", groupId: BOUND, enforced: false });

        const result = await migrateAccountRules("u1");

        expect(result.migrated).toBe(true);
        const copy = state.groups.find((row) => row.name === NAME);
        expect(copy?.allowedCidrs).toBe(JSON.stringify(["10.0.0.0/8"]));
        expect(result.groupIds).toEqual([copy!.id, BOUND]);
        expect(state.rules).toHaveLength(1);
        expect(state.rules[0]).toMatchObject({ name: NAME, action: "block", enabled: true, position: 0 });
        expect(state.security?.accessRulesMigratedAt).toBeInstanceOf(Date);
    });

    it("refuses and admits what the old union allowlist did", async () => {
        state.security = security(["10.0.0.0/8"]);
        state.groups.push(group(BOUND, "Office", ["192.0.2.0/24"]));
        state.bindings.push({ userId: "u1", groupId: BOUND, enforced: false });
        await migrateAccountRules("u1");

        expect(await verdict("10.1.2.3")).toBe("allow");
        expect(await verdict("192.0.2.7")).toBe("allow");
        expect(await verdict("198.51.100.1")).toBe("block");
        // No address with addresses listed was a refusal before, and still is.
        const rules = storedRules();
        expect(core.evaluateAccountRules(rules, await resolveAccountRuleFacts("u1", rules, null, NO_CLIENT, null)).action).toBe(
            "block"
        );
    });

    it("runs once: a second call writes nothing", async () => {
        state.security = security(["10.0.0.0/8"]);
        await migrateAccountRules("u1");
        const again = await migrateAccountRules("u1");
        expect(again).toEqual({ migrated: false, groupIds: [] });
        expect(state.rules).toHaveLength(1);
        expect(state.groups).toHaveLength(1);
    });

    it("writes no rule for an account that allowed everything", async () => {
        state.security = security([]);
        const result = await migrateAccountRules("u1");
        expect(result).toEqual({ migrated: true, groupIds: [] });
        expect(state.rules).toHaveLength(0);
        expect(state.groups).toHaveLength(0);
        expect(await verdict("198.51.100.1")).toBe("allow");
    });

    it("leaves an administrator's enforced binding out of the account's own rule", async () => {
        state.security = security([]);
        state.groups.push(group(ENFORCED, "Imposed", ["192.0.2.0/24"]));
        state.bindings.push({ userId: "u1", groupId: ENFORCED, enforced: true });
        const result = await migrateAccountRules("u1");
        expect(result.groupIds).toEqual([]);
        expect(state.rules).toHaveLength(0);
    });

    it("numbers the copied list when the owner already has one with its name", async () => {
        state.security = security(["10.0.0.0/8"]);
        state.groups.push(group(BOUND, NAME, ["203.0.113.0/24"]));
        await migrateAccountRules("u1");
        expect(state.groups.map((row) => row.name)).toEqual([NAME, `${NAME} 2`]);
        // The owner's own list is not merged into the rule.
        expect(await verdict("203.0.113.5")).toBe("block");
    });
});

describe("a list change judged before it is written", () => {
    it("reads the replacement in place of the stored list, and a delete as no list", async () => {
        state.security = security([]);
        state.groups.push(group(BOUND, "Office", ["192.0.2.0/24"]));
        state.bindings.push({ userId: "u1", groupId: BOUND, enforced: false });
        await migrateAccountRules("u1");
        const rules = storedRules();
        const judge = async (change?: Parameters<typeof resolveAccountRuleFacts>[5]) =>
            core.evaluateAccountRules(rules, await resolveAccountRuleFacts("u1", rules, "192.0.2.7", NO_CLIENT, null, change))
                .action;

        expect(await judge()).toBe("allow");
        const narrowed = core.unionRules([
            { allowedCidrs: JSON.stringify(["198.51.100.0/24"]), allowedCountries: "[]", allowedContinents: "[]" }
        ]);
        expect(await judge({ id: BOUND, replacement: narrowed })).toBe("block");
        // A rule naming only deleted lists restricts nothing, as an empty allowlist did.
        expect(await judge({ id: BOUND, replacement: null })).toBe("allow");
    });
});
