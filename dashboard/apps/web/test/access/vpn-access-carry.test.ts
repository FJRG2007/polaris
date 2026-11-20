/**
 * The VPN's open switch and per-person rows carried into roles and overrides
 * (`lib/vpn/access-carry.ts`). Every stored shape is run through the carry
 * against an in-memory install, and every account must have the VPN after
 * exactly when it had it before: the old decision is written out here as it
 * stood, the new one is `vpnGrantOf`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateStatements, type PolicyStatement } from "@polaris/core";

interface Install {
    open: string | null;
    roles: { id: string; name: string; permissions: string }[];
    users: {
        id: string;
        isAdmin: boolean;
        roles: string[];
        groups: string[];
        hasRow: boolean;
    }[];
    overrides: { userId: string; permission: string; effect: string }[];
    policies: {
        id: string;
        document: string;
        attachments: { principalType: string; principalId: string }[];
    }[];
    settings: Map<string, string>;
}

const state = vi.hoisted(() => ({ install: null as unknown as Install }));

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) =>
        key === "vpn.openAccess" ? state.install.open : (state.install.settings.get(key) ?? null)
}));
vi.mock("@polaris/auth", () => ({ seedDefaultRoles: async () => {} }));
vi.mock("@polaris/db", () => {
    const install = () => state.install;
    const userRow = (user: Install["users"][number]) => ({
        id: user.id,
        roles: user.roles.map((id) => ({
            role: { name: install().roles.find((role) => role.id === id)?.name ?? id }
        })),
        permissionOverrides: install()
            .overrides.filter((row) => row.userId === user.id && row.permission === "vpn.use")
            .map((row) => ({ effect: row.effect })),
        vpnAccess: user.hasRow ? { userId: user.id } : null
    });
    return {
        prisma: {
            setting: {
                findUnique: async ({ where }: { where: { key: string } }) =>
                    install().settings.has(where.key) ? { key: where.key } : null,
                upsert: async ({ create }: { create: { key: string; value: string } }) => {
                    if (!install().settings.has(create.key))
                        install().settings.set(create.key, create.value);
                }
            },
            role: {
                findMany: async (args?: { where?: { name: { in: string[] } } }) =>
                    install().roles.filter(
                        (role) => !args?.where || args.where.name.in.includes(role.name)
                    ),
                update: async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: { permissions: string };
                }) => {
                    const role = install().roles.find((row) => row.id === where.id);
                    if (role) role.permissions = data.permissions;
                }
            },
            policy: { findMany: async () => install().policies },
            groupMember: {
                findMany: async ({ where }: { where: { groupId: { in: string[] } } }) =>
                    install().users.flatMap((user) =>
                        user.groups.some((id) => where.groupId.in.includes(id))
                            ? [{ userId: user.id }]
                            : []
                    )
            },
            userRole: {
                findMany: async ({ where }: { where: { roleId: { in: string[] } } }) =>
                    install().users.flatMap((user) =>
                        user.roles.some((id) => where.roleId.in.includes(id))
                            ? [{ userId: user.id }]
                            : []
                    )
            },
            user: {
                findMany: async ({
                    where
                }: {
                    where: { isAdmin: false; roles?: { none: object }; OR?: unknown[] };
                }) => {
                    const users = install().users.filter((user) => !user.isAdmin);
                    if (where.roles)
                        return users.filter((user) => user.roles.length === 0).map(userRow);
                    const ids = ((where.OR?.[1] as { id: { in: string[] } }).id.in ??
                        []) as string[];
                    return users
                        .filter((user) => user.hasRow || ids.includes(user.id))
                        .map(userRow);
                }
            },
            userPermission: {
                createMany: async ({
                    data
                }: {
                    data: { userId: string; permission: string; effect: string }[];
                }) => {
                    for (const row of data) {
                        const taken = install().overrides.some(
                            (entry) =>
                                entry.userId === row.userId && entry.permission === row.permission
                        );
                        if (!taken) install().overrides.push(row);
                    }
                }
            }
        }
    };
});

import { vpnGrantOf } from "@/lib/vpn/wireguard";
import { carryVpnAccess, planVpnCarry, VPN_CARRY_MARK } from "@/lib/vpn/access-carry";

const ROLES = {
    admin: ["*"],
    member: ["drive.read", "vpn.use", "chat.use"],
    viewer: ["drive.read"],
    guest: [],
    everything: ["*"],
    vpnAll: ["vpn.*", "notes.use"]
} as const;

const POLICIES = {
    gAllow: { effect: "allow", actions: ["vpn.use"] },
    gDeny: { effect: "deny", actions: ["vpn.use"] },
    gStar: { effect: "allow", actions: ["*"] },
    gStarDeny: { effect: "deny", actions: ["*"] },
    rAllow: { effect: "allow", actions: ["vpn.*"] }
} as const;

function statementsOf(install: Install, userId: string): PolicyStatement[] {
    const user = install.users.find((row) => row.id === userId)!;
    const fromRoles = user.roles.flatMap((id) =>
        (JSON.parse(install.roles.find((role) => role.id === id)!.permissions) as string[]).map(
            (key): PolicyStatement => ({ effect: "allow", actions: [key], resources: ["*"] })
        )
    );
    const fromPolicies = install.policies
        .filter((policy) =>
            policy.attachments.some(
                (entry) =>
                    (entry.principalType === "user" && entry.principalId === userId) ||
                    (entry.principalType === "group" && user.groups.includes(entry.principalId)) ||
                    (entry.principalType === "role" && user.roles.includes(entry.principalId))
            )
        )
        .flatMap(
            (policy) =>
                (JSON.parse(policy.document) as { statements: PolicyStatement[] }).statements
        );
    const fromOverrides = install.overrides
        .filter((row) => row.userId === userId)
        .map((row): PolicyStatement => ({
            effect: row.effect === "deny" ? "deny" : "allow",
            actions: [row.permission],
            resources: ["*"]
        }));
    return [...fromRoles, ...fromPolicies, ...fromOverrides];
}

/** The decision as it stood before this release (`wg.vpnStanding` then). */
function hadVpn(install: Install, userId: string): boolean {
    const user = install.users.find((row) => row.id === userId)!;
    if (user.isAdmin) return true;
    const permission = evaluateStatements(statementsOf(install, userId), "vpn.use", "*");
    if (permission === "deny") return false;
    const accountAllows = install.overrides.some(
        (row) => row.userId === userId && row.permission === "vpn.use" && row.effect === "allow"
    );
    return user.hasRow || accountAllows || install.open === "true";
}

