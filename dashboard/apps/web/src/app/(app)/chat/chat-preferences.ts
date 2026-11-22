"use client";

/**
 * The reader's Chat settings on the client: drawn at once from the copy this
 * browser kept, then checked against the server once per page load and swapped
 * only if it changed. Per account, since one browser can hold several.
 *
 * The settings page writes through `rememberChatPreferences`, so every message
 * list open in this tab follows a change the moment it is made.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
    DEFAULT_CHAT_PREFERENCES,
    readChatPreferences,
    type ChatPreferences
} from "@/lib/chat/preference-schema";

const PREFIX = "polaris.chat.preferences.";

const known = new Map<string, ChatPreferences>();
const checked = new Set<string>();
const listeners = new Set<() => void>();

function same(a: ChatPreferences, b: ChatPreferences): boolean {
    return a.captionPosition === b.captionPosition;
}

function kept(userId: string): ChatPreferences {
    const held = known.get(userId);
    if (held) return held;
    let value = DEFAULT_CHAT_PREFERENCES;
    try {
        const raw = window.localStorage.getItem(PREFIX + userId);
        if (raw) value = readChatPreferences(raw);
    } catch {
        // Storage blocked: the defaults until the server answers.
    }
    known.set(userId, value);
    return value;
}

/** Take a value as this account's settings, here and in this browser's copy. */
export function rememberChatPreferences(userId: string, value: ChatPreferences): void {
    const current = known.get(userId);
    if (current && same(current, value)) return;
    known.set(userId, value);
    try {
        window.localStorage.setItem(PREFIX + userId, JSON.stringify(value));
    } catch {
        // Kept in memory for this page only.
    }
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useChatPreferences(userId: string): ChatPreferences {
    const value = useSyncExternalStore(
        subscribe,
        () => kept(userId),
        () => DEFAULT_CHAT_PREFERENCES
    );
    useEffect(() => {
        if (checked.has(userId)) return;
        checked.add(userId);
        // Loaded when first asked for, so drawing a message never pulls the
        // server action in with it.
        import("./preference-actions")
            .then(({ chatPreferencesAction }) => chatPreferencesAction())
            .then(
                (fresh) => rememberChatPreferences(userId, readChatPreferences(fresh)),
                // The kept copy stands; the next page load asks again.
                () => checked.delete(userId)
            );
    }, [userId]);
    return value;
}
