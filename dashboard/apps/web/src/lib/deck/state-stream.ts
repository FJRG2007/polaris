/**
 * The live state of a deck's keys, as one server-sent event stream.
 *
 * The plugin subscribes once for every key it shows. A `state` frame carries
 * the keys whose state changed since the last one (all of them on the first);
 * a comment line every so often keeps proxies from closing a quiet stream.
 *
 * What wakes a read: the chat bus, for a key counting unread messages, when a
 * change touches a conversation this person reaches; and a clock for the rest
 * (status, alarms, notifications, Places), which have no bus a deck could hold.
 * The stream ends itself after a few minutes and the plugin reconnects, so a
 * key that was revoked, or a permission taken away, stops answering within
 * that long without the stream having to check on every tick.
 *
 * Server-only.
 */

import type { DeckCaller, DeckState } from "./types";
import { reachableChannelIds } from "@/lib/chat/access";
import { subscribeChatChanges, type ChatChange } from "@/lib/chat/live";
import { readDeckStates, type DeckWatch, type DeckWords } from "./deck-service";

export const DECK_STREAM = {
    /** How often everything is read again. */
    clockMs: 15_000,
    /** A burst of chat changes is one read. */
    coalesceMs: 750,
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
    let unsubscribe: (() => void) | null = null;

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
                if (pending) clearTimeout(pending);
                unsubscribe?.();
                try {
                    controller.close();
                } catch {
                    // Already closed by the other side.
                }
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
                    const { readings, chat } = await readDeckStates(caller, watched, words);
                    const changed = readings.filter((entry) => {
                        const text = JSON.stringify(entry.state);
                        if (last.get(entry.key) === text) return false;
                        last.set(entry.key, text);
                        return true;
                    });
                    if (changed.length > 0 || first) write(stateFrame(changed));
                    first = false;
                    if (chat && !unsubscribe) {
                        reachable = await reachableChannelIds({ id: caller.userId });
                        unsubscribe = subscribeChatChanges((change) => {
                            if (!chatChangeConcerns(change, caller.userId, reachable)) return;
                            if (pending || closed) return;
                            pending = setTimeout(() => {
                                pending = null;
                                void read();
                            }, DECK_STREAM.coalesceMs);
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
            if (pending) clearTimeout(pending);
            unsubscribe?.();
        }
    });
}
