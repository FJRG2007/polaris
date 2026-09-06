"use client";

/**
 * The live channel behind Mail, read.
 *
 * Subscribed through the shared stream rather than by opening a connection here:
 * one tab per device holds the wire, so four Polaris tabs cost one server-sent
 * events connection between them rather than four.
 *
 * Frames are validated on arrival. A tab left open across a deploy is talking to
 * a server that has moved on, and a frame it does not understand has to be
 * ignored rather than break the screen somebody is reading.
 */

import { z } from "zod";
import { useEffect, useRef } from "react";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";

const STREAM_PATH = "/api/mail/stream";

const frameSchema = z.discriminatedUnion("kind", [
    // One or more mailboxes moved: mail arrived, a flag changed, a folder was
    // resynced. The tab answers by asking the server for the screen again.
    z.object({ kind: z.literal("mail"), seq: z.number(), accounts: z.array(z.string()) }),
    // A queued message left, failed, or was taken back. Never coalesced: it is
    // what the composer's countdown is waiting for.
    z.object({ kind: z.literal("sending"), accountId: z.string() })
]);

export type MailFrame = z.infer<typeof frameSchema>;

/** Call `onFrame` for every frame this device receives. The callback is held in
 *  a ref so a caller can close over fresh state without re-subscribing on every
 *  render. */
export function useMailStream(onFrame: (frame: MailFrame) => void): void {
    const scope = useSessionScope();
    const handler = useRef(onFrame);
    handler.current = onFrame;

    useEffect(() => {
        return subscribeSharedStream(STREAM_PATH, scope, (event) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(event.data);
            } catch {
                return;
            }
            const frame = frameSchema.safeParse(parsed);
            if (frame.success) handler.current(frame.data);
        });
    }, [scope]);
}
