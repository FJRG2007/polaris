"use server";

/**
 * A forum channel: its list of posts, a post's title and tags, and the tags
 * and guidelines whoever runs it keeps. A new post is sent through the
 * messages route with its title and tags, like any first message with files.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import * as forum from "@/lib/chat/forum";
import { requirePermission } from "@/lib/session";
import { guardChat } from "@/lib/chat/chat-guard";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

async function actor(): Promise<{ id: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id };
}

type ForumError = Extract<NamespaceKey<"chat">, `errors.forum.${string}`>;

async function refused(key: ForumError): Promise<{ error: string }> {
    return { error: (await getTranslations("chat"))(key) };
}

const proofSchema = z.string().min(1).max(4096).nullable();

export async function readForumAction(
    channelId: unknown
): Promise<{ forum?: forum.ChatForumView; error?: string }> {
    const me = await actor();
    const id = z.string().uuid().safeParse(channelId);
    if (!id.success) return refused("errors.forum.notAForum");
    const result = await guardChat(() => forum.readForum(me, id.data));
    return result.error ? { error: result.error } : { forum: result.value };
}

export async function listForumPostsAction(
    input: unknown,
    proof?: unknown
): Promise<{ page?: forum.ChatForumPage; error?: string }> {
    const me = await actor();
    const parsed = core.chatForumListSchema.safeParse(input);
    if (!parsed.success) return refused("errors.forum.notAForum");
    const unlock = proofSchema.safeParse(proof ?? null);
    const result = await guardChat(() =>
        forum.listPosts(me, parsed.data, unlock.success ? unlock.data : null)
    );
    return result.error ? { error: result.error } : { page: result.value };
}

export async function updateForumPostAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatForumPostUpdateSchema.safeParse(input);
    if (!parsed.success) return refused("errors.forum.titleRequired");
    const result = await guardChat(() => forum.updatePost(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

export async function updateForumSettingsAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatForumSettingsSchema.safeParse(input);
    if (!parsed.success) return refused("errors.forum.guidelinesTooLong");
    const result = await guardChat(() => forum.updateForumSettings(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

export async function createForumTagAction(
    input: unknown
): Promise<{ tag?: forum.ChatForumTagView; error?: string }> {
    const me = await actor();
    const parsed = core.chatForumTagCreateSchema.safeParse(input);
    if (!parsed.success) return refused("errors.forum.tagName");
    const result = await guardChat(() => forum.createTag(me, parsed.data));
    return result.error ? { error: result.error } : { tag: result.value };
}

export async function renameForumTagAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatForumTagRenameSchema.safeParse(input);
    if (!parsed.success) return refused("errors.forum.tagName");
    const result = await guardChat(() => forum.renameTag(me, parsed.data));
    return result.error ? { error: result.error } : {};
}

export async function deleteForumTagAction(tagId: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const id = z.string().uuid().safeParse(tagId);
    if (!id.success) return refused("errors.forum.tagGone");
    const result = await guardChat(() => forum.deleteTag(me, id.data));
    return result.error ? { error: result.error } : {};
}
