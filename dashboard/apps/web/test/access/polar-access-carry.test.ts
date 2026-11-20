/**
 * Polar's old audiences are carried into roles, group policies and overrides on
 * the first start of the version that stopped reading them. Every stored shape
 * must leave every account with exactly the Polar it had: nobody loses it on an
 * update and nobody gains it.
 */

import type { PolicyStatement } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    settings: new Map<string, string>(),
    roles: [] as { id: string; name: string; permissions: string }[],
    users: [] as { id: string; isAdmin: boolean; roles: string[]; groups: string[] }[],
    groups: [] as string[],
    policies: [] as { id: string; name: string; document: string }[],
    attachments: [] as { policyId: string; principalType: string; principalId: string }[],
    overrides: [] as { userId: string; permission: string; effect: string }[],
    shared: false,
    seeded: 0
}));

/** The statements one account resolves to, as `resolveGlobalStatements` builds them. */
function statementsOf(userId: string): PolicyStatement[] {
    const user = db.users.find((row) => row.id === userId);
    if (!user) return [];
    const fromRoles = db.roles
        .filter((role) => user.roles.includes(role.name))
        .flatMap((role) => (JSON.parse(role.permissions) as string[]).map((key) => ({
            effect: "allow" as const,
            actions: [key],
            resources: ["*"]
        })));
    const fromGroups = db.attachments
        .filter((entry) => entry.principalType === "group" && user.groups.includes(entry.principalId))
        .flatMap((entry) => JSON.parse(db.policies.find((p) => p.id === entry.policyId)!.document).statements);
    const fromOverrides = db.overrides
        .filter((row) => row.userId === userId)
        .map((row) => ({ effect: row.effect as "allow" | "deny", actions: [row.permission], resources: ["*"] }));
    return [...fromRoles, ...fromGroups, ...fromOverrides];
}

const userRow = (user: (typeof db.users)[number]) => ({
    id: user.id,
    isAdmin: user.isAdmin,
    roles: user.roles.map((name) => ({ role: { name } })),
    groups: user.groups.map((groupId) => ({ groupId }))
});

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: async ({ where }: { where: { key: string } }) =>
                db.settings.has(where.key) ? { key: where.key } : null,
            upsert: async ({ where, create }: { where: { key: string }; create: { value: string } }) => {
                if (!db.settings.has(where.key)) db.settings.set(where.key, create.value);
            }
        },
        role: {
            findMany: async () => db.roles,
            update: async ({ where, data }: { where: { id: string }; data: { permissions: string } }) => {
                db.roles.find((role) => role.id === where.id)!.permissions = data.permissions;
            }
        },
        group: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                db.groups.filter((id) => where.id.in.includes(id)).map((id) => ({ id }))
        },
        policy: {
            findUnique: async ({ where }: { where: { name: string } }) =>
                db.policies.find((row) => row.name === where.name) ?? null,
            create: async ({ data }: { data: { name: string; document: string } }) => {
                const row = { id: `policy-${db.policies.length}`, ...data };
                db.policies.push(row);
                return { id: row.id };
            }
        },
        policyAttachment: {
            upsert: async ({ create }: { create: (typeof db.attachments)[number] }) => {
                const same = (row: (typeof db.attachments)[number]) =>
                    row.policyId === create.policyId && row.principalId === create.principalId;
                if (!db.attachments.some(same)) db.attachments.push(create);
            }
        },
        userPermission: {
            upsert: async ({ create }: { create: (typeof db.overrides)[number] }) => {
                const same = (row: (typeof db.overrides)[number]) =>
                    row.userId === create.userId && row.permission === create.permission;
                if (!db.overrides.some(same)) db.overrides.push(create);
            }
        },
        user: {
            findMany: async ({ where }: { where: Record<string, any> }) =>
                db.users
                    .filter((user) => {
                        if (where.id?.in && !where.id.in.includes(user.id)) return false;
                        if (where.isAdmin === false && user.isAdmin) return false;
                        if (where.roles?.none && user.roles.length > 0) return false;
                        if (where.roles?.every && !user.roles.every((name) => name === "guest")) return false;
                        const inGroups: string[] | undefined = where.groups?.some?.groupId?.in;
                        if (inGroups && !user.groups.some((id) => inGroups.includes(id))) return false;
                        return true;
                    })
                    .map(userRow),
            findUnique: async ({ where }: { where: { id: string } }) => {
                const user = db.users.find((row) => row.id === where.id);
                return user ? { isAdmin: user.isAdmin } : null;
            }
        }
    }
}));
vi.mock("@polaris/auth", () => ({
    resolveGlobalStatements: async (userId: string) => statementsOf(userId),
    seedDefaultRoles: async () => {
        db.seeded += 1;
    }
}));
vi.mock("@/lib/api-session", () => ({ apiUser: async () => null }));
vi.mock("@/lib/agents/model-keys", () => ({ instanceKeysAreShared: async () => db.shared }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => db.settings.get(key) ?? null,
    setSetting: async (key: string, value: string) => {
        db.settings.set(key, value);
    }
}));

