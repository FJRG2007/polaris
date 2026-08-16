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

import { z } from "zod";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as invites from "@/lib/chat/invites";
import * as saved from "@/lib/chat/saved-media";
import * as chat from "@/lib/chat/chat-service";
import * as reports from "@/lib/chat/reports";
import * as messages from "@/lib/chat/messages";
import { allChatRules } from "@/lib/chat/rules";
import { requirePermission } from "@/lib/session";
import { storeAttachment } from "@/lib/chat/attachments";
import type { SavedMediaView } from "@/lib/chat/saved-media";
import type { LinkPreviewView } from "@/lib/chat/link-preview";
import { messageToasts, type MessageToast } from "@/lib/chat/toasts";
import { searchMessages, type ChatSearchHit } from "@/lib/chat/search";
import { voicePresence, type VoicePresence } from "@/lib/chat/meetings";
import type { ChatInviteOffer, ChatInviteView } from "@/lib/chat/invites";
import type { ChatMessageView, ChatNewerPage, ChatPage } from "@/lib/chat/messages";
import { fetchRemoteMedia, searchTenor, tenorConfigured, type TenorResult } from "@/lib/chat/tenor";
import type {
    ChatCategoryView,
    ChatChannelView,
    ChatMemberView,
    ChatSpaceView
} from "@/lib/chat/chat-service";
import {
    ChatAccessError,
    reachableChannelIds,
    requirePostable,
    searchForConversation
} from "@/lib/chat/access";

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

export async function listCategoriesAction(): Promise<{ categories: ChatCategoryView[] }> {
    const me = await actor();
    return { categories: await chat.listCategories(me) };
}

/**
 * Who is in each voice room, for the rail.
 *
 * Asked for the channels the rail is already showing, and answered only for the
 * ones this reader can reach - the ids arrive from a browser, so they are
 * intersected with what the reader can see rather than trusted.
 */
export async function voicePresenceAction(
    channelIds: string[]
): Promise<{ inRoom: Record<string, VoicePresence[]> }> {
    const me = await actor();
    const reachable = await reachableChannelIds(me);
    const asked = (Array.isArray(channelIds) ? channelIds : []).filter((id) => reachable.has(id));
    const found = await voicePresence(asked);
    return { inRoom: Object.fromEntries(found) };
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
): Promise<{ page?: ChatNewerPage; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.readSince(me, channelId, afterId));
    return result.error ? { error: result.error } : { page: result.value };
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
): Promise<{ results?: { id: string; name: string }[]; withheld?: number; error?: string }> {
    const me = await actor();
    const found = await searchForConversation(me, String(query ?? ""));
    // The count of who was left out travels with the results: "no results" for
    // somebody whose name has just been typed reads as a broken search rather
    // than as an account that cannot receive a message. A number and nothing
    // else - naming them would say more than the search was asked.
    return { results: found.people, withheld: found.withheld };
}

/**
 * Look for something somebody said.
 *
 * The filters narrow; what they narrow is the set of conversations this reader
 * can reach, which the service resolves for itself. A malformed filter comes
 * back as no results rather than an error: a search box that refuses to search
 * is worse than one that finds nothing.
 */
