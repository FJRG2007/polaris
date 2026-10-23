/**
 * The live state of a deck's keys, as one server-sent event stream.
 *
 * The plugin subscribes once for every key it shows. A `state` frame carries
 * the keys whose state changed since the last one (all of them on the first);
 * a comment line every so often keeps proxies from closing a quiet stream.
 *
 * What wakes a read: the chat bus, for a key counting unread messages, when a
 * change touches a conversation this person reaches; the deck bus, when a
 * writer says what one of this person's keys shows moved (a Calendar timer
 * paused from another device); and a clock for the rest (status, alarms,
 * notifications, Places), which have no bus a deck could hold.
 * The stream ends itself after a few minutes and the plugin reconnects, so a
 * key that was revoked, or a permission taken away, stops answering within
 * that long without the stream having to check on every tick.
 *
 * Server-only.
 */

import type { DeckCaller, DeckState } from "./types";
import { reachableChannelIds } from "@/lib/chat/access";
import { subscribeChatChanges, type ChatChange } from "@/lib/chat/live";
import { onControlsChanged } from "@/lib/chat/call-remote-service";
import { onDeckChanged } from "./live";
import { readDeckStates, type DeckWatch, type DeckWords } from "./deck-service";

export const DECK_STREAM = {
    /** How often everything is read again. */
    clockMs: 15_000,
    /** A burst of chat changes is one read. */
    coalesceMs: 750,
    /** A call's controls move once per press: read almost at once. */
    callMs: 50,
    /** How long after a press its keys are sent again, changed or not. */
    pressedMs: 3_000,
    heartbeatMs: 25_000,
    /** How long one stream lives before the plugin has to reconnect. */
    lifetimeMs: 5 * 60_000
} as const;

/** Whether a chat change could move this person's unread count. */
export function chatChangeConcerns(
    change: ChatChange,
    userId: string,
    reachable: ReadonlySet<string>
): boolean {
    if (change.kind !== "posted" && change.kind !== "read" && change.kind !== "channels")
        return false;
    if (change.audience?.includes(userId)) return true;
    return change.channelId !== undefined && reachable.has(change.channelId);
}

/** Whether a change announced on the deck bus is one this stream shows. */
export function deckChangeConcerns(
    watched: DeckWatch,
    userId: string,
    changedFor: string,
    actions: readonly string[]
): boolean {
    return changedFor === userId && watched.some((entry) => actions.includes(entry.action));
}

/** The text of one frame. */
export function stateFrame(readings: readonly { key: string; state: DeckState }[]): string {
    return `event: state\ndata: ${JSON.stringify({ readings })}\n\n`;
}

export function deckStateStream(
    caller: DeckCaller,
    watched: DeckWatch,
    words: DeckWords,
    signal?: AbortSignal
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const last = new Map<string, string>();
    let reachable: ReadonlySet<string> = new Set();
    let closed = false;
    let reading = false;
    let again = false;
    let first = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let pending: ReturnType<typeof setTimeout> | null = null;
    let pendingAt = 0;
    const resends = new Set<ReturnType<typeof setTimeout>>();
    let unsubscribe: (() => void) | null = null;
    let offCalls: (() => void) | null = null;
    let offDeck: (() => void) | null = null;

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            function write(text: string): void {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(text));
                } catch {
                    stop();
                }
            }

            function stop(): void {
                if (closed) return;
                closed = true;
                for (const timer of timers) clearInterval(timer);
                for (const timer of resends) clearTimeout(timer);
                if (pending) clearTimeout(pending);
                unsubscribe?.();
                offCalls?.();
                offDeck?.();
                try {
                    controller.close();
                } catch {
                    // Already closed by the other side.
                }
            }

            // A burst of wakes is one read, as soon as the soonest of them asks.
            function wake(delayMs: number = DECK_STREAM.coalesceMs): void {
                if (closed) return;
                const at = Date.now() + delayMs;
                if (pending && pendingAt <= at) return;
                if (pending) clearTimeout(pending);
                pendingAt = at;
                pending = setTimeout(() => {
                    pending = null;
                    void read();
                }, delayMs);
            }

            // What a press drew is sent again once the tab has had time to do
            // it, even unchanged: the stream sends only what moved, and a guess
            // nothing carried out - a moderator's mute - would otherwise stay.
            function resend(keys: readonly string[]): void {
                if (closed || keys.length === 0) return;
                const timer = setTimeout(() => {
                    resends.delete(timer);
                    for (const key of keys) last.delete(key);
                    wake(0);
                }, DECK_STREAM.pressedMs);
                resends.add(timer);
            }

            // One read at a time; a wake during one runs once more after it.
            async function read(): Promise<void> {
                if (closed) return;
                if (reading) {
                    again = true;
                    return;
                }
                reading = true;
                try {
                    const { readings, chat, call } = await readDeckStates(caller, watched, words);
                    const changed = readings.filter((entry) => {
                        const text = JSON.stringify(entry.state);
                        if (last.get(entry.key) === text) return false;
                        last.set(entry.key, text);
                        return true;
                    });
                    if (changed.length > 0 || first) write(stateFrame(changed));
                    first = false;
                    // A call key follows the tab on the call: its mute is on the
                    // key a moment after it is pressed, wherever it was pressed.
                    if (call && !offCalls) {
                        offCalls = onControlsChanged((userId) => {
                            if (userId === caller.userId) wake(DECK_STREAM.callMs);
                        });
                    }
                    if (chat && !unsubscribe) {
                        reachable = await reachableChannelIds({ id: caller.userId });
                        unsubscribe = subscribeChatChanges((change) => {
                            if (chatChangeConcerns(change, caller.userId, reachable)) wake();
                        });
                    }
                } catch (caught) {
                    console.error("deck: state read failed", caught);
                } finally {
                    reading = false;
                }
                if (again) {
                    again = false;
                    void read();
                }
            }

            signal?.addEventListener("abort", stop);
            offDeck = onDeckChanged((userId, actions, pressed) => {
                if (!deckChangeConcerns(watched, caller.userId, userId, actions)) return;
                if (!pressed) return wake();
                resend(
                    watched
                        .filter((entry) => actions.includes(entry.action))
                        .map((entry) => entry.key)
                );
            });
            write(`retry: 5000\n\n`);
            await read();
            timers.push(
                setInterval(() => {
                    void read();
                    if (unsubscribe) {
                        void reachableChannelIds({ id: caller.userId }).then((found) => {
                            reachable = found;
                        });
                    }
                }, DECK_STREAM.clockMs),
                setInterval(() => write(`: keep-alive\n\n`), DECK_STREAM.heartbeatMs),
                setTimeout(stop, DECK_STREAM.lifetimeMs)
            );
        },
        cancel() {
            closed = true;
            for (const timer of timers) clearInterval(timer);
            for (const timer of resends) clearTimeout(timer);
            if (pending) clearTimeout(pending);
            unsubscribe?.();
            offCalls?.();
            offDeck?.();
        }
    });
}
