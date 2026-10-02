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
 * Between visits, the device keeps the last bodies read through `mail-cache`:
 * the signed-in reader's own, bounded, dropped on sign-out - and only after the
 * same sanitizer the reading pane uses, so what is kept is what was drawn and
 * never the markup as it arrived. Nothing here goes into web storage, which
 * any later page on this origin could read.
 */

import { sanitizeMail } from "./sanitize";
import type { AnswerableMessage } from "./answering";
import { mailCache } from "@/lib/mailbox/mail-cache";
import type { ReadableMessage } from "@/lib/mailbox/reading";

/** One message, as the endpoint answers it. */
export interface OpenedMessage {
    readonly readable: ReadableMessage;
    readonly envelope: AnswerableMessage;
}

/** What went wrong, in words a reader can do something with. */
export class MailOpenError extends Error {}

const held = new Map<string, Promise<OpenedMessage>>();
/** The same answers once they have arrived, so a pane can draw one in the very
 *  render that opens it instead of a render later. */
const settled = new Map<string, OpenedMessage>();

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
    const answer = (await response.json()) as OpenedMessage;
    // Cleaned here, once, so the copy this tab holds and the copy the device
    // keeps are both the cleaned one. The pane cleans it again on the way into
    // its frame, which changes nothing and costs nothing - see `sanitize`.
    const html = await sanitizeMail(answer.readable.html).catch(() => null);
    if (html === null) return answer;
    const opened: OpenedMessage = { ...answer, readable: { ...answer.readable, html } };
    mailCache.write("message", messageId, opened, opened.envelope.accountId);
    return opened;
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

    const asked = fetchMessage(messageId).then(
        (opened) => {
            if (held.get(messageId) === asked) settled.set(messageId, opened);
            return opened;
        },
        (caught: unknown) => {
            held.delete(messageId);
            throw caught;
        }
    );
    held.set(messageId, asked);
    if (held.size > KEEP) {
        const oldest = held.keys().next();
        if (!oldest.done && oldest.value !== messageId) {
            held.delete(oldest.value);
            settled.delete(oldest.value);
        }
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

/** The message, if this tab already has its answer - without waiting. */
export function peekMessage(messageId: string): OpenedMessage | null {
    return settled.get(messageId) ?? null;
}

/**
 * What this device kept of a message from an earlier visit, or nothing.
 *
 * Drawn while the request for it is still in the air, and replaced by that
 * answer when it lands: the words of a message do not change, but whether its
 * pictures load does, and the addresses they load from are signed for a day.
 */
export function keptMessage(messageId: string): Promise<OpenedMessage | null> {
    return mailCache.read<OpenedMessage>("message", messageId);
}

/** Forget one - what an action that changes the message underneath it has to
 *  do, or the pane would go on drawing what it used to say. */
export function forgetMessage(messageId: string): void {
    held.delete(messageId);
    settled.delete(messageId);
    mailCache.forget("message", messageId);
}
