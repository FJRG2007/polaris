import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { ChatRuleError } from "./access";

/**
 * What a new forum post has to satisfy before it is written: it opens a post
 * in a forum, not an answer inside one, the forum's required tag is there,
 * every tag it names is one of this forum's, and a post in a media channel
 * opens with a picture or video.
 *
 * Kept apart from `forum.ts` so `messages.ts` can ask it without importing the
 * module that reads messages back.
 */
export async function checkForumPost(
    channelId: string,
    kind: string,
    parentId: string | null | undefined,
    post: core.ChatForumPostFields,
    contentTypes: readonly string[] = []
): Promise<void> {
    if (!core.isForumKind(kind)) throw new ChatRuleError({ key: "errors.forum.notAForum" });
    if (parentId) throw new ChatRuleError({ key: "errors.forum.postInThread" });
    if (core.isMediaKind(kind) && !contentTypes.some(core.isPostMedia)) {
        throw new ChatRuleError({ key: "errors.forum.mediaRequired" });
    }
    const tagIds = [...new Set(post.tagIds)];
    const [channel, known] = await Promise.all([
        prisma.chatChannel.findUnique({ where: { id: channelId }, select: { forumRequireTag: true } }),
        tagIds.length
            ? prisma.chatForumTag.count({ where: { channelId, id: { in: tagIds } } })
            : Promise.resolve(0)
    ]);
    if (known !== tagIds.length) throw new ChatRuleError({ key: "errors.forum.unknownTag" });
    if (channel?.forumRequireTag && tagIds.length === 0) {
        throw new ChatRuleError({ key: "errors.forum.tagRequired" });
    }
}
