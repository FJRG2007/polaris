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
    /** Mail-Followup-To and List-Post, where the message carried them. Only an
     *  opened message has them: a row in a list does not. */
    readonly followupTo?: readonly core.MailAddress[];
    readonly listPost?: string;
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
            followupTo: message.followupTo ?? [],
            listPost: message.listPost ?? "",
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

/** The three ways to answer a message, as the composer's switch names them. */
export type AnswerKind = "reply" | "reply-all" | "forward";

/**
 * What the composer needs to turn one way of answering into another.
 *
 * Gmail lets somebody who pressed Reply decide halfway through that it should
 * have been Reply all, or a forward, without losing what they wrote. Switching
 * is the same seed built again for the other kind, so the recipients it lands
 * on are exactly the ones that button would have opened with.
 */
export interface AnswerContext {
    readonly kind: AnswerKind;
    readonly message: AnswerableMessage;
    readonly self: readonly string[];
    readonly quoted: string;
}

/** The seed for one way of answering, carrying what switching needs. */
export function answerSeed(
    kind: AnswerKind,
    message: AnswerableMessage,
    self: readonly string[],
    quoted: string
) {
    const seed =
        kind === "forward"
            ? { ...forwardSeed(message, quoted), cc: [] }
            : replySeed(message, self, kind === "reply-all", quoted);
    const answering: AnswerContext = { kind, message, self, quoted };
    return { ...seed, answering };
}
