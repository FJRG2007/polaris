/**
 * Restrictions an administrator imposes on somebody else's account. The whole
 * point of holding them apart from the account's own rules is that the account
 * cannot get out from under them, so the two things worth proving are that the
 * user's own editor never sees or deletes an enforced binding, and that the two
 * rule sets resolve separately - if they were folded together, adding a rule of
 * your own would widen a limit somebody else set for you.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Binding {
    userId: string;
    groupId: string;
    enforced: boolean;
}

interface Security {
    userId: string;
    allowedCidrs: string;
    allowedCountries: string;
    allowedContinents: string;
    adminCidrs: string;
    adminCountries: string;
    adminContinents: string;
}

const GROUPS = [
    { id: "group-own", ownerId: "user-1", allowedCidrs: '["10.0.0.0/8"]', allowedCountries: "[]", allowedContinents: "[]" },
    { id: "group-admin", ownerId: "admin-1", allowedCidrs: '["203.0.113.0/24"]', allowedCountries: "[]", allowedContinents: "[]" }
];

let bindings: Binding[] = [];
let security: Security | null = null;
const deletions: Record<string, unknown>[] = [];

function matches(binding: Binding, where: Record<string, unknown>): boolean {
    if (where.userId !== undefined && binding.userId !== where.userId) return false;
    if (where.enforced !== undefined && binding.enforced !== where.enforced) return false;
    if (where.OR) {
        const clauses = where.OR as Record<string, unknown>[];
        return clauses.some((clause) => {
            if (clause.enforced !== undefined) return binding.enforced === clause.enforced;
            const ids = (clause.groupId as { in: string[] } | undefined)?.in ?? [];
            return ids.includes(binding.groupId);
        });
    }
    return true;
}

const prisma = {
    userSecurity: {
        findUnique: async ({ where }: { where: { userId: string } }) =>
            security && security.userId === where.userId ? security : null,
        upsert: async ({ where, create, update }: { where: { userId: string }; create: Partial<Security>; update: Partial<Security> }) => {
            const base: Security = security ?? {
                userId: where.userId,
                allowedCidrs: "[]",
                allowedCountries: "[]",
                allowedContinents: "[]",
                adminCidrs: "[]",
                adminCountries: "[]",
                adminContinents: "[]"
            };
            security = { ...base, ...(security ? update : create), userId: where.userId };
            return security;
        }
    },
    userAccessGroup: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
            bindings
                .filter((binding) => matches(binding, where))
                .map((binding) => ({
                    groupId: binding.groupId,
                    group: GROUPS.find((group) => group.id === binding.groupId)
                })),
        deleteMany: ({ where }: { where: Record<string, unknown> }) => {
            deletions.push(where);
            return { where, __delete: true };
        },
        createMany: ({ data }: { data: Binding[] }) => ({ data, __create: true })
    },
    accessGroup: {
        findMany: async ({ where }: { where: { ownerId: string; id: { in: string[] } } }) =>
            GROUPS.filter((group) => group.ownerId === where.ownerId && where.id.in.includes(group.id)).map(
                (group) => ({ id: group.id })
            )
    },
    // The writers batch their delete and insert; running them in order is what
    // the real transaction guarantees.
    $transaction: async (operations: { where?: Record<string, unknown>; data?: Binding[]; __delete?: boolean; __create?: boolean }[]) => {
        for (const operation of operations) {
            if (operation.__delete && operation.where) {
                bindings = bindings.filter((binding) => !matches(binding, operation.where as Record<string, unknown>));
            }
            if (operation.__create && operation.data) {
                for (const row of operation.data) {
                    bindings.push({ userId: row.userId, groupId: row.groupId, enforced: row.enforced ?? false });
                }
            }
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));

const { getUserSecurity, updateEnforcedRules, updateSignInRules } = await import("../../src/security.js");
const { resolveEnforcedRules, resolveSignInRules } = await import("../../src/access-groups.js");

const NO_RULES = { groupIds: [], allowedCidrs: [], allowedCountries: [], allowedContinents: [] };

beforeEach(() => {
    bindings = [];
    security = null;
    deletions.length = 0;
});

describe("imposing restrictions on an account", () => {
    it("keeps the administrator's rules out of the account's own", async () => {
        await updateSignInRules("user-1", { ...NO_RULES, allowedCidrs: ["192.0.2.0/24"] });
        await updateEnforcedRules("user-1", "admin-1", { ...NO_RULES, allowedCidrs: ["203.0.113.7"] });

        expect(await resolveSignInRules("user-1")).toEqual({
            allowedCidrs: ["192.0.2.0/24"],
            allowedCountries: [],
            allowedContinents: []
        });
        expect(await resolveEnforcedRules("user-1")).toEqual({
            allowedCidrs: ["203.0.113.7"],
            allowedCountries: [],
            allowedContinents: []
        });
    });

    it("survives the account saving its own rules afterwards", async () => {
        await updateEnforcedRules("user-1", "admin-1", { ...NO_RULES, groupIds: ["group-admin"] });
        await updateSignInRules("user-1", { ...NO_RULES, groupIds: ["group-own"] });

        expect(await resolveEnforcedRules("user-1")).toEqual({
            allowedCidrs: ["203.0.113.0/24"],
            allowedCountries: [],
            allowedContinents: []
        });
        // The account's own save only ever clears its own bindings.
        expect(deletions.some((where) => where.enforced === false)).toBe(true);
        expect(bindings.filter((binding) => binding.enforced)).toHaveLength(1);
    });

    it("never offers an enforced group to the account's own editor", async () => {
        await updateEnforcedRules("user-1", "admin-1", { ...NO_RULES, groupIds: ["group-admin"] });
        expect((await getUserSecurity("user-1")).groupIds).toEqual([]);
    });

    it("ignores a group the administrator does not own", async () => {
        await updateEnforcedRules("user-1", "admin-1", { ...NO_RULES, groupIds: ["group-own"] });
        expect(bindings).toHaveLength(0);
    });

    it("takes over a group the account had attached to itself", async () => {
        await updateSignInRules("user-1", { ...NO_RULES, groupIds: ["group-own"] });
        // The same group, now imposed by its owner rather than chosen.
        await updateEnforcedRules("user-1", "user-1", { ...NO_RULES, groupIds: ["group-own"] });

        expect(bindings).toEqual([{ userId: "user-1", groupId: "group-own", enforced: true }]);
        expect(await resolveSignInRules("user-1")).toEqual({
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: []
        });
    });

    it("lifts every imposed rule when the editor is emptied", async () => {
        await updateEnforcedRules("user-1", "admin-1", {
            ...NO_RULES,
            groupIds: ["group-admin"],
            allowedCountries: ["ES"]
        });
        await updateEnforcedRules("user-1", "admin-1", NO_RULES);

        expect(await resolveEnforcedRules("user-1")).toEqual({
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: []
        });
    });
});