export async function searchMessagesAction(
    input: unknown
): Promise<{ hits: readonly ChatSearchHit[] }> {
    const me = await actor();
    const parsed = core.chatSearchSchema.safeParse(input);
    if (!parsed.success) return { hits: [] };
    return { hits: await searchMessages(me, parsed.data) };
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

/** What a message said before it was edited, for the panel behind "(edited)". */
export async function editHistoryAction(
    messageId: string
): Promise<{ history?: messages.ChatEditHistory; error?: string }> {
    const me = await actor();
    const result = await guard(() => messages.editHistory(me, messageId));
    return result.error ? { error: result.error } : { history: result.value };
}

/**
 * The instance's rules, all three scopes at once.
 *
 * Read by the composer so a limit is met while typing rather than after
 * uploading: a 40 MB video refused by the server was still a 40 MB upload, and
 * the person who sent it waited for it. Three small objects, fetched once when
 * the app opens.
 */
export async function chatRulesAction(): Promise<{
    rules: Record<core.ChatRuleScope, core.ChatRules>;
}> {
    await actor();
    return { rules: await allChatRules() };
}

export async function reactAction(input: unknown): Promise<{ on?: boolean; error?: string }> {
    const me = await actor();
    const parsed = core.chatReactSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That is not an emoji" };

    const result = await guard(() => messages.react(me, parsed.data));
    return result.error ? { error: result.error } : { on: result.value };
}

/**
 * What the link in one message is, looked up now if nobody has yet.
 *
 * The list asks for this the moment it draws a message whose link has never been
 * looked at, which is what makes a card appear under a link that was just sent.
 * A failure is null rather than a sentence: a card that says a page could not be
 * described is worse than no card.
 */
export async function linkPreviewAction(
    messageId: string
): Promise<{ preview: LinkPreviewView | null }> {
    const me = await actor();
    const result = await guard(() => messages.linkPreviewFor(me, messageId));
    return { preview: result.value ?? null };
}

/**
 * What just arrived in these conversations, for the note that appears in the
 * corner.
 *
 * Deliberately not written anywhere: a message is not a notification. The bell
 * is a list somebody comes back to and clears, and fifty messages an afternoon
 * would bury the four things in it that mattered.
 */
export async function messageToastsAction(
    channelIds: string[]
): Promise<{ toasts: MessageToast[] }> {
    const me = await actor();
    const asked = Array.isArray(channelIds) ? channelIds.map(String) : [];
    return { toasts: await messageToasts(me, asked) };
}

/** Whether the GIF and sticker tabs have anything behind them. */
export async function tenorReadyAction(): Promise<boolean> {
    await actor();
    return await tenorConfigured();
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

/**
 * Report a message.
 *
 * No permission of its own: being able to see something is being able to say
 * something is wrong with it, and a report that had to be unlocked is a report
 * nobody makes. The service proves the conversation, which is the same check
 * that let them read it.
 */
export async function reportMessageAction(input: unknown): Promise<{ already?: boolean; error?: string }> {
    const me = await actor();
    const parsed = core.chatReportSchema.safeParse(input);
    if (!parsed.success) return { error: "Say what is wrong with it" };
    const result = await guard(() => reports.reportMessage(me, parsed.data));
    return result.error ? { error: result.error } : { already: result.value?.already };
}

export async function typingAction(channelId: string, activity?: unknown): Promise<void> {
    const me = await actor();
    // Checked rather than taken: it is a string from a browser that decides what
    // a room full of people is told somebody is doing.
    const doing = core.chatActivitySchema.parse(activity ?? undefined);
    await guard(() => messages.announceTyping(me, channelId, doing));
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

export async function createCategoryAction(input: unknown): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const parsed = core.chatCategoryCreateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That category could not be made" };

    const result = await guard(() => chat.createCategory(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { id: result.value };
}

export async function renameCategoryAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatCategoryUpdateSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be saved" };

    const result = await guard(() => chat.renameCategory(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

export async function deleteCategoryAction(categoryId: string): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.deleteCategory(me, categoryId));
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

/** Name a group, or take the name off again. Anybody in it may. */
export async function renameGroupAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatGroupNameSchema.safeParse(input);
    if (!parsed.success)
        return { error: parsed.error.issues[0]?.message ?? "That could not be saved" };

    const result = await guard(() => chat.renameGroup(me, parsed.data.channelId, parsed.data.name));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

/** Walk out of a group. Nobody needs to be told which member they are. */
export async function leaveChannelAction(channelId: string): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.removeChannelMember(me, channelId, me.id));
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

/** @param minutes - How long, `MUTE_FOREVER` for no end, or null to unmute. */
export async function setMutedAction(
    channelId: string,
    minutes: number | null
): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.setMuted(me, channelId, minutes));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

/** Keep a conversation at the top of your own list, or stop. Yours alone: the
 *  other people in it are told nothing and their rail does not move. */
export async function setPinnedAction(
    channelId: string,
    pinned: boolean
): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => chat.setPinned(me, channelId, pinned));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result;
}

/**
 * Put the channels under one heading in the order they were dragged into.
 *
 * The whole list rather than one move, so the stored order is the order that was
 * on screen. Nothing is revalidated: the rail is client state and asks again
 * when it is told the channels moved.
 */
export async function reorderChannelsAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatChannelReorderSchema.safeParse(input);
    if (!parsed.success) return { error: "Those channels could not be reordered" };
    return guard(() => chat.reorderChannels(me, parsed.data));
}

export async function reorderCategoriesAction(input: unknown): Promise<{ error?: string }> {
    const me = await actor();
    const parsed = core.chatCategoryReorderSchema.safeParse(input);
    if (!parsed.success) return { error: "Those categories could not be reordered" };
    return guard(() => chat.reorderCategories(me, parsed.data));
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export async function createInviteAction(
    input: unknown
): Promise<{ invite?: ChatInviteView; error?: string }> {
    const me = await actor();
    const parsed = core.chatInviteCreateSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "That invitation could not be made" };
    }
    const result = await guard(() => invites.createInvite(me, parsed.data));
    return result.error ? { error: result.error } : { invite: result.value };
}

