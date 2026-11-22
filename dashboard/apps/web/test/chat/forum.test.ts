/**
 * Forum channels: a post is a thread root with a title and tags, the list is
 * sorted, searched and narrowed in the database, and the tags are kept by
 * whoever runs the space.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
    kind: "forum",
    admin: true,
    requireTag: false,
    knownTags: 0,
    tagCount: 0,
    clash: null as { id: string } | null,
    postAuthor: "ada",
    findManyArgs: null as Record<string, unknown> | null,
    rows: [] as { id: string; root: { id: string } }[],
    updated: null as Record<string, unknown> | null,
    transactions: 0
};

function reset(): void {
    Object.assign(state, {
        kind: "forum",
        admin: true,
        requireTag: false,
        knownTags: 0,
        tagCount: 0,
        clash: null,
        postAuthor: "ada",
        findManyArgs: null,
        rows: [],
        updated: null,
        transactions: 0
    });
}

vi.mock("@/lib/chat/access", () => {
    class ChatAccessError extends Error {
        constructor(readonly text: { key: string } = { key: "errors.notInConversation" }) {
            super(text.key);
        }
    }
    class ChatRuleError extends ChatAccessError {}
    return {
        ChatAccessError,
        ChatRuleError,
        requireChannel: async (_actor: unknown, channelId: string) => ({
            channelId,
            spaceId: "space-1",
            kind: state.kind
        }),
        requireSpace: async () => {
            if (!state.admin) throw new ChatAccessError({ key: "errors.spaceAdminOnly" });
            return "admin";
        }
    };
});
vi.mock("@/lib/chat/age-gate", () => ({ requireAgeCleared: async () => {} }));
vi.mock("@/lib/chat/chat-lock", () => ({ requireUnlocked: async () => {} }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => {} }));
vi.mock("@/lib/chat/history-visibility", () => ({
    readableSince: async () => null,
    sinceClause: () => ({})
}));
vi.mock("@/lib/chat/messages", () => ({
    MESSAGE_SELECT: { id: true },
    decorateMessages: async (_actor: unknown, rows: { id: string }[]) =>
        rows.map((row) => ({ ...row, body: "" }))
}));
vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        chatChannel: {
            findUnique: async () => ({ forumRequireTag: state.requireTag }),
            findUniqueOrThrow: async () => ({
                forumRequireTag: state.requireTag,
                forumGuidelines: ""
            }),
            update: async ({ data }: { data: Record<string, unknown> }) => {
                state.updated = data;
            }
        },
        chatForumTag: {
            count: async ({ where }: { where: { id?: unknown } }) =>
                where.id ? state.knownTags : state.tagCount,
            findFirst: async () => state.clash,
            findMany: async () => [],
            findUnique: async () => ({ channelId: "forum-1" }),
            create: async ({ data }: { data: { name: string } }) => ({ id: "tag-new", name: data.name }),
            update: async () => ({}),
            delete: async () => ({})
        },
        chatForumPost: {
            findMany: async (args: Record<string, unknown>) => {
                state.findManyArgs = args;
                return state.rows.map((row) => ({
                    ...row,
                    title: "t",
                    tagIds: [],
                    createdAt: new Date(0),
                    lastActivityAt: new Date(0)
                }));
            },
            findUnique: async () => ({ channelId: "forum-1", root: { authorId: state.postAuthor } }),
            update: async ({ data }: { data: Record<string, unknown> }) => {
                state.updated = data;
            }
        },
        $executeRaw: () => "remove",
        $transaction: async (steps: unknown[]) => {
            state.transactions += 1;
            return steps;
        }
    }
}));

const forum = await import("@/lib/chat/forum");
const { checkForumPost } = await import("@/lib/chat/forum-rules");
const ada = { id: "ada" };
const tag = crypto.randomUUID();
const channelId = crypto.randomUUID();

beforeEach(reset);

describe("a new forum post", () => {
    it("is a create type and a space channel kind", () => {
        expect(core.CHAT_CHANNEL_CREATE_TYPES).toContain("forum");
        const parsed = core.chatChannelCreateSchema.parse({
            spaceId: crypto.randomUUID(),
            name: "help",
            kind: "forum"
        });
        expect(parsed.kind).toBe("forum");
    });

    it("has a media variant that is a forum whose posts open with a picture or video", () => {
        expect(core.CHAT_CHANNEL_CREATE_TYPES).toContain("media");
        expect(core.chatChannelCreateSchema.parse({ spaceId: crypto.randomUUID(), name: "art", kind: "media" }).kind).toBe(
            "media"
        );
        expect(core.isForumKind("media")).toBe(true);
        expect(core.isMediaKind("forum")).toBe(false);
        expect(core.isPostMedia("image/webp")).toBe(true);
        expect(core.isPostMedia("video/mp4")).toBe(true);
        expect(core.isPostMedia("application/pdf")).toBe(false);
    });

    it("needs a title", () => {
        expect(core.chatForumPostFieldsSchema.safeParse({ title: "  " }).success).toBe(false);
        expect(core.chatForumPostFieldsSchema.parse({ title: " Hi " })).toEqual({ title: "Hi", tagIds: [] });
    });

    it("is refused outside a forum and inside a thread", async () => {
        await expect(checkForumPost(channelId, "text", null, { title: "a", tagIds: [] })).rejects.toThrow(
            "errors.forum.notAForum"
        );
        await expect(
            checkForumPost(channelId, "forum", "parent", { title: "a", tagIds: [] })
        ).rejects.toThrow("errors.forum.postInThread");
    });

    it("opens with a picture or video in a media channel", async () => {
        await expect(
            checkForumPost(channelId, "media", null, { title: "a", tagIds: [] }, ["application/pdf"])
        ).rejects.toThrow("errors.forum.mediaRequired");
        await expect(checkForumPost(channelId, "media", null, { title: "a", tagIds: [] })).rejects.toThrow(
            "errors.forum.mediaRequired"
        );
        await expect(
            checkForumPost(channelId, "media", null, { title: "a", tagIds: [] }, ["text/plain", "image/png"])
        ).resolves.toBeUndefined();
    });

    it("refuses a tag from somewhere else", async () => {
        await expect(
            checkForumPost(channelId, "forum", null, { title: "a", tagIds: [tag] })
        ).rejects.toThrow("errors.forum.unknownTag");
    });

    it("needs a tag when the forum requires one", async () => {
        state.requireTag = true;
        await expect(checkForumPost(channelId, "forum", null, { title: "a", tagIds: [] })).rejects.toThrow(
            "errors.forum.tagRequired"
        );
        state.knownTags = 1;
        await expect(
            checkForumPost(channelId, "forum", null, { title: "a", tagIds: [tag] })
        ).resolves.toBeUndefined();
    });
});

describe("the list of posts", () => {
    it("sorts by latest activity and narrows by title and tag in the database", async () => {
        await forum.listPosts(ada, core.chatForumListSchema.parse({ channelId, query: "crash", tagId: tag }));
        expect(state.findManyArgs).toMatchObject({
            where: {
                channelId,
                title: { contains: "crash", mode: "insensitive" },
                tagIds: { has: tag }
            },
            orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
            take: forum.FORUM_PAGE + 1
        });
    });

    it("sorts by creation and pages from a cursor", async () => {
        const after = crypto.randomUUID();
        state.rows = Array.from({ length: forum.FORUM_PAGE + 1 }, (_, at) => ({
            id: `p${at}`,
            root: { id: `m${at}` }
        }));
        const page = await forum.listPosts(
            ada,
            core.chatForumListSchema.parse({ channelId, sort: "created", after })
        );
        expect(state.findManyArgs).toMatchObject({
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            cursor: { id: after },
            skip: 1
        });
        expect(page.posts).toHaveLength(forum.FORUM_PAGE);
        expect(page.after).toBe(`p${forum.FORUM_PAGE - 1}`);
    });

    it("is refused for a channel that is not a forum", async () => {
        state.kind = "text";
        await expect(forum.listPosts(ada, core.chatForumListSchema.parse({ channelId }))).rejects.toThrow(
            "errors.forum.notAForum"
        );
    });
});

describe("tags and settings", () => {
    it("only lets whoever runs the space keep tags", async () => {
        state.admin = false;
        await expect(forum.createTag(ada, { channelId, name: "bug" })).rejects.toThrow(
            "errors.spaceAdminOnly"
        );
        await expect(forum.updateForumSettings(ada, { channelId, requireTag: true })).rejects.toThrow(
            "errors.spaceAdminOnly"
        );
    });

    it("refuses a duplicate name and a forum already full of tags", async () => {
        state.clash = { id: "x" };
        await expect(forum.createTag(ada, { channelId, name: "Bug" })).rejects.toThrow(
            "errors.forum.tagTaken"
        );
        state.clash = null;
        state.tagCount = core.MAX_FORUM_TAGS;
        await expect(forum.createTag(ada, { channelId, name: "new" })).rejects.toThrow(
            "errors.forum.tooManyTags"
        );
    });

    it("removes a deleted tag from posts in the same transaction", async () => {
        await forum.deleteTag(ada, tag);
        expect(state.transactions).toBe(1);
    });

    it("saves guidelines and the required-tag switch", async () => {
        await forum.updateForumSettings(ada, { channelId, guidelines: "Be kind", requireTag: true });
        expect(state.updated).toEqual({ forumGuidelines: "Be kind", forumRequireTag: true });
    });
});

describe("changing a post", () => {
    it("is for its author or whoever runs the forum", async () => {
        state.postAuthor = "grace";
        state.admin = false;
        await expect(forum.updatePost(ada, { postId: crypto.randomUUID(), title: "x" })).rejects.toThrow(
            "errors.forum.notYours"
        );
        state.admin = true;
        await forum.updatePost(ada, { postId: crypto.randomUUID(), title: "x" });
        expect(state.updated).toEqual({ title: "x" });
    });

    it("keeps the required tag on an edit", async () => {
        state.requireTag = true;
        await expect(forum.updatePost(ada, { postId: crypto.randomUUID(), tagIds: [] })).rejects.toThrow(
            "errors.forum.tagRequired"
        );
    });
});
