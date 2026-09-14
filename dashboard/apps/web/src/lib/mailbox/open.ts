/**
 * One message, ready to be read.
 *
 * Its own module because it is asked for from two places that must not be the
 * same kind of request. The reading pane asks over an endpoint - a plain GET the
 * browser can hold on to, which is what makes opening a message that has already
 * been fetched free - and the composer asks for it on the server when it needs
 * the text to quote.
 *
 * What it does is deliberately small: read the body (from this database where it
 * is held, from the mail server where it is not), read what is needed to answer
 * the message, and hand both through `readableMessage`, which is where the
 * privacy work happens.
 */

import * as reading from "./reading";
import * as messages from "./messages";

export interface OpenedMessage {
    readonly readable: reading.ReadableMessage;
    readonly envelope: ReturnType<typeof envelopeShape>;
}

/** Only so the interface above can name the shape `messageForReading` returns
 *  without either module importing the other's internals. */
function envelopeShape(): NonNullable<
    Awaited<ReturnType<typeof messages.messageForReading>>
>["envelope"] {
    throw new Error("never called");
}

/**
 * Read one message for its reader, or null when it is no longer there.
 *
 * A message that has been moved or deleted since the list was drawn is not an
 * error: the pane says so and the list catches up.
 */
export async function openMessage(
    userId: string,
    messageId: string
): Promise<OpenedMessage | null> {
    const body = await messages.loadBody(userId, messageId);
    const message = await messages.messageForReading(userId, messageId);
    if (!message) return null;
    const readable = await reading.readableMessage(
        message.accountId,
        messageId,
        userId,
        message.policy,
        {
            ...message.row,
            bodyHtml: body.html || message.row.bodyHtml,
            bodyText: body.text || message.row.bodyText
        }
    );
    return { readable, envelope: message.envelope };
}
