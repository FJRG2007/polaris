"use client";

/**
 * What the composer opens with when somebody answers a message.
 *
 * One place, because there are now three ways to answer: the buttons at the top
 * of a conversation, the buttons at the bottom of it, and the right-click menu
 * on a row in the list. Written twice they would drift, and the way they would
 * drift is in who a reply goes to - which is the one thing about a reply that
 * must never be a guess.
 */

import * as core from "@polaris/core";

/** Everything about a message that decides what answering it looks like. Shaped
 *  so the reading pane's own message satisfies it without conversion. */
export interface AnswerableMessage {
    readonly id: string;
    readonly accountId: string;
    readonly subject: string;
    readonly from: readonly core.MailAddress[];
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly replyTo: readonly core.MailAddress[];
    readonly listId: string;
    readonly sentAt: string;
}

/**
 * What a reply starts with.
 *
 * The recipients come out of the shared rule, so a reply from the list and a
 * reply from the reading pane address the same people. The body is two blank
 * lines and then the message being answered, attributed the way every other
 * client attributes it - so the result reads the same in theirs.
 *
 * `quoted` is the plain text, never the HTML: quoting markup into a reply is how
 * a thread turns into unreadable nested tables. A message with no text part
 * quotes nothing, which is honest.
 */
export function replySeed(
    message: AnswerableMessage,
    /** Every address the reader sends as, so a reply-all does not copy them in
     *  on their own message. */
    self: readonly string[],
    all: boolean,
    quoted: string
) {
    const { to, cc } = core.replyRecipients(
        {
            messageId: "",
            inReplyTo: "",
            references: [],
            subject: message.subject,
            from: message.from,
            to: message.to,
            cc: message.cc,
            replyTo: message.replyTo,
            listId: message.listId,
            sentAt: new Date(message.sentAt)
        },
        self,
        all
    );
    const sender = message.from[0] ?? { name: "", address: "" };
    return {
        accountId: message.accountId,
        to: [...to],
        cc: [...cc],
        subject: core.replySubject(message.subject),
        body: quoted.trim() ? `\n\n${core.quoteForReply(quoted, sender, new Date(message.sentAt))}` : "",
        inReplyToId: message.id,
        forward: false
    };
}

/**
 * What a forward starts with.
 *
 * The block above the original is the one every client writes and every reader
 * recognises, which matters more here than anywhere else: a forward with no
 * header is a message whose recipient cannot tell who originally sent it.
 *
 * The original's files are brought over by the composer once it opens
 * (`attachFromMessage`), because that is a fetch from the mail server and this
 * function only shapes the text.
 */
export function forwardSeed(message: AnswerableMessage, quoted: string) {
    const sender = message.from[0];
    const header = [
        "---------- Forwarded message ----------",
        `From: ${sender ? core.formatAddress(sender) : "unknown"}`,
        `Date: ${new Date(message.sentAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
        `Subject: ${message.subject}`,
        `To: ${core.formatAddressList(message.to)}`,
        ...(message.cc.length > 0 ? [`Cc: ${core.formatAddressList(message.cc)}`] : [])
    ].join("\n");
    return {
        accountId: message.accountId,
        to: [],
        subject: core.forwardSubject(message.subject),
        body: `\n\n${header}\n\n${quoted}`,
        inReplyToId: message.id,
        forward: true
    };
}