import {
    POLAR_CARRY_MARK,
    carryPolarAccess,
    forgetPolarCarry,
    parseLegacyPolicy,
    unsavedPolarPolicy,
    type LegacyAudience,
    type LegacyPolarPolicy
} from "@/lib/polar/access-carry";
import { polarAccessFor, readPolarPolicy, savePolarPolicy } from "@/lib/polar/access";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GROUP = id(900);
const OTHER_GROUP = id(901);

/** Roles as an install before the carry has them: no Polar anywhere. */
function seedInstall() {
    db.settings.clear();
    db.roles = [
        { id: "r-admin", name: "admin", permissions: JSON.stringify(["*"]) },
        { id: "r-member", name: "member", permissions: JSON.stringify(["chat.use"]) },
        { id: "r-viewer", name: "viewer", permissions: JSON.stringify(["drive.read"]) },
        { id: "r-guest", name: "guest", permissions: "[]" },
        { id: "r-custom", name: "support", permissions: JSON.stringify(["tasks.read"]) }
    ];
    db.groups = [GROUP, OTHER_GROUP];
    db.policies = [];
    db.attachments = [];
    db.overrides = [];
    db.users = [
        { id: id(1), isAdmin: true, roles: ["admin"], groups: [] },
        { id: id(2), isAdmin: false, roles: ["member"], groups: [] },
        { id: id(3), isAdmin: false, roles: ["viewer"], groups: [GROUP] },
        { id: id(4), isAdmin: false, roles: ["support"], groups: [OTHER_GROUP] },
        { id: id(5), isAdmin: false, roles: ["guest"], groups: [] },
        { id: id(6), isAdmin: false, roles: ["guest"], groups: [GROUP] },
        { id: id(7), isAdmin: false, roles: [], groups: [] },
        { id: id(8), isAdmin: false, roles: [], groups: [GROUP] },
        { id: id(9), isAdmin: false, roles: ["member", "guest"], groups: [OTHER_GROUP] }
    ];
}

/** The old decision, as `audienceAdmits` and `admitted` read it before. */
function oldAccess(policy: LegacyPolarPolicy, userId: string): { use: boolean; spend: boolean } {
    const user = db.users.find((row) => row.id === userId)!;
    if (user.isAdmin) return { use: true, spend: true };
    const guest = user.roles.every((name) => name === "guest");
    const admits = (audience: LegacyAudience) => {
        if (audience.who === "admins") return false;
        if (audience.userIds.includes(userId)) return true;
        if (guest && !audience.guests) return false;
        if (audience.who === "everyone") return true;
        return user.groups.some((group) => audience.groupIds.includes(group));
    };
    const use = admits(policy.use);
    return { use, spend: use && admits(policy.spend) };
}

const audience = (patch: Partial<LegacyAudience>): LegacyAudience => ({
    who: "everyone",
    userIds: [],
    groupIds: [],
    guests: false,
    ...patch
});

const SHAPES: [string, LegacyPolarPolicy][] = [
    ["the default: everybody but guests, keys for administrators", unsavedPolarPolicy(false)],
    ["keys shared: everybody but guests spends", unsavedPolarPolicy(true)],
    ["administrators only", { use: audience({ who: "admins" }), spend: audience({ who: "admins" }) }],
    [
        "administrators only, keys for everybody",
        { use: audience({ who: "admins" }), spend: audience({}) }
    ],
    ["everybody with guests", { use: audience({ guests: true }), spend: audience({ guests: true }) }],
    [
        "everybody, a named guest",
        { use: audience({ userIds: [id(5)] }), spend: audience({ who: "admins" }) }
    ],
    [
        "chosen people and a group",
        {
            use: audience({ who: "chosen", userIds: [id(2), id(5)], groupIds: [GROUP] }),
            spend: audience({ who: "chosen", userIds: [id(2)] })
        }
    ],
    [
        "chosen with guests, keys for everybody",
        {
            use: audience({ who: "chosen", userIds: [id(7)], groupIds: [GROUP], guests: true }),
            spend: audience({})
        }
    ],
    [
        "chosen group, keys for everybody with guests",
        {
            use: audience({ who: "chosen", groupIds: [GROUP, OTHER_GROUP], guests: true }),
            spend: audience({ guests: true })
        }
    ],
    [
        "everybody, keys for a chosen group",
        { use: audience({}), spend: audience({ who: "chosen", groupIds: [OTHER_GROUP] }) }
    ]
];

beforeEach(() => {
    seedInstall();
    db.shared = false;
    forgetPolarCarry();
});

