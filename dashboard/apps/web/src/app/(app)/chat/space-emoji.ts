"use client";

/**
 * A space's own emoji, as the open screens hold them.
 *
 * One answer per space for the whole tab, shared by every screen that asks: the
 * conversation, its thread, the settings page. Kept in this tab's session
 * storage too, so a conversation opened again draws its emoji on the first
 * frame and asks for the list behind them - and redraws only if it changed.
 *
 * Asked again when the chat's live stream says the space's list changed, so an
 * emoji added in one tab is in every other tab of everybody in the space a
 * moment later. The frame carries the space and nothing else.
 */

import { useChatStream } from "./use-chat-stream";
import { spaceEmojiAction } from "./emoji-actions";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpaceEmojiList, SpaceEmojiView } from "@/lib/chat/custom-emoji";
import type { PickerCustomEmoji } from "./emoji-picker";
import type { CustomEmojiEntry, CustomEmojiSet } from "@/components/rich-text/custom-emoji";

/** How long an answer is taken as current before a screen asks again. */
const FRESH_MS = 30_000;

const STORE_PREFIX = "polaris.chat.emoji.";

interface Held {
    readonly list: SpaceEmojiList;
    readonly at: number;
}

const held = new Map<string, Held>();
const asking = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
/** Why the last question for a space came back empty-handed: the server's
 *  sentence, or "" when it never answered at all. */
const failed = new Map<string, string>();

function tell(spaceId: string): void {
    for (const listener of listeners.get(spaceId) ?? []) listener();
}

function stored(spaceId: string): Held | null {
    const known = held.get(spaceId);
    if (known) return known;
    try {
        const raw = sessionStorage.getItem(`${STORE_PREFIX}${spaceId}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Held;
        if (!Array.isArray(parsed?.list?.emoji)) return null;
        // Remembered from earlier in this tab: drawn at once, but never taken
        // as fresh - the list behind it is asked for straight away.
        const restored = { list: parsed.list, at: 0 };
        held.set(spaceId, restored);
        return restored;
    } catch {
        return null;
    }
}

function keep(spaceId: string, list: SpaceEmojiList): void {
    const before = held.get(spaceId);
    held.set(spaceId, { list, at: Date.now() });
    try {
        sessionStorage.setItem(`${STORE_PREFIX}${spaceId}`, JSON.stringify({ list, at: Date.now() }));
    } catch {
        // A private window or a full storage: the tab still has it in memory.
    }
    const recovered = failed.delete(spaceId);
    if (recovered || JSON.stringify(before?.list) !== JSON.stringify(list)) tell(spaceId);
}

/** Ask for one space's list, joining a question already on its way. */
function ask(spaceId: string): Promise<void> {
    const already = asking.get(spaceId);
    if (already) return already;
    const question = spaceEmojiAction(spaceId)
        .then((answer) => {
            if (answer.list) keep(spaceId, answer.list);
            else {
                failed.set(spaceId, answer.error ?? "");
                tell(spaceId);
            }
        })
        .catch(() => {
            failed.set(spaceId, "");
            tell(spaceId);
        })
        .finally(() => asking.delete(spaceId));
    asking.set(spaceId, question);
    return question;
}

/** Take a write this tab made into the list before the server is asked again. */
export function patchSpaceEmoji(
    spaceId: string,
    change: (emoji: readonly SpaceEmojiView[]) => readonly SpaceEmojiView[]
): void {
    const known = held.get(spaceId);
    if (!known) return;
    keep(spaceId, { ...known.list, emoji: change(known.list.emoji) });
}

/**
 * The list for one space - null while it is not known yet, and for no space at
 * all - with `refresh` to ask again now.
 *
 * `failed` is set when the last question came back without a list: the
 * server's sentence, or "" when it did not answer. A list held from before
 * stays on screen beside it.
 */
export function useSpaceEmoji(spaceId: string | null): {
    readonly list: SpaceEmojiList | null;
    readonly failed: string | null;
    readonly refresh: () => void;
} {
    const [, redraw] = useState(0);

    useEffect(() => {
        if (!spaceId) return;
        const listener = () => redraw((count) => count + 1);
        const set = listeners.get(spaceId) ?? new Set();
        set.add(listener);
        listeners.set(spaceId, set);
        const known = stored(spaceId);
        if (!known || Date.now() - known.at > FRESH_MS) void ask(spaceId);
        else listener();
        return () => {
            set.delete(listener);
        };
    }, [spaceId]);

    useChatStream((frame) => {
        if (frame.kind === "emoji" && frame.spaceId === spaceId) void ask(frame.spaceId);
    });

    const refresh = useCallback(() => {
        if (spaceId) void ask(spaceId);
    }, [spaceId]);

    return {
        list: spaceId ? (stored(spaceId)?.list ?? null) : null,
        failed: spaceId ? (failed.get(spaceId) ?? null) : null,
        refresh
    };
}

/** Where one emoji's picture is served. */
export function emojiSrc(id: string): string {
    return `/api/chat/emoji/${id}`;
}

/** The list as the renderer and the editor take it. */
export function emojiEntries(list: SpaceEmojiList | null): readonly CustomEmojiEntry[] {
    return (list?.emoji ?? []).map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        src: emojiSrc(emoji.id)
    }));
}

/** Everything a conversation in a space needs to draw and offer its emoji. */
export interface SpaceEmojiScope {
    readonly spaceId: string;
    readonly spaceName: string;
    /** Null until the list has arrived. */
    readonly entries: readonly CustomEmojiEntry[] | null;
    /** The set the message text draws from. */
    readonly set: CustomEmojiSet;
    /** Whether this reader may add them - what the picker's "Add" offers. */
    readonly manages: boolean;
}

/** The scope for a conversation, or null outside a space. */
export function useSpaceEmojiScope(
    spaceId: string | null,
    spaceName: string
): SpaceEmojiScope | null {
    const { list } = useSpaceEmoji(spaceId);
    return useMemo(() => {
        if (!spaceId) return null;
        const entries = list ? emojiEntries(list) : null;
        return {
            spaceId,
            spaceName,
            entries,
            set: { entries: new Map((entries ?? []).map((entry) => [entry.id, entry])), from: spaceName },
            manages: list?.manages ?? false
        };
    }, [spaceId, spaceName, list]);
}

/** Where a space's emoji are managed. */
export function spaceEmojiHref(spaceId: string): string {
    return `/chat/s/${spaceId}/emoji`;
}

/**
 * What a conversation's composer is handed: `:` and the picker on, with the
 * space's own emoji in them inside a space and none in a direct message.
 */
export function useComposerEmoji(scope: SpaceEmojiScope | null): {
    readonly custom: PickerCustomEmoji | null;
} {
    return useMemo(
        () => ({
            custom: scope
                ? {
                      spaceName: scope.spaceName,
                      entries: scope.entries,
                      manageHref: scope.manages ? spaceEmojiHref(scope.spaceId) : null
                  }
                : null
        }),
        [scope]
    );
}
