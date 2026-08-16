/**
 * Whether somebody else's words may be sent into another room.
 *
 * The author decides, and the interesting half is that both halves have to
 * agree: the message says whether the action is offered, and the action says
 * whether it happens. A screen that hides the button while the action still
 * works is not a setting, it is a decoration - which is what makes the refusal
 * worth asserting separately from the flag.
 *
 * What it is honestly worth is stated in the copy on the screen and not
 * pretended at here: anybody who can read a message can retype it. This takes
 * away the one-press way, which is the difference between something travelling
 * because somebody meant it to and something travelling because it was easy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Each test lazily imports "@/lib/chat/messages" so the mocks above are in
// place first; the module graph behind it is large, and the first import in
// the file pays the full transform cost. Under the parallel load of the full
// suite that first import can outrun the default 5s timeout even though
// nothing is actually hanging.
vi.setConfig({ testTimeout: 15000 });

/** Who lets the reader pass their messages on. Everybody, unless a test says
 *  otherwise - which is the default an account that never opened the screen has. */
let refusing: string[] = [];

vi.mock("@/lib/privacy-service", () => ({
    receiptsBetween: async () => null,
    maySee: async (subjectId: string) => !refusing.includes(subjectId),
    allowedBy: async (_viewer: unknown, _field: string, ids: readonly string[]) =>
        new Set(ids.filter((id) => !refusing.includes(id)))
}));

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
vi.mock("@/lib/chat/room-mentions", () => ({ announceRoomMention: async () => undefined }));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

const SENT = new Date("2026-08-16T09:00:00Z");

/** The message being forwarded. Grace wrote it; Ada is reading. */
const original = {
    id: "message-1",
    channelId: "channel-1",
    authorId: "grace" as string | null,
    kind: "text",
    body: "the thing she said",
    parentId: null,
    replyToId: null,
    forwarded: false,
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null as Date | null,
    createdAt: SENT
};

let created: number;

vi.mock("@polaris/db", () => {
    const client = {
        chatChannel: {
            findUnique: async () => ({
                id: "channel-2",
                spaceId: null,
                kind: "dm",
                ownerId: null,
                private: true,
                archived: false,
                space: null
            }),
            update: async () => undefined
        },
        chatChannelMember: {
            findUnique: async () => ({ role: "member" }),
            updateMany: async () => undefined,
            upsert: async () => undefined
        },
        chatMessage: {
            findUnique: async () => original,
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            create: async () => {
                created += 1;
                return { id: "forwarded-1", createdAt: SENT };
            },
            update: async () => original
        },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        user: { findMany: async () => [{ id: "grace", name: "Grace" }] },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const ada = { id: "ada" };

beforeEach(() => {
    refusing = [];
    created = 0;
    original.deletedAt = null;
    original.authorId = "grace";
});

describe("a message from somebody who allows it", () => {
    it("is offered as forwardable", async () => {
        const { decorateMessages } = await import("@/lib/chat/messages");
        const [view] = await decorateMessages(ada, [original]);
        expect(view?.forwardable).toBe(true);
    });

    it("is forwarded", async () => {
        const { forward } = await import("@/lib/chat/messages");
        await forward(ada, { messageId: "message-1", channelId: "channel-2", note: "" });
        expect(created).toBe(1);
    });
});

describe("a message from somebody who does not", () => {
    beforeEach(() => {
        refusing = ["grace"];
    });

    it("is not offered", async () => {
        const { decorateMessages } = await import("@/lib/chat/messages");
        const [view] = await decorateMessages(ada, [original]);
        expect(view?.forwardable).toBe(false);
    });

    it("is refused if it is asked for anyway", async () => {
        // The hidden button is where somebody finds out; this is where it is
        // true. An action anybody can call is the actual interface.
        const { forward } = await import("@/lib/chat/messages");
        await expect(
            forward(ada, { messageId: "message-1", channelId: "channel-2", note: "" })
        ).rejects.toThrow(/passed on/);
        expect(created).toBe(0);
    });
});

describe("a message nobody is left to ask", () => {
    it("is forwardable when its author deleted their account", async () => {
        const { decorateMessages } = await import("@/lib/chat/messages");
        original.authorId = null;
        const [view] = await decorateMessages(ada, [original]);
        expect(view?.forwardable).toBe(true);
    });

    it("is not, once it has been taken back", async () => {
        const { decorateMessages } = await import("@/lib/chat/messages");
        original.deletedAt = SENT;
        const [view] = await decorateMessages(ada, [original]);
        expect(view?.forwardable).toBe(false);
    });
});