describe("carrying Polar's old audiences into roles", () => {
    it.each(SHAPES)("keeps every account where it was: %s", async (_, policy) => {
        db.settings.set("polar.access", JSON.stringify({ ...policy, web: false }));
        const before = db.users.map((user) => oldAccess(policy, user.id));

        await carryPolarAccess();

        const after = await Promise.all(db.users.map((user) => polarAccessFor(user.id)));
        expect(after.map(({ use, spend }) => ({ use, spend }))).toEqual(before);
        // No role ends up holding the keys without Polar itself.
        for (const role of db.roles) {
            const grants = JSON.parse(role.permissions) as string[];
            if (grants.includes("polar.spend")) expect(grants, role.name).toContain("polar.use");
        }
    });

    it("reads the unsaved defaults on a deployment that never saved a policy", async () => {
        db.shared = true;
        await carryPolarAccess();
        const roles = Object.fromEntries(db.roles.map((role) => [role.name, JSON.parse(role.permissions)]));
        expect(roles.member).toEqual(["chat.use", "polar.use", "polar.spend"]);
        expect(roles.support).toEqual(["tasks.read", "polar.use", "polar.spend"]);
        expect(roles.guest).toEqual([]);
        expect(roles.admin).toEqual(["*"]);
        expect(db.overrides).toEqual([]);
    });

    it("gives the guest role Polar when the audience took guests, and a roleless account its own", async () => {
        db.settings.set("polar.access", JSON.stringify(SHAPES[4][1]));
        await carryPolarAccess();
        const guest = db.roles.find((role) => role.name === "guest")!;
        expect(JSON.parse(guest.permissions)).toEqual(["polar.use", "polar.spend"]);
        expect(db.overrides.filter((row) => row.userId === id(7)).map((row) => row.permission).sort()).toEqual([
            "polar.spend",
            "polar.use"
        ]);
    });

    it("writes chosen people as overrides and chosen groups as a group policy", async () => {
        db.settings.set("polar.access", JSON.stringify(SHAPES[6][1]));
        await carryPolarAccess();
        expect(db.roles.find((role) => role.name === "member")!.permissions).toBe(JSON.stringify(["chat.use"]));
        expect(db.overrides).toContainEqual({ userId: id(2), permission: "polar.use", effect: "allow" });
        expect(db.overrides).toContainEqual({ userId: id(5), permission: "polar.use", effect: "allow" });
        expect(db.attachments).toEqual([
            { policyId: db.policies[0].id, principalType: "group", principalId: GROUP }
        ]);
        // The guests of that group were outside the audience, and stay outside.
        expect(db.overrides).toContainEqual({ userId: id(6), permission: "polar.use", effect: "deny" });
        expect(db.overrides).toContainEqual({ userId: id(8), permission: "polar.use", effect: "deny" });
    });

    it("does not deny a guest of a chosen group whom something already let in", async () => {
        db.settings.set("polar.access", JSON.stringify(SHAPES[6][1]));
        db.overrides.push({ userId: id(6), permission: "polar.use", effect: "allow" });
        await carryPolarAccess();
        expect(db.overrides.filter((row) => row.userId === id(6))).toEqual([
            { userId: id(6), permission: "polar.use", effect: "allow" }
        ]);
        expect((await polarAccessFor(id(6))).use).toBe(true);
    });

    it("keeps an override somebody already set", async () => {
        db.overrides.push({ userId: id(2), permission: "polar.use", effect: "deny" });
        await carryPolarAccess();
        expect(db.overrides).toEqual([{ userId: id(2), permission: "polar.use", effect: "deny" }]);
        expect((await polarAccessFor(id(2))).use).toBe(false);
    });

    it("runs once, records it, and leaves the old row as it was", async () => {
        const row = JSON.stringify({ ...SHAPES[6][1], web: false });
        db.settings.set("polar.access", row);
        expect(await carryPolarAccess()).not.toBeNull();
        const snapshot = JSON.stringify([db.roles, db.overrides, db.attachments, db.policies]);
        expect(db.settings.has(POLAR_CARRY_MARK)).toBe(true);
        expect(db.settings.get("polar.access")).toBe(row);

        // A second start, or a second process, changes nothing.
        expect(await carryPolarAccess()).toBeNull();
        db.settings.delete(POLAR_CARRY_MARK);
        await carryPolarAccess();
        expect(JSON.stringify([db.roles, db.overrides, db.attachments, db.policies])).toBe(snapshot);
    });

    it("keeps the old audiences in the row when the options are saved", async () => {
        db.settings.set("polar.access", JSON.stringify({ ...SHAPES[2][1], web: true }));
        await savePolarPolicy({ ...(await readPolarPolicy()), web: false });
        const stored = JSON.parse(db.settings.get("polar.access")!);
        expect(stored.use).toEqual(SHAPES[2][1].use);
        expect(stored.web).toBe(false);
    });

    it("reads a row that no longer parses as the safe default", () => {
        expect(parseLegacyPolicy("not json").spend.who).toBe("admins");
        expect(parseLegacyPolicy(JSON.stringify({ use: { who: "anyone" } })).use.who).toBe("everyone");
    });
});
