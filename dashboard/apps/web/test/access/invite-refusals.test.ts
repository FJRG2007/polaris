/**
 * The two invites that must never be created.
 *
 * An address that already owns an account cannot become a second one - claiming
 * the invite would fail at provisioning, days later, in front of the person who
 * followed the link. And a second open invite to the same address is two live
 * tokens for one account nobody can revoke as a pair. Both are refused at
 * creation, where the administrator can still act on the answer.
 *
 * The address check covers alternates as well as the sign-in address: an
 * alternate is one its owner has proved, so inviting it is inviting them twice.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface InviteRow {
    id: string;
    email: string;
    acceptedAt: Date | null;
    expiresAt: Date;
}

let invites: InviteRow[] = [];
/** Addresses that already belong to somebody, sign-in address or alternate. */
let taken: string[] = [];
let roles: { id: string; name: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        invite: {
            findFirst: vi.fn(async ({ where }: { where: { email: string; acceptedAt: null } }) => {
                const now = Date.now();
                return (
                    invites.find(
                        (row) =>
                            row.email === where.email && row.acceptedAt === null && row.expiresAt.getTime() > now
                    ) ?? null
                );
            }),
            create: vi.fn(async ({ data }: { data: { email: string } }) => {
                const row = {
                    id: `invite-${invites.length + 1}`,
                    email: data.email,
                    acceptedAt: null,
                    expiresAt: new Date(Date.now() + 86_400_000)
                };
                invites.push(row);
                return { id: row.id };
            }),
            update: vi.fn(async () => ({}))
        },
        role: {
            findUnique: vi.fn(async ({ where }: { where: { name: string } }) => {
                return roles.find((role) => role.name === where.name) ?? null;
            })
        },
        accessGroup: { findMany: vi.fn(async () => []) }
    }
}));

vi.mock("@polaris/auth", () => ({
    emailOwner: vi.fn(async (email: string) => (taken.includes(email) ? "user-1" : null)),
    seedDefaultRoles: vi.fn(async () => {}),
    assignRole: vi.fn(async () => {}),
    provisionUser: vi.fn(async () => ({ id: "user-9" })),
    updateEnforcedRules: vi.fn(async () => {})
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth-mail", () => ({ sendAuthEmail: vi.fn(async () => ({})) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn(async () => "https://polaris.example") }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/network-rules", () => ({ evaluateNetworkRules: vi.fn(async () => ({ allowed: true })) }));

const { createInvite } = await import("@/lib/invite-service");

/** The plain invite, before anything narrows it. */
const INVITE = {
    email: "ada@example.com",
    role: "member",
    method: "link" as const,
    groupIds: [] as string[],
    allowedCidrs: [] as string[],
    allowedCountries: [] as string[],
    allowedContinents: [] as string[]
};

beforeEach(() => {
    invites = [];
    taken = [];
    roles = [{ id: "role-member", name: "member" }, { id: "role-guest", name: "guest" }];
});

describe("createInvite", () => {
    it("creates one for an address nobody holds", async () => {
        const created = await createInvite("admin-1", INVITE);
        expect(created.error).toBeUndefined();
        expect(created.url).toContain("https://polaris.example/oauth/accept-invite?token=");
    });

    it("refuses an address that already has an account", async () => {
        taken = ["ada@example.com"];
        const created = await createInvite("admin-1", INVITE);
        expect(created.error).toBe(
            "That address already has an account. Change their role from the people list instead."
        );
        expect(invites).toHaveLength(0);
    });

    it("refuses an address held only as somebody's alternate", async () => {
        // emailOwner answers for both, which is the point: the caller cannot tell
        // them apart and must not need to.
        taken = ["ada@example.com"];
        expect((await createInvite("admin-1", { ...INVITE, email: "ADA@Example.com " })).error).toBeTruthy();
    });

    it("refuses a second open invite to the same address", async () => {
        await createInvite("admin-1", INVITE);
        const second = await createInvite("admin-1", INVITE);
        expect(second.error).toBe(
            "There is already an open invite for that address. Revoke it before sending another."
        );
        expect(invites).toHaveLength(1);
    });

    it("allows a fresh invite once the earlier one has expired", async () => {
        await createInvite("admin-1", INVITE);
        invites[0]!.expiresAt = new Date(Date.now() - 1000);
        expect((await createInvite("admin-1", INVITE)).error).toBeUndefined();
        expect(invites).toHaveLength(2);
    });

    it("refuses a role this instance no longer defines, rather than granting nothing", async () => {
        const created = await createInvite("admin-1", { ...INVITE, role: "contractor" });
        expect(created.error).toBe("That role no longer exists.");
        expect(invites).toHaveLength(0);
    });

    it("hands out a role that grants nothing, which is a real thing to invite somebody as", async () => {
        expect((await createInvite("admin-1", { ...INVITE, role: "guest" })).error).toBeUndefined();
    });
});
