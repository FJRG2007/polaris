"use server";

/**
 * Everything the Chat screens call.
 *
 * Two gates on every one of them, in this order: `chat.use` says the app exists
 * for this account at all, and the service says whether this particular
 * conversation is theirs. Neither substitutes for the other - holding the
 * permission puts nobody in a room.
 *
 * Failures come back as `{ error }` rather than thrown, because every caller is
 * a form or a button that has somewhere to put the sentence. The one exception
 * is a refusal from the access layer, which is caught here and turned into the
 * same shape so a screen never has to know the difference.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as chat from "@/lib/chat/chat-service";
import * as messages from "@/lib/chat/messages";
import { requirePermission } from "@/lib/session";
import { searchAccounts } from "@/lib/rich-text/mention-service";
import { storeAttachment } from "@/lib/chat/attachments";
import { ChatAccessError, messageable, requirePostable } from "@/lib/chat/access";
import { fetchRemoteMedia, searchTenor, tenorConfigured, type TenorResult } from "@/lib/chat/tenor";
import type { ChatMessageView, ChatPage } from "@/lib/chat/messages";
import type { ChatChannelView, ChatMemberView, ChatSpaceView } from "@/lib/chat/chat-service";

const CHAT_PATH = "/chat";

/** The caller, or a refusal. Every action starts here. */
async function actor(): Promise<{ id: string; name: string }> {
    const user = await requirePermission("chat.use");
    return { id: user.id, name: user.name };
}

/**
 * Run one write and turn a refusal into a sentence.
 *
 * A refusal from the access layer is not an exception in the sense a screen
 * cares about - it is an answer - so it becomes `{ error }` like a failed
 * validation does. Anything else is a real fault and is left to throw.
 */
async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof ChatAccessError) return { error: caught.message };
        throw caught;
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listSpacesAction(): Promise<{ spaces: ChatSpaceView[] }> {
    const me = await actor();
    return { spaces: await chat.listSpaces(me) };
}

export async function listChannelsAction(): Promise<{ channels: ChatChannelView[] }> {
    const me = await actor();
    return { channels: await chat.listChannels(me) };
}

export async function readChannelAction(
    channelId: string,
    before?: string
): Promise<{ page?: ChatPage; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.readChannel(me, channelId, before));
    return result.error ? { error: result.error } : { page: result.value };
}

export async function readSinceAction(
    channelId: string,
    afterId: string | null
): Promise<{ messages?: readonly ChatMessageView[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.readSince(me, channelId, afterId));
    return result.error ? { error: result.error } : { messages: result.value };
}

export async function readThreadAction(
    messageId: string
): Promise<{ messages?: readonly ChatMessageView[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.readThread(me, messageId));
    return result.error ? { error: result.error } : { messages: result.value };
}

/**
 * The people this picker may offer.
 *
 * The instance-wide account search, narrowed to those who actually have the
 * chat. Offering somebody who would then be refused is the worst version of
 * this: the refusal arrives after the group has been assembled and named, and
 * it does not say which of the six is the problem.
 *
 * Asked wider than it answers, so filtering a few out still fills the popup.
 */
export async function searchPeopleAction(
    query: string
): Promise<{ results?: { id: string; name: string }[]; error?: string }> {
    const me = await actor();
    const found = await searchAccounts({ id: me.id, isAdmin: false }, String(query ?? ""), 24);
    const allowed = await messageable(found.map((person) => person.id));
    return {
        results: found
            .filter((person) => allowed.has(person.id))
            .slice(0, 8)
            .map((person) => ({ id: person.id, name: person.name }))
    };
}

export async function listMembersAction(
    channelId: string
): Promise<{ members?: ChatMemberView[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.listChannelMembers(me, channelId));
    return result.error ? { error: result.error } : { members: result.value };
}

// ---------------------------------------------------------------------------
// Talking
// ---------------------------------------------------------------------------

export async function sendAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatSendSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be sent" };

    const result = await guard(() =>
        messages.send(
            me,
            parsed.data,
            [],
            parsed.data.replyToId ? { messageId: parsed.data.replyToId, forwarded: false } : null
        )
    );
    return result.error ? { error: result.error } : { id: result.value };
}

/** Send a message on to another conversation. */
export async function forwardAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatForwardSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be forwarded" };

    const result = await guard(() => messages.forward(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { id: result.value };
}

export async function editAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatEditSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be saved" };
    return guard(() => messages.edit(me, parsed.data));
}

export async function deleteMessageAction(messageId: string): Promise<{ error?: string }> {
    const me = await actor();
    return guard(() => messages.remove(me, messageId));
}

