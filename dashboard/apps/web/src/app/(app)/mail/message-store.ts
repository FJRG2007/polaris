"use client";

/**
 * The messages this tab has already read.
 *
 * Opening a message used to be a server action, which is the slowest shape a
 * read can have in this app: the router runs actions one at a time, so the open
 * queued behind whatever was asked for last - the prefetch of a row somebody
 * passed over, the flag from the message they read a second ago - and the answer
 * carried a re-render of the whole route back with it. The body was already on
 * this machine and the click still waited.
 *
 * So it is a GET, and this is what holds the answers. Two things follow from
 * that and both are the point:
 *
 * - **The prefetch and the open are the same request.** Pointing at a row asks
 *   for exactly what pressing it asks for, so the press finds it here and draws
 *   with no round trip at all.
 * - **A request in flight is joined, never repeated.** The promise is what is
 *   kept, so a hover followed immediately by a press is one fetch, and a message
 *   opened, collapsed and opened again is none.
 *
 * In memory and nowhere else. Somebody's mail is not something to leave in
 * storage a later page can read, and a tab that is closed is a cache that should
 * be gone.
 */

import type { AnswerableMessage } from "./answering";
import type { ReadableMessage } from "@/lib/mailbox/reading";

/** One message, as the endpoint answers it. */
export interface OpenedMessage {
    readonly readable: ReadableMessage;
    readonly envelope: AnswerableMessage;
}

/** What went wrong, in words a reader can do something with. */
export class MailOpenError extends Error {}

const held = new Map<string, Promise<OpenedMessage>>();

/** How many messages' words this tab keeps. Enough for any conversation and a
 *  long walk down a list; past it the oldest is dropped, because a mailbox left
 *  open all day would otherwise hold every message read in it. */
const KEEP = 200;

async function fetchMessage(messageId: string): Promise<OpenedMessage> {
    const response = await fetch(`/api/mail/message/${encodeURIComponent(messageId)}`, {
        cache: "no-store"
    });
    if (!response.ok) {
        const said = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new MailOpenError(said?.error ?? "That message could not be opened.");
    }
    return (await response.json()) as OpenedMessage;
}

/**
 * One message, from this tab where it has it and from the server where it does
 * not.
 *
 * A failure is not kept: the next ask tries again, which is what somebody who
 * pressed the button again means.
 */
export function readMessage(messageId: string): Promise<OpenedMessage> {
    const already = held.get(messageId);
    if (already) return already;

    const asked = fetchMessage(messageId).catch((caught: unknown) => {
        held.delete(messageId);
        throw caught;
    });
    held.set(messageId, asked);
    if (held.size > KEEP) {
        const oldest = held.keys().next();
        if (!oldest.done && oldest.value !== messageId) held.delete(oldest.value);
    }
    return asked;
}

/** Ask for one early, and say nothing about how it went. Whatever is wrong with
 *  it will be wrong again, visibly, if it is actually opened. */
export function warmMessage(messageId: string): Promise<void> {
    return readMessage(messageId).then(
        () => undefined,
        () => undefined
    );
}

/** Whether this tab can draw a message without asking for anything. */
export function messageHeld(messageId: string): boolean {
    return held.has(messageId);
}

/** Forget one - what an action that changes the message underneath it has to
 *  do, or the pane would go on drawing what it used to say. */
export function forgetMessage(messageId: string): void {
    held.delete(messageId);
}
