"use client";

/**
 * Being let in, heard rather than asked for.
 *
 * Both lobbies - the guest page and the meeting room - found out they had been
 * admitted by asking every three seconds. So the wait after somebody pressed
 * "let them in" was up to three seconds of nothing before the call even began to
 * start, on top of everything joining a call actually costs: a ticket, a
 * connection, a microphone. It was the largest single piece of it and the only
 * one that bought nothing.
 *
 * The room's own stream already carries the answer. It re-reads admission on
 * every roster change for a seat that is still waiting and sends a `seated`
 * frame the moment one is let in - that was built for the call hook, which is
 * mounted too late to hear it. This is the lobby listening to the same thing.
 *
 * The poll stays where it is, unchanged, and is now the fallback rather than the
 * mechanism: a stream that cannot be opened, a proxy that buffers it, or a
 * refusal - which the stream deliberately does not report - all still resolve on
 * the next tick.
 */

import { useEffect, useRef } from "react";

export function useLobbyAdmission(meetingId: string | null, onAdmitted: () => void): void {
    // Held in a ref so a caller passing a fresh closure every render does not
    // tear the stream down and open another one each time it re-renders.
    const admitted = useRef(onAdmitted);
    admitted.current = onAdmitted;

    useEffect(() => {
        if (!meetingId) return;
        const source = new EventSource(`/api/chat/meetings/${meetingId}/stream`);
        source.onmessage = (event: MessageEvent<string>) => {
            let raw: unknown;
            try {
                raw = JSON.parse(event.data);
            } catch {
                return;
            }
            if (typeof raw !== "object" || raw === null) return;
            const frame = raw as { kind?: unknown; admission?: unknown };
            if (frame.kind !== "seated" || frame.admission !== "admitted") return;
            admitted.current();
        };
        // Nothing on an error. The stream reconnects on its own, and the poll
        // behind this is what covers the case where it never comes back.
        return () => source.close();
    }, [meetingId]);
}
