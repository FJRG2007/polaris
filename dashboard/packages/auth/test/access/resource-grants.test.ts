/**
 * Access to one particular thing.
 *
 * The first test here is the one the whole design rests on. Role grants are
 * compiled as `resources: ["*"]`, so if they were ever fed into the resource gate,
 * every holder of the seeded `member` role - which carries `games.manage` - would
 * reach every other account's server the moment a call site stopped filtering by
 * owner. Ownership and a written grant answer "which one"; a role only ever
 * answers "may this account use the feature at all".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const SERVER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SERVER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const QA_GROUP = "99999999-9999-4999-8999-999999999999";

interface GrantRow {
    id: string;
    principalType: string;
    principalId: string;
    resourceKind: string;
    resourceId: string;
    actions: string;
    effect: string;
    canShare: boolean;
    note: string | null;
    expiresAt: Date | null;
}

const users = new Map<string, { isAdmin: boolean }>();
/** What each account's single role holds, as the row stores it. */
const roles = new Map<string, string[]>();
const groupsOf = new Map<string, string[]>();
let grants: GrantRow[] = [];

function matches(row: GrantRow, principals: { principalType: string; principalId: string }[]): boolean {
    return principals.some(
        (principal) =>
            principal.principalType === row.principalType && principal.principalId === row.principalId
    );
}

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null
        },
        userRole: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                (roles.get(where.userId) ?? []).length === 0
                    ? []
                    : [
                          {
                              roleId: `role-${where.userId}`,
                              role: {
                                  id: `role-${where.userId}`,
                                  name: "member",
                                  permissions: JSON.stringify(roles.get(where.userId))
                              }
                          }
                      ]
        },
        groupMember: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                (groupsOf.get(where.userId) ?? []).map((groupId) => ({ groupId }))
        },
        // Nobody here has a capability switched on or off on their account: what
        // this file pins is roles against written grants, and an override would
        // only be a third answer to a question neither of them is being asked.
        userPermission: { findMany: async () => [] },
        policyAttachment: { findMany: async () => [] },
        policy: { findMany: async () => [] },
        resourceGrant: {
            findMany: async ({ where }: { where: { AND?: [{ OR: never[] }, unknown] } }) => {
                const principals = (where.AND?.[0].OR ?? []) as {
                    principalType: string;
                    principalId: string;
                }[];
                const now = Date.now();
                return grants.filter(
                    (row) =>
                        matches(row, principals) && (row.expiresAt === null || row.expiresAt.getTime() > now)
                );
            }
        }
    }
}));

const { canOn, canAny } = await import("../../src/authz.js");

function grant(overrides: Partial<GrantRow> & { principalId: string; resourceId: string }): GrantRow {
    return {
        id: `grant-${grants.length + 1}`,
        principalType: "user",
        resourceKind: "install",
        actions: JSON.stringify(["games.read", "games.moderate"]),
        effect: "allow",
        canShare: false,
        note: null,
        expiresAt: null,
        ...overrides
    } as GrantRow;
}

beforeEach(() => {
    users.clear();
    roles.clear();
    groupsOf.clear();
    grants = [];
    users.set(ALICE, { isAdmin: false });
    users.set(BOB, { isAdmin: false });
    users.set(ADMIN, { isAdmin: true });
});

describe("a role never decides which thing", () => {
    it("does not let a member reach somebody else's server", async () => {
        // The seeded `member` role, verbatim on the part that matters.
        roles.set(BOB, ["games.read", "games.moderate", "games.manage", "deploy.manage"]);
        expect(
            await canOn(BOB, "games.manage", { kind: "install", id: SERVER_A }, { ownerId: ALICE })
        ).toBe(false);
    });

    it("still lets them reach their own", async () => {
        roles.set(ALICE, ["games.read", "games.moderate", "games.manage"]);
        expect(
            await canOn(ALICE, "games.manage", { kind: "install", id: SERVER_A }, { ownerId: ALICE })
        ).toBe(true);
    });

    it("holds an owner to what their role actually grants", async () => {
        // A viewer who owns a server is still a viewer on it: ownership says which
        // one, the role says whether they may do this at all.
        roles.set(ALICE, ["games.read"]);
        const ref = { kind: "install" as const, id: SERVER_A };
        expect(await canOn(ALICE, "games.read", ref, { ownerId: ALICE })).toBe(true);
        expect(await canOn(ALICE, "games.manage", ref, { ownerId: ALICE })).toBe(false);
    });
});

describe("a grant decides exactly one thing", () => {
    it("reaches the server it names and no other", async () => {
        grants = [grant({ principalId: BOB, resourceId: SERVER_A })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(true);
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_B })).toBe(false);
    });

    it("works for somebody holding no role at all", async () => {
        // The requirement, in one line: a guest account that reaches one server.
        grants = [grant({ principalId: BOB, resourceId: SERVER_A })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(true);
        expect(await canOn(BOB, "games.manage", { kind: "install", id: SERVER_A })).toBe(false);
    });

    it("reaches through a group they are in", async () => {
        groupsOf.set(BOB, [QA_GROUP]);
        grants = [grant({ principalType: "group", principalId: QA_GROUP, resourceId: SERVER_A })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(true);
    });

    it("covers the whole kind when it says so", async () => {
        grants = [grant({ principalId: BOB, resourceId: "*" })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_B })).toBe(true);
    });

    it("stops when it expires", async () => {
        grants = [grant({ principalId: BOB, resourceId: SERVER_A, expiresAt: new Date(Date.now() - 1000) })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(false);
    });

    it("grants nothing when the row cannot be read", async () => {
        grants = [grant({ principalId: BOB, resourceId: SERVER_A, actions: "not json" })];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(false);
    });
});

describe("deny", () => {
    it("beats an allow on the same thing", async () => {
        grants = [
            grant({ principalId: BOB, resourceId: SERVER_A }),
            grant({
                principalId: BOB,
                resourceId: SERVER_A,
                effect: "deny",
                actions: JSON.stringify(["games.moderate"])
            })
        ];
        expect(await canOn(BOB, "games.moderate", { kind: "install", id: SERVER_A })).toBe(false);
    });

    it("takes a server away from its own owner", async () => {
        // Deliberate: it is how a server is suspended without being transferred.
        roles.set(ALICE, ["games.read", "games.moderate", "games.manage"]);
        grants = [
            grant({
                principalId: ALICE,
                resourceId: SERVER_A,
                effect: "deny",
                actions: JSON.stringify(["games.manage"])
            })
        ];
        expect(
            await canOn(ALICE, "games.manage", { kind: "install", id: SERVER_A }, { ownerId: ALICE })
        ).toBe(false);
    });
});

describe("administrators", () => {
    it("pass, grant or no grant", async () => {
        expect(await canOn(ADMIN, "games.manage", { kind: "install", id: SERVER_A })).toBe(true);
    });
});

describe("anywhere at all", () => {
    it("is what lets a grant holder find the app they were given", async () => {
        grants = [grant({ principalId: BOB, resourceId: SERVER_A })];
        // No global grant, so the strict question says no...
        expect(await canOn(BOB, "games.read", { kind: "install", id: SERVER_B })).toBe(false);
        // ...and the one navigation asks says yes, because they reach one of them.
        expect(await canAny(BOB, "games.read")).toBe(true);
    });

    it("says no when they reach nothing", async () => {
        expect(await canAny(BOB, "games.read")).toBe(false);
    });
});
