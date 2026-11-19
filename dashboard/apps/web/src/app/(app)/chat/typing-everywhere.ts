"use client";

/**
 * Who is typing in every conversation the list shows, the way WhatsApp and
 * Discord put "typing..." in place of the last message.
 *
 * One listener on the shared chat stream for the whole list, not one per row:
 * a list of three hundred conversations is three hundred rows, and each of them
 * parsing every frame is the cost of the feature paid three hundred times. The
 * rows read it through `useTypingIn`, which re-renders only the row whose
 * conversation changed.
 *
 * The stream only carries typing the reader may see (its privacy rules are
 * applied on the server, per typist), so nothing here decides who is shown.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useChatStream } from "./use-chat-stream";

/** How long one frame keeps somebody typing: the composer repeats it every few
 *  seconds while they write, and there is no frame for stopping. */
export const TYPING_TTL_MS = 4000;

export interface ListTypist {
    readonly userId: string;
    readonly name: string;
    readonly activity: "typing" | "recording";
    readonly at: number;
}

const NOBODY: readonly ListTypist[] = [];

/** Pure: who is still typing at `now`, newest frame per person. */
export function typistsAt(entries: readonly ListTypist[], now: number): readonly ListTypist[] {
    const live = entries.filter((entry) => now - entry.at < TYPING_TTL_MS);
    return live.length === entries.length ? entries : live.length === 0 ? NOBODY : live;
}

const byChannel = new Map<string, readonly ListTypist[]>();
const listeners = new Map<string, Set<() => void>>();
let sweep: ReturnType<typeof setInterval> | null = null;

function changed(channelId: string): void {
    for (const listener of listeners.get(channelId) ?? []) listener();
}

function expire(): void {
    const now = Date.now();
    for (const [channelId, entries] of byChannel) {
        const live = typistsAt(entries, now);
        if (live === entries) continue;
        if (live.length === 0) byChannel.delete(channelId);
        else byChannel.set(channelId, live);
        changed(channelId);
    }
    if (byChannel.size === 0 && sweep) {
        clearInterval(sweep);
        sweep = null;
    }
}

/** Record one frame. Exported for the tests. */
export function noteTyping(channelId: string, typist: ListTypist): void {
    const current = byChannel.get(channelId) ?? NOBODY;
    byChannel.set(channelId, [...current.filter((entry) => entry.userId !== typist.userId), typist]);
    changed(channelId);
    sweep ??= setInterval(expire, 1000);
}

/** Forget everything, for the tests. */
export function resetTyping(): void {
    byChannel.clear();
    if (sweep) clearInterval(sweep);
    sweep = null;
}

/** Who is typing in one conversation, the viewer left out. */
export function useTypingIn(channelId: string, viewerId: string): readonly ListTypist[] {
    const entries = useSyncExternalStore(
        (listener) => {
            const set = listeners.get(channelId) ?? new Set();
            set.add(listener);
            listeners.set(channelId, set);
            return () => {
                set.delete(listener);
                if (set.size === 0) listeners.delete(channelId);
            };
        },
        () => byChannel.get(channelId) ?? NOBODY,
        () => NOBODY
    );
    return entries.some((entry) => entry.userId === viewerId)
        ? entries.filter((entry) => entry.userId !== viewerId)
        : entries;
}

/** Mounted once by the list: feeds the store from the shared stream. */
export function TypingWatch(): null {
    useChatStream((frame) => {
        if (frame.kind !== "typing") return;
        noteTyping(frame.channelId, {
            userId: frame.userId,
            name: frame.name,
            activity: frame.activity ?? "typing",
            at: Date.now()
        });
    });
    useEffect(() => () => resetTyping(), []);
    return null;
}