export async function reactAction(input: unknown): Promise<{ on?: boolean; error?: string }> {
    const me = await actor();
    const parsed = core.chatReactSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That is not an emoji" };

    const result = await guard(() => messages.react(me, parsed.data));
    return result.error ? { error: result.error } : { on: result.value };
}

/** Whether the GIF and sticker tabs have anything behind them. */
export async function tenorReadyAction(): Promise<boolean> {
    await actor();
    return tenorConfigured();
}

/** What the GIF or sticker tab shows. */
export async function searchTenorAction(
    query: string,
    kind: "gif" | "sticker"
): Promise<{ results: TenorResult[] }> {
    await actor();
    return { results: await searchTenor(String(query ?? ""), kind === "sticker" ? "sticker" : "gif") };
}

/**
 * Send one of them.
 *
 * The file is pulled down here and stored like any other attachment rather than
 * linked. A message whose GIF is an address at Tenor tells Tenor who read it and
 * when, every time somebody scrolls past - and it stops being a message at all
 * the day they take the file down. The cost is the disk it takes, which is the
 * same disk the same GIF would have taken if somebody had uploaded it.
 */
export async function sendMediaAction(
    channelId: string,
    address: string,
    parentId?: string | null
): Promise<{ id?: string; error?: string }> {
    const me = await actor();

    const access = await guard(() => requirePostable(me, channelId));
    if (access.error) return { error: access.error };

    const media = await fetchRemoteMedia(String(address ?? ""));
    if (!media) return { error: "That could not be fetched" };

    const stored = await storeAttachment(channelId, media);
    const sent = await guard(() =>
        // A body of one space: the schema refuses an empty one, and what this
        // message says is said by the picture under it.
        messages.send(me, { channelId, body: " ", parentId: parentId ?? null }, [stored])
    );
    return sent.error ? { error: sent.error } : { id: sent.value };
}

/** Keep a message, or stop keeping it. Returns whether it is kept now, so an
 *  optimistic star settles without asking again. */
export async function starAction(messageId: string): Promise<{ on?: boolean; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.star(me, messageId));
    return result.error ? { error: result.error } : { on: result.value };
}

/** Everything this reader kept, for the Saved screen. */
export async function starredAction(): Promise<{ messages: readonly ChatMessageView[] }> {
    const me = await actor();
    return { messages: await messages.starred(me) };
}

export async function markReadAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatMarkReadSchema.safeParse(input);
    // Silently ignored rather than reported: catching up is a side effect of
    // scrolling, and there is nowhere on the screen a failure would belong.
    if (!parsed.success) return {};
    return guard(() => messages.markRead(me, parsed.data));
}

export async function typingAction(channelId: string): Promise<void> {
    const me = await actor();
    await guard(() => messages.announceTyping(me, channelId));
}

// ---------------------------------------------------------------------------
// Arranging
// ---------------------------------------------------------------------------

export async function createSpaceAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatSpaceCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That space could not be made" };

    const result = await guard(() => chat.createSpace(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { id: result.value };
}

export async function updateSpaceAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatSpaceUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be saved" };

    const result = await guard(() => chat.updateSpace(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function deleteSpaceAction(spaceId: string): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.deleteSpace(me, spaceId));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function createChannelAction(
    input: unknown
): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatChannelCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That channel could not be made" };

    const result = await guard(() => chat.createChannel(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { id: result.value };
}

export async function updateChannelAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatChannelUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be saved" };

    const result = await guard(() => chat.updateChannel(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function deleteChannelAction(channelId: string): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.deleteChannel(me, channelId));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function openDirectAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatDirectOpenSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Pick somebody first" };

    const result = await guard(() => chat.openDirect(me, parsed.data.userIds));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { id: result.value };
}

export async function addSpaceMembersAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatMembersSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Pick somebody first" };

    const result = await guard(() => chat.addSpaceMembers(me, parsed.data.id, parsed.data.userIds));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function removeSpaceMemberAction(
    spaceId: string,
    userId: string
): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.removeSpaceMember(me, spaceId, userId));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function addChannelMembersAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatMembersSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Pick somebody first" };

    const result = await guard(() =>
        chat.addChannelMembers(me, parsed.data.id, parsed.data.userIds)
    );
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function removeChannelMemberAction(
    channelId: string,
    userId: string
): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.removeChannelMember(me, channelId, userId));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function setMutedAction(
    channelId: string,
    muted: boolean
): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.setMuted(me, channelId, muted));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}
