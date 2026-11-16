"use client";

/**
 * When the Code workspace should look again at what the agent wrote.
 *
 * A named edit tool finishing is one cue, and it wakes the preview and the
 * diffs at once. A shell command can write just as much - a formatter, a code
 * generator, `sed -i` - and nothing in its name says so, so any other tool
 * finishing only makes the workspace read the checkout's fingerprint (the
 * changes list's `print`, on the same read the diffs use) and wakes them when
 * that moved. Both cues arrive over the session's live stream; nothing here
 * runs on a timer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as polls from "@/components/agents/sessions/sessions-polls";

/** How long a burst of finished tools is gathered into one fingerprint read. */
export const PRINT_SETTLE_MS = 1_000;

export function useCheckoutWake({
    sessionId,
    active,
    lastEdit,
    lastTool
}: {
    sessionId: string;
    /** Whether anything is watching: the workspace is open on a live session. */
    active: boolean;
    lastEdit: string | null;
    lastTool: string | null;
}): string | null {
    const [wake, setWake] = useState<string | null>(lastEdit);
    // The fingerprint last read: undefined before the first read, null when
    // the checkout has none to give (no repository, not reachable).
    const print = useRef<string | null | undefined>(undefined);

    const readPrint = useCallback(async (): Promise<string | null> => {
        try {
            const answer = (await polls.sessionChanges({ sessionId, offset: 0 }))?.answer;
            return answer?.kind === "listing" && answer.listing.kind === "ok" ? (answer.listing.print ?? null) : null;
        } catch {
            // Unreachable is no fingerprint: the named edits still wake.
            return null;
        }
    }, [sessionId]);

    // Where the checkout stands when somebody starts watching, so the first
    // shell write after that is told apart from what was already there.
    useEffect(() => {
        if (!active) return;
        let on = true;
        void readPrint().then((value) => {
            if (on && print.current === undefined) print.current = value;
        });
        return () => {
            on = false;
        };
    }, [active, readPrint]);

    // A named edit wakes at once; the fingerprint is read again after it so
    // the shell command that follows is not taken for a second write.
    const seenEdit = useRef(lastEdit);
    useEffect(() => {
        if (lastEdit === seenEdit.current) return;
        seenEdit.current = lastEdit;
        setWake(`edit:${lastEdit}`);
        if (!active) return;
        void readPrint().then((value) => {
            if (value !== null) print.current = value;
        });
    }, [active, lastEdit, readPrint]);

    const seenTool = useRef(lastTool);
    useEffect(() => {
        if (!active || lastTool === seenTool.current) return;
        let on = true;
        const timer = window.setTimeout(() => {
            seenTool.current = lastTool;
            void readPrint().then((value) => {
                if (!on || value === null) return;
                const before = print.current;
                print.current = value;
                if (typeof before === "string" && before !== value) setWake(`print:${value}`);
            });
        }, PRINT_SETTLE_MS);
        return () => {
            on = false;
            window.clearTimeout(timer);
        };
    }, [active, lastTool, readPrint]);

    return wake;
}
