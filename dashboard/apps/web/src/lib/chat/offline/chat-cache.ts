"use client";

/**
 * The chat's own use of the local store: the conversation list and the newest
 * messages of each conversation, painted before the network answers.
 *
 * A conversation behind the reader's chat lock is never written here, and one
 * that becomes locked is forgotten: the lock is a promise that nothing of it is
 * readable without the code, on this device included. A disappearing message
 * past its time is dropped on the way out, so a copy never outlives the one on
 * the server.
 */

import { snapshotBuild } from "@/lib/snapshot-cache";
import type { ChatMessageView } from "@/lib/chat/messages";
import { createLocalStore, indexedDbStore, type LocalStoreLimits } from "./local-store";

/** How many of a conversation's newest messages are kept. */
export const CACHED_MESSAGES_PER_CHANNEL = 50;

const DAY_MS = 24 * 3_600_000;

export const CHAT_STORE_LIMITS: LocalStoreLimits = {
    lists: { entries: 1, maxAgeMs: 30 * DAY_MS, buildBound: true },
    messages: { entries: 80, maxAgeMs: 30 * DAY_MS, buildBound: true },
    outbox: { entries: 500, maxAgeMs: 30 * DAY_MS, buildBound: false }
};

export const chatStore = createLocalStore(indexedDbStore("polaris-chat"), CHAT_STORE_LIMITS, snapshotBuild);

/** The newest messages worth keeping, and none that has already expired. */
export function keptMessages(
    messages: readonly ChatMessageView[],
    now: number = Date.now()
): ChatMessageView[] {
    return messages
        .filter((message) => !message.expiresAt || Date.parse(message.expiresAt) > now)
        .slice(-CACHED_MESSAGES_PER_CHANNEL);
}

export async function readCachedMessages(channelId: string): Promise<ChatMessageView[] | null> {
    const kept = await chatStore.read<ChatMessageView[]>("messages", channelId);
    return kept ? keptMessages(kept) : null;
}

export function writeCachedMessages(channelId: string, messages: readonly ChatMessageView[]): void {
    void chatStore.write("messages", channelId, keptMessages(messages));
}

export function forgetCachedMessages(channelId: string): void {
    void chatStore.forget("messages", channelId);
}

/** Forget everything this device kept of anybody's chat. */
export function dropChatStore(): Promise<void> {
    return chatStore.clear();
}
