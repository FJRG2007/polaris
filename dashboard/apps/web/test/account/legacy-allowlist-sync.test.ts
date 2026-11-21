/**
 * The old sign-in dialog, after an account has moved to rules.
 *
 * The dialog writes the allowlist columns and the guard stopped reading them at
 * the move, so a save there changed nothing and said nothing. These hold the
 * sync to what the dialog shows: the carried-over list and rule follow every
 * save, an emptied allowlist stops refusing, and an account that has not moved
 * yet is left for the move to read.
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
        userSecurity: { findUnique: async () => state.security },
        accessGroup: {
            findFirst: async ({ where }: { where: { ownerId: string; name: string } }) =>
                state.groups.find((group) => group.ownerId === where.ownerId && group.name === where.name) ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Partial<Group> }) => {
                const group = state.groups.find((row) => row.id === where.id)!;
                Object.assign(group, data);
                return group;
            },
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
            findFirst: async ({ where }: { where: { userId: string; name: string } }) =>
                state.rules.find((rule) => rule.userId === where.userId && rule.name === where.name) ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Partial<Rule> }) => {
                Object.assign(state.rules.find((rule) => rule.id === where.id)!, data);
            },
            create: async ({ data }: { data: Omit<Rule, "id"> }) => {
                state.rules.push({ id: `00000000-0000-4000-9000-${String((state.next += 1)).padStart(12, "0")}`, ...data });
            },
            delete: async ({ where }: { where: { id: string } }) => {
                state.rules = state.rules.filter((rule) => rule.id !== where.id);
            }
        }
    };
    return { prisma: { ...tx, $transaction: async (run: (client: typeof tx) => unknown) => run(tx) } };
});
vi.mock("@polaris/auth", () => ({ resolveEnforcedRules: async () => null }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => null }));
vi.mock("@/lib/integrations/dymo", () => ({ verifyIp: async () => null }));
vi.mock("@/lib/network-rules", () => ({ evaluateNetworkRules: async () => null }));
vi.mock("@/lib/integrations/provider-pause", () => ({ takeServedLookup: async () => null }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null
}));

const { syncLegacyAllowlist } = await import("@/lib/account-rules");

const NAME = "Sign-in places (from earlier settings)";
const G0 = "00000000-0000-4000-8000-0000000000a0";
const R0 = "00000000-0000-4000-9000-0000000000a0";
const R9 = "00000000-0000-4000-9000-0000000000a9";

/** The verdict for an address under the account's rules as stored. */
function verdict(ip: string) {
    const rules = state.rules
        .sort((a, b) => a.position - b.position)
        .map(({ id, name, enabled, action, timeZone, conditions }) =>
            core.accountRuleSchema.parse({ id, name, enabled, action, timeZone, conditions })
        );
    const groups = new Map(
        state.groups.map((group) => [group.id, core.unionRules([group])] as const)
    );
    return core.evaluateAccountRules(rules, {
        ip,
        country: null,
        os: null,
        browser: null,
        handheld: null,
        network: null,
        now: new Date(),
        groups
    }).action;
}

beforeEach(() => {
    state.groups = [];
    state.bindings = [];
    state.rules = [];
    state.next = 0;
});

describe("the old sign-in dialog on an account that moved to rules", () => {
    it("carries a save into the list and rule, so the guard enforces it", async () => {
        // Moved with 10.0.0.0/8 allowed; the dialog now allows only 192.0.2.0/24.
        state.groups.push({
            id: G0,
            ownerId: "u1",
            name: NAME,
            allowedCidrs: JSON.stringify(["10.0.0.0/8"]),
            allowedCountries: "[]",
            allowedContinents: "[]"
        });
        state.rules.push({
            id: R0,
            userId: "u1",
            name: NAME,
            position: 0,
            ...core.legacyAllowlistRule([G0], NAME),
            conditions: core.legacyAllowlistRule([G0], NAME).conditions
        });
        expect(verdict("10.1.2.3")).toBe("allow");

        state.security = {
            accessRulesMigratedAt: new Date(),
            allowedCidrs: JSON.stringify(["192.0.2.0/24"]),
            allowedCountries: "[]",
            allowedContinents: "[]"
        };
        await syncLegacyAllowlist("u1");

        expect(verdict("10.1.2.3")).toBe("block");
        expect(verdict("192.0.2.7")).toBe("allow");
        expect(state.rules).toHaveLength(1);
    });

    it("stops refusing anything once the dialog is emptied", async () => {
        state.groups.push({
            id: G0,
            ownerId: "u1",
            name: NAME,
            allowedCidrs: JSON.stringify(["10.0.0.0/8"]),
            allowedCountries: "[]",
            allowedContinents: "[]"
        });
        state.rules.push({
            id: R0,
            userId: "u1",
            name: NAME,
            position: 0,
            ...core.legacyAllowlistRule([G0], NAME)
        });
        state.security = { accessRulesMigratedAt: new Date(), allowedCidrs: "[]", allowedCountries: "[]", allowedContinents: "[]" };
        await syncLegacyAllowlist("u1");
        expect(state.rules).toHaveLength(0);
        expect(verdict("203.0.113.9")).toBe("allow");
    });

    it("creates the rule, judged first, when a moved account had no allowlist before", async () => {
        state.rules.push({
            id: R9,
            userId: "u1",
            name: "Mine",
            position: 0,
            enabled: true,
            action: "allow",
            timeZone: "UTC",
            conditions: [{ field: "ip", operator: "in", values: ["0.0.0.0/0"] }]
        });
        state.security = {
            accessRulesMigratedAt: new Date(),
            allowedCidrs: JSON.stringify(["192.0.2.0/24"]),
            allowedCountries: "[]",
            allowedContinents: "[]"
        };
        await syncLegacyAllowlist("u1");
        const created = state.rules.find((rule) => rule.name === NAME)!;
        expect(created.position).toBe(-1);
        expect(state.groups.find((group) => group.name === NAME)?.allowedCidrs).toBe(JSON.stringify(["192.0.2.0/24"]));
    });

    it("leaves an account that has not moved yet for the move to read", async () => {
        state.security = {
            accessRulesMigratedAt: null,
            allowedCidrs: JSON.stringify(["192.0.2.0/24"]),
            allowedCountries: "[]",
            allowedContinents: "[]"
        };
        await syncLegacyAllowlist("u1");
        expect(state.rules).toHaveLength(0);
        expect(state.groups).toHaveLength(0);
    });
});
