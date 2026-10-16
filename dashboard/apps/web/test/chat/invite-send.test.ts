/**
 * Sending an invitation to one person from the invite dialog.
 *
 * It lands as a message from the inviter in the direct conversation between
 * them, built on the address Polaris hands out. A double click, a retry or two
 * tabs must post one message, the inviter's standing is asked the way the menu
 * asks it, and a burst is cut off by the rate limit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "0193b0f0-0000-7000-8000-0000000000aa";
const GRACE = "0193b0f0-0000-7000-8000-0000000000bb";

let invite: Record<string, unknown> | null = null;
let claims = new Map<string, { id: string; channelId: string | null }>();
let standing: "owner" | "admin" | "member" | null = "member";
let limited = false;
const posted: { channelId: string; body: string; authorId: string }[] = [];
const opened: string[][] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatSpaceInvite: { findUnique: async () => invite },
        chatInviteSend: {
            findUnique: async ({ where }: { where: { inviteId_recipientId: { recipientId: string } } }) =>
                claims.get(where.inviteId_recipientId.recipientId) ?? null,
            create: async ({ data }: { data: { recipientId: string } }) => {
                if (claims.has(data.recipientId)) {
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                const row = { id: `claim-${data.recipientId}`, channelId: null };
                claims.set(data.recipientId, row);
                return { id: row.id };
            },
            update: async ({ data }: { data: { channelId: string } }) => {
                for (const row of claims.values()) row.channelId = data.channelId;
                return {};
            },
            delete: async ({ where }: { where: { id: string } }) => {
                for (const [key, row] of claims) if (row.id === where.id) claims.delete(key);
                return {};
            }
        }
    }
}));

vi.mock("@/lib/chat/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/chat/access")>()),
    spaceAccess: async () => standing,
    searchForConversation: async () => ({ people: [], withheld: 0 })
}));
vi.mock("@/lib/chat/chat-service", () => ({
    openDirect: async (_actor: unknown, ids: string[]) => {
        opened.push(ids);
        return "dm-1";
    }
}));
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string }) => {
        // Slow enough that two clicks overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        posted.push({ ...input, authorId: actor.id });
        return "m1";
    }
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example/" }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: !limited, retryAfterMs: limited ? 20_000 : 0 })
}));
vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({ postSpaceNotice: async () => undefined }));

const { sendInvite } = await import("@/lib/chat/invites");

const ada = { id: "ada" };

beforeEach(() => {
    invite = {
        id: "inv-1",
        code: "AbCdEf1234",
        spaceId: SPACE,
        expiresAt: null,
        maxUses: null,
        uses: 0,
        revokedAt: null,
        space: { visibility: "internal", archived: false }
    };
    claims = new Map();
    standing = "member";
    limited = false;
    posted.length = 0;
    opened.length = 0;
});

describe("sending an invite to a friend", () => {
    it("posts the link from the inviter into the direct conversation with them", async () => {
        const result = await sendInvite(ada, { code: "AbCdEf1234", userId: GRACE });
        expect(result).toEqual({ channelId: "dm-1", already: false });
        expect(opened).toEqual([[GRACE]]);
        expect(posted).toEqual([
            {
                channelId: "dm-1",
                body: "https://polaris.example/chat/i/AbCdEf1234",
                replyToId: null,
                authorId: "ada"
            }
        ]);
    });

    it("posts one message for a double click", async () => {
        const both = await Promise.all([
            sendInvite(ada, { code: "AbCdEf1234", userId: GRACE }),
            sendInvite(ada, { code: "AbCdEf1234", userId: GRACE })
        ]);
        expect(posted).toHaveLength(1);
        expect(both.filter((one) => one.already)).toHaveLength(1);
        // And again later: still the one message.
        expect((await sendInvite(ada, { code: "AbCdEf1234", userId: GRACE })).already).toBe(true);
        expect(posted).toHaveLength(1);
    });

    it("is refused for a plain member of a private space, as the menu hides it", async () => {
        invite = { ...invite!, space: { visibility: "private", archived: false } };
        await expect(sendInvite(ada, { code: "AbCdEf1234", userId: GRACE })).rejects.toThrow();
        expect(posted).toHaveLength(0);
    });

    it("is refused once the link has run out", async () => {
        invite = { ...invite!, maxUses: 1, uses: 1 };
        await expect(sendInvite(ada, { code: "AbCdEf1234", userId: GRACE })).rejects.toThrow();
        expect(posted).toHaveLength(0);
    });

    it("stops at the rate limit, and leaves no claim behind", async () => {
        limited = true;
        await expect(sendInvite(ada, { code: "AbCdEf1234", userId: GRACE })).rejects.toThrow();
        expect(posted).toHaveLength(0);
        expect(claims.size).toBe(0);
    });
});
