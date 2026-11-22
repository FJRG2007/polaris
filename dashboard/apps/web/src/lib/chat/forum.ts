import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { prisma, Prisma } from "@polaris/db";
import { requireUnlocked } from "./chat-lock";
import { requireAgeCleared } from "./age-gate";
import * as history from "./history-visibility";
import { decorateMessages, MESSAGE_SELECT, type ChatMessageView } from "./messages";
import { ChatAccessError, ChatRuleError, requireChannel, requireSpace, type ChatActor } from "./access";

/** How many posts one page of a forum's list holds. */
export const FORUM_PAGE = 30;

export interface ChatForumTagView {
    readonly id: string;
    readonly name: string;
}

export interface ChatForumPostView {
    readonly id: string;
    readonly title: string;
    readonly tagIds: readonly string[];
    readonly createdAt: string;
    readonly lastActivityAt: string;
    /** The first message: author, text and files, and what opens the thread. */
    readonly root: ChatMessageView;
}

export interface ChatForumView {
    readonly guidelines: string;
    readonly requireTag: boolean;
    readonly tags: readonly ChatForumTagView[];
    /** Whether the reader runs this forum: tags, guidelines, required tags. */
    readonly mayManage: boolean;
}

export interface ChatForumPage {
    readonly posts: readonly ChatForumPostView[];
    /** The id to read the next page after, or null at the end. */
    readonly after: string | null;
}

/** A forum the reader can open, or a refusal that says why. */
async function requireForum(actor: ChatActor, channelId: string) {
    const access = await requireChannel(actor, channelId);
    if (!core.isForumKind(access.kind)) throw new ChatRuleError({ key: "errors.forum.notAForum" });
    return access;
}

/** A forum the reader runs: whoever administers its space. */
async function requireForumAdmin(actor: ChatActor, channelId: string): Promise<void> {
    const access = await requireForum(actor, channelId);
    if (!access.spaceId) throw new ChatRuleError({ key: "errors.forum.notAForum" });
    await requireSpace(actor, access.spaceId, "admin");
}

async function mayManage(actor: ChatActor, spaceId: string | null): Promise<boolean> {
    if (!spaceId) return false;
    return requireSpace(actor, spaceId, "admin").then(
        () => true,
        () => false
    );
}

function changed(actor: ChatActor, channelId: string): void {
    publishChatChange({ channelId, kind: "posted", actorId: actor.id });
}

/** The forum's own settings and tags, for the top of its list. */
export async function readForum(actor: ChatActor, channelId: string): Promise<ChatForumView> {
    const access = await requireForum(actor, channelId);
    const [channel, tags, manage] = await Promise.all([
        prisma.chatChannel.findUniqueOrThrow({
            where: { id: channelId },
            select: { forumGuidelines: true, forumRequireTag: true }
        }),
        prisma.chatForumTag.findMany({
            where: { channelId },
            orderBy: [{ order: "asc" }, { createdAt: "asc" }],
            select: { id: true, name: true },
            take: core.MAX_FORUM_TAGS
        }),
        mayManage(actor, access.spaceId)
    ]);
    return {
        guidelines: channel.forumGuidelines,
        requireTag: channel.forumRequireTag,
        tags,
        mayManage: manage
    };
}

/**
 * One page of a forum's posts, newest activity or newest post first, searched
 * by title and narrowed to a tag in the database. The roots go through the
 * same decoration and history floor a conversation's messages do, so a post
 * whose first message the reader may not see is not listed.
 */
export async function listPosts(
    actor: ChatActor,
    input: core.ChatForumListInput,
    proof?: string | null
): Promise<ChatForumPage> {
    await requireForum(actor, input.channelId);
    await requireAgeCleared(actor, input.channelId);
    await requireUnlocked(actor, input.channelId, proof);
    const floor = await history.readableSince(actor, input.channelId);

    const where: Prisma.ChatForumPostWhereInput = {
        channelId: input.channelId,
        root: { deletedAt: null, AND: [history.sinceClause(floor, actor.id)] },
        ...(input.query ? { title: { contains: input.query, mode: "insensitive" } } : {}),
        ...(input.tagId ? { tagIds: { has: input.tagId } } : {})
    };
    const field = input.sort === "created" ? "createdAt" : "lastActivityAt";
    const rows = await prisma.chatForumPost.findMany({
        where,
        orderBy: [{ [field]: "desc" }, { id: "desc" }],
        ...(input.after ? { cursor: { id: input.after }, skip: 1 } : {}),
        take: FORUM_PAGE + 1,
        select: {
            id: true,
            title: true,
            tagIds: true,
            createdAt: true,
            lastActivityAt: true,
            root: { select: MESSAGE_SELECT }
        }
    });
    const page = rows.slice(0, FORUM_PAGE);
    const roots = await decorateMessages(
        actor,
        page.map((row) => row.root)
    );
    const byId = new Map(roots.map((root) => [root.id, root]));
    const posts: ChatForumPostView[] = [];
    for (const row of page) {
        const root = byId.get(row.root.id);
        if (!root) continue;
        posts.push({
            id: row.id,
            title: row.title,
            tagIds: row.tagIds,
            createdAt: row.createdAt.toISOString(),
            lastActivityAt: row.lastActivityAt.toISOString(),
            root
        });
    }
    return { posts, after: rows.length > FORUM_PAGE ? (page.at(-1)?.id ?? null) : null };
}

