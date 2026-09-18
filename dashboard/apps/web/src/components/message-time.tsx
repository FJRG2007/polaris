"use client";

/**
 * A message's time - see `lib/chat/message-time` - with the full date and time
 * on hover.
 *
 * "Today" and "yesterday" move at midnight, so every stamp on screen is drawn
 * again when the day may have changed. One timer for the whole page, not one
 * per message, and it only runs while a stamp is mounted.
 */

import { useSyncExternalStore } from "react";
import { useDisplayFormat } from "./display-format";
import { messageStamp } from "@/lib/chat/message-time";

/** How often the day is looked at again. Coarse on purpose: a label a few
 *  minutes late at midnight is invisible, a re-render of every line each second
 *  is not. Short enough to cover zones offset by half an hour. */
const TICK_MS = 5 * 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    timer ??= setInterval(() => {
        tick += 1;
        for (const notify of listeners) notify();
    }, TICK_MS);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
            clearInterval(timer);
            timer = null;
        }
    };
}

export function MessageTime({ iso, className }: { iso: string; className?: string }) {
    const format = useDisplayFormat();
    // Read only to re-render on each tick; the stamp takes the time itself.
    useSyncExternalStore(
        subscribe,
        () => tick,
        () => 0
    );
    return (
        <time
            dateTime={iso}
            title={format.dateTime(iso)}
            className={className}
            // The server and the browser can straddle midnight.
            suppressHydrationWarning
        >
            {messageStamp(format, iso)}
        </time>
    );
}