export async function listInvitesAction(
    spaceId: string
): Promise<{ invites?: readonly ChatInviteView[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => invites.listInvites(me, String(spaceId)));
    return result.error ? { error: result.error } : { invites: result.value };
}

export async function revokeInviteAction(inviteId: string): Promise<{ error?: string }> {
    const me = await actor();
    return guard(() => invites.revokeInvite(me, String(inviteId)));
}

/** What a link says it leads to, for the screen that asks somebody to accept. */
export async function readInviteAction(
    code: string
): Promise<{ offer?: ChatInviteOffer | null; error?: string }> {
    const me = await actor();
    const parsed = core.inviteCodeSchema.safeParse(code);
    if (!parsed.success) return { offer: null };
    const result = await guard(() => invites.readInvite(me, parsed.data));
    return result.error ? { error: result.error } : { offer: result.value };
}

export async function acceptInviteAction(
    code: string
): Promise<{ spaceId?: string; error?: string }> {
    const me = await actor();
    const parsed = core.inviteCodeSchema.safeParse(code);
    if (!parsed.success) return { error: "That is not an invitation" };
    const result = await guard(() => invites.acceptInvite(me, parsed.data));
    if (!result.error) revalidatePath(CHAT_PATH);
    return result.error ? { error: result.error } : { spaceId: result.value!.spaceId };
}

/**
 * Send an invitation straight to somebody, as a message.
 *
 * The link is posted into the direct conversation with them, which is the same
 * conversation they would have had anyway - not a notification of its own, and
 * not a request they have to accept before they can read it. Every check that
 * makes a direct message possible still applies, so this can never open a
 * conversation with somebody who does not accept them.
 */
export async function inviteToDirectAction(input: {
    code: string;
    userId: string;
    baseUrl: string;
}): Promise<{ channelId?: string; error?: string }> {
    const me = await actor();
    const code = core.inviteCodeSchema.safeParse(input?.code);
    const userId = z.string().uuid().safeParse(input?.userId);
    if (!code.success || !userId.success) return { error: "That invitation could not be sent" };

    const result = await guard(async () => {
        const offer = await invites.readInvite(me, code.data);
        if (!offer) throw new ChatAccessError("That invitation is gone");
        const channelId = await chat.openDirect(me, [userId.data]);
        // Built on the address Polaris hands out rather than on the sender's
        // tab, which may be a name that resolves on their network alone.
        const base = String(input?.baseUrl ?? "").replace(/\/+$/, "");
        await messages.send(
            me,
            {
                channelId,
                body: `[Join ${offer.spaceName}](${base}/chat/i/${offer.code})`,
                replyToId: null
            },
            [],
            null
        );
        return channelId;
    });
    return result.error ? { error: result.error } : { channelId: result.value };
}

// ---------------------------------------------------------------------------
// Pictures somebody kept
// ---------------------------------------------------------------------------

/** Keep a picture, so it turns up in the picker rather than having to be found
 *  again by scrolling. `source` is `attachment:<id>` or an http address. */
export async function saveMediaAction(
    source: string,
    name?: string
): Promise<{ saved?: SavedMediaView; error?: string }> {
    const me = await actor();
    const result = await guard(() => saved.saveMedia(me, String(source ?? ""), String(name ?? "")));
    return result.error ? { error: result.error } : { saved: result.value };
}

export async function unsaveMediaAction(source: string): Promise<{ error?: string }> {
    const me = await actor();
    return guard(() => saved.unsaveMedia(me, String(source ?? "")));
}

export async function listSavedMediaAction(): Promise<{ saved: readonly SavedMediaView[] }> {
    const me = await actor();
    return { saved: await saved.listSavedMedia(me) };
}

/** Which of these the reader has kept, so the star on each picture is drawn
 *  right without one request per picture. */
export async function savedSourcesAction(sources: string[]): Promise<{ sources: string[] }> {
    const me = await actor();
    const asked = Array.isArray(sources) ? sources.map(String) : [];
    return { sources: [...(await saved.savedSources(me, asked))] };
}

/**
 * Send a kept picture.
 *
 * A stored one is copied into the conversation; a remote one goes back through
 * the ordinary fetch, so its address is checked at the moment it is used rather
 * than trusted because it was once in a message.
 */
export async function sendSavedMediaAction(
    channelId: string,
    savedId: string
): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const result = await guard(() =>
        saved.sendSavedMedia(me, String(channelId), String(savedId))
    );
    if (result.error || !result.value) return { error: result.error ?? "That could not be sent" };
    if ("messageId" in result.value) return { id: result.value.messageId };
    return sendMediaAction(channelId, result.value.remote);
}