/** The decision now. */
function hasVpn(install: Install, userId: string): boolean {
    const user = install.users.find((row) => row.id === userId)!;
    return user.isAdmin || vpnGrantOf(statementsOf(install, userId)) === "allow";
}

const ROLE_SETS = [
    [],
    ["member"],
    ["viewer"],
    ["guest"],
    ["everything"],
    ["vpnAll"],
    ["member", "viewer"]
];
const GROUP_SETS = [[], ["gAllow"], ["gDeny"], ["gStar"], ["gStarDeny"]];
const OVERRIDES = [null, "allow", "deny"] as const;

/** Every combination of roles, groups, override and row, on one install. */
function installOf(open: string | null, roleAttached: boolean): Install {
    const users: Install["users"] = [];
    const overrides: Install["overrides"] = [];
    let n = 0;
    for (const roles of ROLE_SETS)
        for (const groups of GROUP_SETS)
            for (const override of OVERRIDES)
                for (const hasRow of [false, true]) {
                    const id = `u${n++}`;
                    users.push({
                        id,
                        isAdmin: false,
                        roles: [...roles],
                        groups: [...groups],
                        hasRow
                    });
                    if (override)
                        overrides.push({ userId: id, permission: "vpn.use", effect: override });
                }
    users.push({ id: "root", isAdmin: true, roles: ["admin"], groups: [], hasRow: false });
    users.push({ id: "root-row", isAdmin: true, roles: [], groups: [], hasRow: true });
    const policy = (
        id: keyof typeof POLICIES,
        attachments: Install["policies"][number]["attachments"]
    ) => ({
        id,
        document: JSON.stringify({ statements: [{ ...POLICIES[id], resources: ["*"] }] }),
        attachments
    });
    return {
        open,
        roles: Object.entries(ROLES).map(([name, grants]) => ({
            id: name,
            name,
            permissions: JSON.stringify(grants)
        })),
        users,
        overrides,
        policies: [
            policy("gAllow", [{ principalType: "group", principalId: "gAllow" }]),
            policy("gDeny", [{ principalType: "group", principalId: "gDeny" }]),
            policy("gStar", [{ principalType: "group", principalId: "gStar" }]),
            policy("gStarDeny", [{ principalType: "group", principalId: "gStarDeny" }]),
            policy(
                "rAllow",
                roleAttached
                    ? [
                          { principalType: "role", principalId: "viewer" },
                          { principalType: "user", principalId: "u0" }
                      ]
                    : []
            )
        ],
        settings: new Map()
    };
}

