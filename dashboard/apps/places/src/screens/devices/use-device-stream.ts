"use client";

/**
 * Listening for device changes while the devices screen is in front.
 *
 * One EventSource on `/api/home/devices/live`, open only while the tab is
 * visible: a screen nobody is looking at needs no stream, and closing it is
 * what lets the server stop reading the accounts for it. Coming back to the
 * tab opens it again, and every (re)open is announced through `onReady` so the
 * screen can read the stored list once and catch up on what it was not told
 * while it was away.
 *
 * Frames are checked before they are used: the stream is ours, but a proxy,
 * an older server mid-update or a truncated write is not, and a screen of doors
 * must not be redrawn from something half-parsed.
 */

import { z } from "zod";
import type { DeviceChange } from "../../lib/device-diff";
import { useEffect, useRef, useSyncExternalStore } from "react";

const LIVE_URL = "/api/home/devices/live";

const frameSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ready") }),
    z.object({
        kind: z.literal("devices"),
        devices: z.array(z.object({ id: z.string() }).passthrough()),
        removed: z.array(z.string()),
        seen: z.object({ ids: z.array(z.string()), at: z.string() }).nullable(),
        accounts: z.array(z.object({ id: z.string() }).passthrough()).optional()
    })
]);

/** Parse one frame's text, or null for anything that is not one. */
export function parseDeviceFrame(
    text: string
): { kind: "ready" } | ({ kind: "devices" } & DeviceChange) | null {
    try {
        const parsed = frameSchema.safeParse(JSON.parse(text));
        if (!parsed.success) return null;
        return parsed.data as { kind: "ready" } | ({ kind: "devices" } & DeviceChange);
    } catch {
        return null;
    }
}

export function useDeviceStream({
    enabled,
    placeId,
    onChange,
    onReady
}: {
    enabled: boolean;
    /** The place being looked at; the stream is opened again when it changes,
     *  because the server filters by the place it was opened on. */
    placeId: string;
    onChange: (change: DeviceChange) => void;
    onReady: () => void;
}): void {
    // Held in refs so a screen re-rendering does not reopen the stream.
    const handlers = useRef({ onChange, onReady });
    handlers.current = { onChange, onReady };

    useEffect(() => {
        if (!enabled || typeof EventSource === "undefined") return;
        let source: EventSource | null = null;
        const open = () => {
            if (source || document.visibilityState !== "visible") return;
            source = new EventSource(LIVE_URL);
            source.onmessage = (event: MessageEvent<string>) => {
                const frame = parseDeviceFrame(event.data);
                if (!frame) return;
                if (frame.kind === "ready") handlers.current.onReady();
                else handlers.current.onChange(frame);
            };
            // A refusal (signed out, nothing lent any more) closes it for good;
            // anything else is the browser's to retry, which it does by itself.
            source.onerror = () => {
                if (source?.readyState === EventSource.CLOSED) {
                    source = null;
                }
            };
        };
        const shut = () => {
            source?.close();
            source = null;
        };
        const visibility = () => (document.visibilityState === "visible" ? open() : shut());
        open();
        document.addEventListener("visibilitychange", visibility);
        return () => {
            document.removeEventListener("visibilitychange", visibility);
            shut();
        };
    }, [enabled, placeId]);
}

// ---------------------------------------------------------------------------
// When each device was last confirmed
// ---------------------------------------------------------------------------

/**
 * Kept apart from the devices themselves: every read confirms every device,
 * and if that time lived on the device every read would redraw every row. Here
 * only the "updated" line beside each one moves.
 */
const seen = new Map<string, string>();
const listeners = new Set<() => void>();

/** Record that these devices were read at `at`, keeping whichever is newer. */
export function markSeen(entries: Iterable<readonly [string, string | null]>): void {
    let moved = false;
    for (const [id, at] of entries) {
        if (!at) continue;
        const before = seen.get(id);
        if (before && Date.parse(before) >= Date.parse(at)) continue;
        seen.set(id, at);
        moved = true;
    }
    if (moved) for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** When one device was last confirmed, or null when it never was. */
export function useSeenAt(id: string): string | null {
    return useSyncExternalStore(
        subscribe,
        () => seen.get(id) ?? null,
        () => null
    );
}
