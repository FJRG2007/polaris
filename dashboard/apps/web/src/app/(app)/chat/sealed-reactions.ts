"use client";

/**
 * Sealed reactions in the browser (docs/chat-e2ee-mls.md, "Sealed
 * reactions"): on a message of a sealed conversation this person's emoji are
 * sealed here as one set and the counts are made here from the sets this
 * browser opens, so the server never learns who put which emoji on what.
 * Never reacted in the clear instead.
 */

import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { ChatMessageView } from "@/lib/chat/messages";
import { countedFor, reactionKey, toggled, type OpenedReactions } from "./sealed-reaction-tally";

/**
 * The server actions, loaded on first use: the counting here is also drawn by
 * pure helpers (`opened-sealed.ts`) that must not pull the server action module in.
 */
const serverActions = () => import("./actions");

/** Pages of sets read at most for one batch of messages. */
const MAX_PAGES = 50;

interface Opened {
    readonly sets: readonly OpenedReactions[];
    /** This reader's own set as it opened. */
    readonly own: readonly string[];
}

/** What this page has opened, by message id. */
const opened = new Map<string, Opened>();
/** Messages known to take sealed sets, with the reader's reactions put on in the clear before. */
const takes = new Map<string, readonly string[]>();

/** Whether a reaction on this message goes as a sealed set. */
export function takesSealed(messageId: string): boolean {
    return takes.has(messageId);
}

/** Messages a set was sent for from this page: the server dropped the reader's clear rows on them. */
const sent = new Set<string>();

/**
 * Note the sealed-reaction messages of a page, with what the reader had on
 * them in the clear. Not again once a set went from here: a row patched on
 * screen since would read as a clear reaction the server no longer has.
 */
export function noteSealedReactions(messages: readonly ChatMessageView[]): void {
    for (const message of messages)
        if (message.sealedReactions && !sent.has(message.id))
            takes.set(message.id, message.reactions.filter((one) => one.mine).map((one) => one.emoji));
}

/** This reader's emoji on the message as the next set starts from: their set and what they had in the clear. */
function ownOf(messageId: string): string[] {
    return [...new Set([...(opened.get(messageId)?.own ?? []), ...(takes.get(messageId) ?? [])])];
}

/** Whether the reader has this emoji on the message as drawn (sealed or not); what a press takes back. */
export function reactedByMe(message: ChatMessageView | undefined, emoji: string): boolean {
    if (!message) return false;
    const key = reactionKey(emoji);
    return withOpenedReactions(message).reactions.some((one) => one.mine && reactionKey(one.emoji) === key);
}

/** Read and open every set on these messages of one conversation (at most 100). */
export async function loadSealedReactions(channelId: string, messageIds: readonly string[]): Promise<void> {
    if (!messageIds.length) return;
    const found = new Map<string, { sets: OpenedReactions[]; own: string[] }>(messageIds.map((id) => [id, { sets: [], own: [] }]));
    let after: { messageId: string; userId: string } | null = null;
    const actions = await serverActions();
    for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await actions.sealedReactionsAction({ channelId, messageIds, after });
        if (!result.page) throw new Error(result.error ?? "the reactions did not load");
        const emoji = await sealedChat.openReactions(channelId, result.page.rows);
        result.page.rows.forEach((row, at) => {
            const entry = found.get(row.messageId);
            if (!entry) return;
            const set = emoji[at] ?? null;
            entry.sets.push({ emoji: set, mine: row.mine });
            if (row.mine && set) entry.own = set;
        });
        after = result.page.next;
        if (!after) break;
    }
    for (const [id, entry] of found) opened.set(id, entry);
}

/** The message with its opened sets counted in; as it came when none are open here. */
export function withOpenedReactions(message: ChatMessageView): ChatMessageView {
    const entry = message.sealedReactions ? opened.get(message.id) : undefined;
    if (!entry) return message;
    const reactions = countedFor(message.reactions, entry.sets, ownOf(message.id)).sort(
        (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji)
    );
    return { ...message, reactions };
}

/**
 * Put one emoji on this person's sealed set, or take it off, and hand the
 * whole set over sealed again. Answers like the plain reaction does.
 */
export async function sendSealedReaction(channelId: string, messageId: string, emoji: string, on: boolean): Promise<{ on?: boolean; error?: string }> {
    // What they had in the clear before is sealed into the first set; the server drops those rows with it.
    const after = toggled(ownOf(messageId), emoji, on);
    const set = after.length ? await sealedChat.sealReactions(channelId, messageId, after) : null;
    const result = await (await serverActions()).putSealedReactionsAction({ messageId, set });
    if (result.error) return { error: result.error };
    const entry = opened.get(messageId);
    const others = (entry?.sets ?? []).filter((one) => !one.mine);
    opened.set(messageId, { sets: after.length ? [...others, { emoji: after, mine: true }] : others, own: after });
    takes.set(messageId, []);
    sent.add(messageId);
    return { on };
}
