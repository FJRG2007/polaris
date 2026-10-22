"use client";

/**
 * Which of the person's Polar chats are answering right now, for the marks in
 * the sidebar, and the stop that reaches the server.
 *
 * An answer outlives the screen that asked for it (`lib/polar/runs.ts`), so
 * the list asks the server rather than the open chat: often while something
 * is running, rarely while nothing is, and not at all from a hidden tab.
 */

import { useEffect, useState } from "react";
import type { PolarRunView } from "@/lib/polar/runs";

/** How often the list is read while a chat is answering, and while none is. */
const BUSY_MS = 3_000;
const IDLE_MS = 20_000;

/** The marks by thread id. */
export type PolarRunMarks = Record<string, PolarRunView>;

function isRunView(value: unknown): value is PolarRunView {
    if (!value || typeof value !== "object") return false;
    const run = value as Record<string, unknown>;
    return (
        typeof run.threadId === "string" &&
        typeof run.state === "string" &&
        typeof run.unread === "boolean" &&
        typeof run.startedAt === "number"
    );
}

/** The server's list as marks; anything unreadable reads as no marks. */
export function marksFrom(body: unknown): PolarRunMarks {
    const list =
        body && typeof body === "object" && Array.isArray((body as { runs?: unknown }).runs)
            ? (body as { runs: unknown[] }).runs
            : [];
    const marks: PolarRunMarks = {};
    for (const run of list) if (isRunView(run)) marks[run.threadId] = run;
    return marks;
}

/**
 * The marks, read while `enabled`. `nudge` changes when the open chat starts
 * or stops answering, so its own mark follows it without waiting for a poll.
 */
export function usePolarRuns(enabled: boolean, nudge: unknown): PolarRunMarks {
    const [marks, setMarks] = useState<PolarRunMarks>({});
    useEffect(() => {
        if (!enabled) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let gone = false;
        const read = async () => {
            if (document.visibilityState === "visible") {
                const response = await fetch("/api/polar/runs").catch(() => null);
                const body: unknown = response?.ok ? await response.json().catch(() => null) : null;
                if (gone) return;
                if (body) {
                    const next = marksFrom(body);
                    setMarks(next);
                    const busy = Object.values(next).some((run) => run.state === "running");
                    timer = setTimeout(read, busy ? BUSY_MS : IDLE_MS);
                    return;
                }
            }
            if (!gone) timer = setTimeout(read, IDLE_MS);
        };
        const onVisible = () => {
            if (document.visibilityState !== "visible") return;
            clearTimeout(timer);
            void read();
        };
        void read();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            gone = true;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [enabled, nudge]);
    return marks;
}

/** Stops a chat's answer on the server; leaving the chat does not. */
export async function stopPolarAnswer(threadId: string): Promise<void> {
    await fetch(`/api/polar/chat/${encodeURIComponent(threadId)}/stream`, {
        method: "DELETE"
    }).catch(() => null);
}
