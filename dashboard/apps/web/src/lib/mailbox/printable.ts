/**
 * A conversation, gathered for paper.
 *
 * Printing needs every message in a conversation with its body, where the
 * reading pane fetches a body only when one is opened. So this walks the same
 * three readers the pane uses - the conversation narrowed by its reader, the
 * body fetched and kept, the markup prepared exactly as the pane prepares it -
 * and adds nothing of its own. What reaches the printed page is what the reader
 * would have seen, through the same sanitizer and the same sandboxed frame.
 */

import { readThreadView } from "./views";
import type * as core from "@polaris/core";
import { readableMessage } from "./reading";
import { loadBody, messageForReading } from "./messages";

/**
 * The most messages one printout carries.
 *
 * Every body not held yet is a round trip to the mail server, and a
 * conversation of a few hundred replies is a printout nobody wants anyway - the
 * newest are what somebody prints. Past this the oldest are left out and the
 * page says so.
 */
const PRINT_LIMIT = 60;

export interface PrintableMessage {
    readonly id: string;
    readonly from: readonly core.MailAddress[];
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly sentAt: string;
    readonly subject: string;
    readonly html: string;
    readonly text: string;
    readonly remoteAllowed: boolean;
}

export interface PrintableThread {
    readonly subject: string;
    readonly messages: readonly PrintableMessage[];
    /** How many older messages were left out, for the line that says so. */
    readonly leftOut: number;
}

/** Everything one conversation needs to be printed, or null when it is not the
 *  reader's - the same answer as "there is no such conversation", on purpose. */
export async function printableThread(
    userId: string,
    threadId: string
): Promise<PrintableThread | null> {
    const view = await readThreadView(userId, threadId);
    if (!view.thread) return null;
    const kept = view.messages.slice(-PRINT_LIMIT);

    const messages: PrintableMessage[] = [];
    for (const message of kept) {
        const body = await loadBody(userId, message.id);
        const held = await messageForReading(userId, message.id);
        if (!held) continue;
        const readable = await readableMessage(message.accountId, message.id, userId, held.policy, {
            ...held.row,
            bodyHtml: body.html || held.row.bodyHtml,
            bodyText: body.text || held.row.bodyText
        });
        messages.push({
            id: message.id,
            from: message.from,
            to: message.to,
            cc: message.cc,
            sentAt: message.sentAt,
            subject: message.subject,
            html: readable.html,
            text: readable.text,
            remoteAllowed: readable.remoteAllowed
        });
    }
    return {
        subject: view.thread.subject,
        messages,
        leftOut: view.messages.length - kept.length
    };
}
