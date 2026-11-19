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

/**
 * Who wrote a message, as a typing frame names them: the person, or the agent
 * (Polar) that has no account. Pure.
 */
export function writerOf(message: { readonly authorId: string | null; readonly fromAgent?: string }): string | null {
    return message.authorId ?? message.fromAgent ?? null;
}

/**
 * Typists with the writers of `messages` taken out: somebody whose message has
 * landed has stopped typing it, whatever the last frame said, the way the dots
 * go the moment the message appears in WhatsApp and Discord instead of a few
 * seconds after. Returns `entries` itself when nobody left. Pure.
 */
export function withoutWriters<T extends { readonly userId: string }>(
    entries: readonly T[],
    messages: readonly { readonly authorId: string | null; readonly fromAgent?: string }[]
): readonly T[] {
    if (entries.length === 0) return entries;
    const wrote = new Set(messages.flatMap((message) => writerOf(message) ?? []));
    const kept = entries.filter((entry) => !wrote.has(entry.userId));
    return kept.length === entries.length ? entries : kept;
}

/**
 * A message landed in `channelId`: the list knows the conversation, not who
 * wrote it, so everybody typing there stops - anyone still writing is back
 * within one frame. `only` narrows it to those ids: an answer Polar writes over
 * its own earlier message changes it in place, and stops only Polar.
 */
export function stopTyping(channelId: string, only?: ReadonlySet<string>): void {
    const current = byChannel.get(channelId);
    if (!current) return;
    const kept = only ? current.filter((entry) => !only.has(entry.userId)) : [];
    if (kept.length === current.length) return;
    if (kept.length === 0) byChannel.delete(channelId);
    else byChannel.set(channelId, kept);
    changed(channelId);
}

/** Typists that write no message of their own account: an agent's answer is
 *  written in place, and changing a message in place is how it lands. */
const AGENT_TYPISTS: ReadonlySet<string> = new Set(["polar"]);

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
        if (frame.kind === "posted") {
            for (const channelId of frame.arrived ?? frame.channels) stopTyping(channelId);
            for (const channelId of Object.keys(frame.changed ?? {})) stopTyping(channelId, AGENT_TYPISTS);
            return;
        }
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
