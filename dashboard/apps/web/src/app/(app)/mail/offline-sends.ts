"use client";

/**
 * Mail sent while Polaris could not be reached: kept on this device, in the
 * offline write queue every app shares (`lib/offline/app-writes`), and put in
 * the server's outbox when Polaris answers - from whichever screen is open.
 *
 * Each kept send carries a key of its own (`sendKey`), so a replay whose answer
 * was lost on the way back is answered with the message already queued instead
 * of sending it twice (`queueSendOnce`). Once taken it waits out the reader's
 * undo window there, like any other send.
 */

import type { Outgoing } from "./outbox";
import { useEffect, useState } from "react";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import { appWrites, registerWriteKind, type AppWrite } from "@/lib/offline/app-writes";

export const MAIL_SEND = "mail.send";

/** What is kept: the send as the composer made it, its hour as text. */
export type KeptSend = Omit<Outgoing, "sendAt"> & {
    readonly sendAt: string | null;
    readonly sendKey: string;
};

/** Answers worth asking again a moment later: Polaris (or the proxy in front
 *  of it) was not there, busy, or still taking this same send. */
const TRY_LATER = new Set([408, 409, 429, 502, 503, 504]);

/** Ask the outbox to take a kept send. Exported for the tests. */
export async function deliverSend(entry: Pick<AppWrite, "payload">): Promise<QueueSendResult> {
    let response: Response;
    try {
        response = await fetch("/api/mail/outbox", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(entry.payload),
            cache: "no-store"
        });
    } catch {
        return "unreachable";
    }
    if (response.ok) {
        const body = (await response.json().catch(() => null)) as { draftId?: unknown } | null;
        return { sent: typeof body?.draftId === "string" ? body.draftId : "" };
    }
    if (TRY_LATER.has(response.status)) return "unreachable";
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return { refused: typeof body?.error === "string" ? body.error : "" };
}

registerWriteKind(MAIL_SEND, deliverSend);

/**
 * Keep a send for when Polaris answers. Answers false when this device keeps
 * nothing (a private window, storage refused): the caller says it did not go.
 */
export async function keepSend(message: Outgoing): Promise<boolean> {
    const sendKey = newClientKey();
    const payload: KeptSend = { ...message, sendAt: message.sendAt?.toISOString() ?? null, sendKey };
    const kept = await appWrites.enqueue({ key: sendKey, kind: MAIL_SEND, target: sendKey, payload });
    if (kept) appWrites.flush();
    return kept;
}

/** The sends kept on this device, oldest first, kept current. */
export function useKeptSends(): readonly AppWrite[] {
    const [entries, setEntries] = useState<readonly AppWrite[]>([]);
    useEffect(() => {
        let live = true;
        const reload = () =>
            void appWrites.readAll().then(
                (all) =>
                    live &&
                    setEntries(
                        all
                            .filter((entry) => entry.kind === MAIL_SEND)
                            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                    ),
                () => undefined
            );
        reload();
        const unsubscribe = appWrites.subscribe((event) => {
            if (!event || event.entry.kind === MAIL_SEND) reload();
        });
        return () => {
            live = false;
            unsubscribe();
        };
    }, []);
    return entries;
}
