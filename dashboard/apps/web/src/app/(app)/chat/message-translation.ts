/**
 * The translations of chat messages shown in this tab, by message.
 *
 * A message's menu, live translation and the line under the message all read
 * and write the same entry, so translating a message from its menu and then
 * scrolling past it with live translation on costs one request, and "Show
 * original" on one is not undone by the next time it comes into view. Nothing
 * here is ever stored: the message as sent is the only one there is.
 *
 * Held outside React because the list is a window - a row leaves the screen
 * and comes back as a new component, and its translation should not.
 */

import { useSyncExternalStore } from "react";
import type { TranslationOutcome } from "@/lib/text-translation/queue";

/** The most messages remembered, oldest out first. */
const MAX_ENTRIES = 500;

export type MessageTranslationState =
    | { readonly phase: "working" }
    | { readonly phase: "done"; readonly outcome: TranslationOutcome };

export interface MessageTranslationEntry {
    /** The words translated. An edit changes them, and a translation of what
     *  the message used to say is not one of what it says. */
    readonly body: string;
    readonly to: string;
    readonly state: MessageTranslationState;
    /** The reader pressed "Show original". */
    readonly original: boolean;
    /** Asked from the menu rather than by live translation, which is the one
     *  case "already in your language" is worth saying. */
    readonly asked: boolean;
}

/** How the entry is reached: live translation asks quietly, the menu asks out
 *  loud. */
export type TranslationSource = "menu" | "live";

type Translate = (text: string, to: string) => Promise<TranslationOutcome>;

const entries = new Map<string, MessageTranslationEntry>();
const listeners = new Set<() => void>();

function put(id: string, entry: MessageTranslationEntry): void {
    entries.delete(id);
    entries.set(id, entry);
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
    listeners.forEach((listener) => listener());
}

/** The entry for a message, or null when it has none for these words. */
export function translationOf(id: string, body: string): MessageTranslationEntry | null {
    const entry = entries.get(id);
    return entry && entry.body === body ? entry : null;
}

/**
 * Translate one message into `to`.
 *
 * From the menu it always ends showing the translation - a second press on a
 * message showing its original shows the translation again, and a failure is
 * tried again. Live translation never overrides the reader: a message they put
 * back to its original, or one that already failed, is left as it is.
 */
export function translateMessage(
    id: string,
    body: string,
    text: string,
    to: string,
    translate: Translate,
    source: TranslationSource
): void {
    const known = translationOf(id, body);
    const asked = source === "menu";
    if (known && known.to === to) {
        if (!asked) return;
        const failed = known.state.phase === "done" && known.state.outcome.kind === "failed";
        if (!failed) {
            if (known.original || !known.asked) put(id, { ...known, original: false, asked });
            return;
        }
    }
    put(id, { body, to, state: { phase: "working" }, original: false, asked });
    void translate(text, to)
        .catch((): TranslationOutcome => ({ kind: "failed", message: null }))
        .then((outcome) => {
            const now = entries.get(id);
            // Edited, or asked again in another language, while this was out.
            if (!now || now.body !== body || now.to !== to) return;
            put(id, { ...now, state: { phase: "done", outcome } });
        });
}

/** Switch between the translation and the words as sent. */
export function showOriginal(id: string, original: boolean): void {
    const entry = entries.get(id);
    if (entry && entry.original !== original) put(id, { ...entry, original });
}

/** The translation shown for a message, if any, kept in step with the store. */
export function useMessageTranslation(id: string, body: string): MessageTranslationEntry | null {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => translationOf(id, body),
        () => null
    );
}

/** Whether the translation, rather than the original, is on screen. */
export function showsTranslation(entry: MessageTranslationEntry | null): boolean {
    return (
        entry !== null &&
        !entry.original &&
        entry.state.phase === "done" &&
        entry.state.outcome.kind === "translated"
    );
}

/** For tests: forget every translation. */
export function resetMessageTranslations(): void {
    entries.clear();
    listeners.forEach((listener) => listener());
}
