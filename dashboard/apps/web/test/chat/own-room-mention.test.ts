/**
 * The server read marks the reader's own `@everyone`, `@here` and team mention.
 *
 * `room-mention-highlight.test.tsx` holds the parse and the paint; this holds
 * the wiring between them - `decorateMessages` telling `mentionsReader` who
 * wrote the row - since that is what every screen's copy of a message comes
 * back with.
 */

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 15000 });

vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    maySee: async () => true,
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/access")>("@/lib/chat/access");
    return { ...actual, reachableChannelIds: async () => new Set<string>() };
});
vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => ({
        keepEditHistory: false,
        maxMessageLength: 4000,
        maxPerMinute: 0,
        deleteLeavesTrace: true,
        editWindowMinutes: 0
    })
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/room-mentions", () => ({
    announceRoomMention: async () => undefined,
    refuseRoomMention: async () => undefined
}));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

const ADA = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";

vi.mock("@polaris/db", () => ({
    prisma: {
        userBlock: { findMany: async () => [] },
        chatChannel: { findUnique: async () => ({ kind: "group" }) },
        teamMember: { findMany: async () => [{ teamId: TEAM }] },
        chatMessage: { findMany: async () => [] },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        user: {
            findMany: async () => [
                { id: ADA, name: "Ada" },
                { id: "grace", name: "Grace" }
            ]
        }
    }
}));

const { decorateMessages } = await import("@/lib/chat/messages");

const row = {
    id: "message-1",
    channelId: "channel-1",
    authorId: ADA as string | null,
    kind: "text",
    body: "",
    parentId: null,
    replyToId: null,
    forwarded: false,
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-08-16T09:00:00Z")
};

const marked = async (body: string, authorId: string | null = ADA) => {
    const [view] = await decorateMessages({ id: ADA }, [{ ...row, body, authorId }]);
    return view?.mentionsYou;
};

describe("the reader's own message", () => {
    it("is marked when it reaches everybody", async () => {
        expect(await marked("@everyone deploy at five")).toBe(true);
        expect(await marked("@here anyone around?")).toBe(true);
    });

    it("is marked when it names a team they are on", async () => {
        expect(await marked(`cc [@Ops](polaris:team/${TEAM})`)).toBe(true);
    });

    it("is not marked for naming themselves", async () => {
        expect(await marked(`note to [@Ada](polaris:user/${ADA})`)).toBe(false);
    });

    it("is not marked when it names nobody", async () => {
        expect(await marked("just me")).toBe(false);
    });
});

describe("somebody else's message", () => {
    it("is marked for naming the reader", async () => {
        expect(await marked(`hey [@Ada](polaris:user/${ADA})`, "grace")).toBe(true);
    });

    it("is marked when it reaches everybody", async () => {
        expect(await marked("@everyone look", "grace")).toBe(true);
    });
});
