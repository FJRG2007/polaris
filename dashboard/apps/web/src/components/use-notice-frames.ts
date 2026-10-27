"use client";

/**
 * Calls `onChange` when the account's live stream says a notice above the page
 * changed (see `shell-notices-live`). Rides the shared stream, so it opens no
 * connection of its own. A burst is gathered into one call, and each tab waits
 * a random part of a couple of seconds more, so a change every open tab hears
 * is not every tab reading again in the same instant.
 */

import { useEffect, useRef } from "react";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import type { NoticeTopic } from "@/lib/shell-notices-live";

const STREAM_PATH = "/api/access/stream";
const SETTLE_MS = 300;
export const NOTICE_SPREAD_MS = 2_000;

/** Whether a frame off the stream is a change to this notice. */
export function isNoticeFrame(data: string, topic: NoticeTopic): boolean {
    try {
        const frame = JSON.parse(data) as { kind?: unknown; topic?: unknown };
        return frame.kind === "notices" && frame.topic === topic;
    } catch {
        return false;
    }
}

export function useNoticeFrames(topic: NoticeTopic, onChange: () => void, enabled = true): void {
    const scope = useSessionScope();
    const latest = useRef(onChange);
    latest.current = onChange;

    useEffect(() => {
        if (!enabled) return;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const stop = subscribeSharedStream(STREAM_PATH, scope, ({ data }) => {
            if (!isNoticeFrame(data, topic) || timer) return;
            timer = setTimeout(() => {
                timer = null;
                latest.current();
            }, SETTLE_MS + Math.random() * NOTICE_SPREAD_MS);
        });
        return () => {
            if (timer) clearTimeout(timer);
            stop();
        };
    }, [scope, topic, enabled]);
}