/**
 * A post's title or tags, changed by whoever wrote it or whoever runs the
 * forum. The tags are checked against the forum's own, and the required-tag
 * rule holds on an edit the same as on a new post.
 */
export async function updatePost(actor: ChatActor, input: core.ChatForumPostUpdateInput): Promise<void> {
    const post = await prisma.chatForumPost.findUnique({
        where: { id: input.postId },
        select: { channelId: true, root: { select: { authorId: true } } }
    });
    if (!post) throw new ChatAccessError({ key: "errors.forum.postGone" });
    const access = await requireForum(actor, post.channelId);
    if (post.root.authorId !== actor.id && !(await mayManage(actor, access.spaceId))) {
        throw new ChatAccessError({ key: "errors.forum.notYours" });
    }
    let tagIds: string[] | undefined;
    if (input.tagIds) {
        tagIds = [...new Set(input.tagIds)];
        const [known, channel] = await Promise.all([
            prisma.chatForumTag.count({ where: { channelId: post.channelId, id: { in: tagIds } } }),
            prisma.chatChannel.findUniqueOrThrow({
                where: { id: post.channelId },
                select: { forumRequireTag: true }
            })
        ]);
        if (known !== tagIds.length) throw new ChatRuleError({ key: "errors.forum.unknownTag" });
        if (channel.forumRequireTag && tagIds.length === 0) {
            throw new ChatRuleError({ key: "errors.forum.tagRequired" });
        }
    }
    if (input.title === undefined && tagIds === undefined) return;
    await prisma.chatForumPost.update({
        where: { id: input.postId },
        data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(tagIds !== undefined ? { tagIds } : {})
        }
    });
    changed(actor, post.channelId);
}

/** Guidelines and the required-tag switch, for whoever runs the forum. */
export async function updateForumSettings(
    actor: ChatActor,
    input: core.ChatForumSettingsInput
): Promise<void> {
    await requireForumAdmin(actor, input.channelId);
    if (input.guidelines === undefined && input.requireTag === undefined) return;
    await prisma.chatChannel.update({
        where: { id: input.channelId },
        data: {
            ...(input.guidelines !== undefined ? { forumGuidelines: input.guidelines } : {}),
            ...(input.requireTag !== undefined ? { forumRequireTag: input.requireTag } : {})
        }
    });
    changed(actor, input.channelId);
}

export async function createTag(
    actor: ChatActor,
    input: { readonly channelId: string; readonly name: string }
): Promise<ChatForumTagView> {
    await requireForumAdmin(actor, input.channelId);
    const count = await prisma.chatForumTag.count({ where: { channelId: input.channelId } });
    if (count >= core.MAX_FORUM_TAGS) throw new ChatRuleError({ key: "errors.forum.tooManyTags" });
    const clash = await prisma.chatForumTag.findFirst({
        where: { channelId: input.channelId, name: { equals: input.name, mode: "insensitive" } },
        select: { id: true }
    });
    if (clash) throw new ChatRuleError({ key: "errors.forum.tagTaken" });
    const tag = await prisma.chatForumTag.create({
        data: { channelId: input.channelId, name: input.name, order: count * 1024 + 1024 },
        select: { id: true, name: true }
    });
    changed(actor, input.channelId);
    return tag;
}

async function tagChannel(tagId: string): Promise<string> {
    const tag = await prisma.chatForumTag.findUnique({ where: { id: tagId }, select: { channelId: true } });
    if (!tag) throw new ChatAccessError({ key: "errors.forum.tagGone" });
    return tag.channelId;
}

export async function renameTag(
    actor: ChatActor,
    input: { readonly tagId: string; readonly name: string }
): Promise<void> {
    const channelId = await tagChannel(input.tagId);
    await requireForumAdmin(actor, channelId);
    const clash = await prisma.chatForumTag.findFirst({
        where: { channelId, name: { equals: input.name, mode: "insensitive" }, id: { not: input.tagId } },
        select: { id: true }
    });
    if (clash) throw new ChatRuleError({ key: "errors.forum.tagTaken" });
    await prisma.chatForumTag.update({ where: { id: input.tagId }, data: { name: input.name } });
    changed(actor, channelId);
}

/** A tag goes, and comes off every post that carried it in the same step. */
export async function deleteTag(actor: ChatActor, tagId: string): Promise<void> {
    const channelId = await tagChannel(tagId);
    await requireForumAdmin(actor, channelId);
    await prisma.$transaction([
        prisma.$executeRaw`UPDATE "ChatForumPost" SET "tagIds" = array_remove("tagIds", ${tagId}::uuid) WHERE "channelId" = ${channelId}::uuid AND ${tagId}::uuid = ANY("tagIds")`,
        prisma.chatForumTag.delete({ where: { id: tagId } })
    ]);
    changed(actor, channelId);
}