const SHAPES = [
    { name: "open to everyone", open: "true" },
    { name: "closed", open: "false" },
    { name: "never set (closed)", open: null },
    { name: "an unreadable value (closed)", open: "yes" }
];

beforeEach(() => {
    state.install = installOf(null, false);
});

describe("carrying the VPN's own access into roles and overrides", () => {
    for (const shape of SHAPES)
        for (const roleAttached of [false, true])
            it(`keeps every account's VPN: ${shape.name}${roleAttached ? ", policy on a role and a user" : ""}`, async () => {
                state.install = installOf(shape.open, roleAttached);
                const before = new Map(
                    state.install.users.map((user) => [user.id, hadVpn(state.install, user.id)])
                );
                const overridesBefore = state.install.overrides.map((row) => ({ ...row }));
                await carryVpnAccess();
                for (const user of state.install.users)
                    expect([user.id, hasVpn(state.install, user.id)]).toEqual([
                        user.id,
                        before.get(user.id)
                    ]);
                // An override somebody set is never changed.
                for (const row of overridesBefore)
                    expect(state.install.overrides).toContainEqual(row);
            });

    it("gives every role the VPN when it was open, guest included", async () => {
        state.install = installOf("true", false);
        await carryVpnAccess();
        for (const role of state.install.roles) {
            const grants = JSON.parse(role.permissions) as string[];
            expect(grants.some((grant) => grant === "vpn.use" || grant === "vpn.*")).toBe(true);
        }
    });

    it("takes the VPN off every role when it was closed, and records what it took", async () => {
        state.install = installOf(null, false);
        await carryVpnAccess();
        for (const role of state.install.roles)
            expect(JSON.parse(role.permissions)).not.toContain("vpn.use");
        const mark = JSON.parse(state.install.settings.get(VPN_CARRY_MARK)!);
        expect(mark.open).toBe(false);
        expect(mark.stripped).toEqual(
            expect.arrayContaining([
                { name: "member", removed: ["vpn.use"] },
                { name: "vpnAll", removed: ["vpn.*"] }
            ])
        );
        // The rest of a role's grants stay.
        const member = state.install.roles.find((role) => role.name === "member")!;
        expect(JSON.parse(member.permissions)).toEqual(["drive.read", "chat.use"]);
    });

    it("runs once, and a second run changes nothing", async () => {
        state.install = installOf("true", true);
        expect(await carryVpnAccess()).not.toBeNull();
        const roles = JSON.stringify(state.install.roles);
        const overrides = JSON.stringify(state.install.overrides);
        expect(await carryVpnAccess()).toBeNull();
        state.install.settings.delete(VPN_CARRY_MARK);
        await carryVpnAccess();
        expect(JSON.stringify(state.install.roles)).toBe(roles);
        expect(JSON.stringify(state.install.overrides)).toBe(overrides);
    });

    it("leaves the old switch and every limits row where they were", async () => {
        state.install = installOf("true", false);
        const rows = state.install.users.filter((user) => user.hasRow).length;
        await carryVpnAccess();
        expect(state.install.open).toBe("true");
        expect(state.install.users.filter((user) => user.hasRow).length).toBe(rows);
    });
});

describe("the plan", () => {
    const person = {
        userId: "p",
        roles: [] as string[],
        hasRow: false,
        override: null as "allow" | "deny" | null,
        reachedByPolicy: false
    };

    it("allows a roleless account when open, and nobody with an override", () => {
        expect(planVpnCarry(true, [], [person]).users).toEqual([{ userId: "p", effect: "allow" }]);
        expect(planVpnCarry(true, [], [{ ...person, override: "deny" }]).users).toEqual([]);
    });

    it("allows a row when closed, and denies somebody a VPN policy reached without one", () => {
        expect(
            planVpnCarry(false, [], [{ ...person, roles: ["member"], hasRow: true }]).users
        ).toEqual([{ userId: "p", effect: "allow" }]);
        expect(planVpnCarry(false, [], [{ ...person, reachedByPolicy: true }]).users).toEqual([
            { userId: "p", effect: "deny" }
        ]);
    });
});
