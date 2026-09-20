/**
 * "Is my sending actually working?", answered by sending.
 *
 * Every other thing a mail client can tell somebody about their outgoing setup
 * is a proxy: the password was accepted, the port answered, a record is
 * published. None of them is the question. The question is whether a message
 * written here reaches a mailbox, and the only way to answer it honestly is to
 * put one through the real path - the same queue, the same composer, the same
 * submission - and then watch for it with the same sync that reads everything
 * else.
 *
 * Which is what this does: one message from the mailbox to itself. It gives up
 * to four answers, and the distance between the last two is the point of the
 * whole feature:
 *
 * - **refused** - the outgoing server would not take it, in its own words. The
 *   setup is wrong now, and the sentence says how.
 * - **accepted** - the outgoing server took it. For a mailbox at somebody else's
 *   provider this is the ceiling of what a client can ever know, and the screen
 *   says so rather than dressing it up as delivery.
 * - **arrived** - the message came back into this same mailbox through IMAP.
 *   That is a whole round trip proved end to end, and it is the only screen in
 *   Polaris entitled to say mail is working.
 * - **bounced** - it came back as a delivery report instead.
 *
 * Nothing about it is special-cased in the send path. It is an ordinary queued
 * message with one flag on it, so what this proves is what an ordinary message
 * would do - a check that took a shortcut past the queue would be a check that
 * passes while sending is broken.
 */

import { asJson } from "./json";
import { prisma } from "@polaris/db";
import { queueSend } from "./compose";
import { ownedAccount } from "./access";

/** What the check is waiting for, or what it found. */
export type MailCheckStage = "none" | "sending" | "refused" | "accepted" | "arrived" | "bounced";

export interface MailSendCheck {
    readonly stage: MailCheckStage;
    /** When this check's message was written, or "" where none has been. */
    readonly startedAt: string;
    /** The sentence under the heading. Never empty except for `none`. */
    readonly detail: string;
    /** Whether something is still expected to happen without anybody pressing
     *  anything, so the screen knows whether to keep asking. */
    readonly waiting: boolean;
}

/** The subject of the message. Recognisable in a mailbox - somebody will find
 *  it there and wonder what it is - and it says who sent it and why. */
const CHECK_SUBJECT = "Polaris delivery check";

const CHECK_BODY = [
    "Polaris sent this message from this mailbox to this mailbox to check that sending works.",
    "",
    "Nothing needs doing about it, and it can be thrown away."
].join("\n");

/** How often a mailbox may be checked. Long enough that pressing the button
 *  twice is not two messages, short enough that somebody fixing a setting can
 *  check again while they still remember what they changed. */
const CHECK_EVERY_MS = 2 * 60 * 1000;

/**
 * Start a check, or say why not.
 *
 * Refuses while one is still on its way rather than queueing a second: two
 * checks in flight means two answers arriving, and the screen would show
 * whichever landed last.
 */
export async function startSendCheck(userId: string, accountId: string): Promise<MailSendCheck> {
    const account = await ownedAccount(userId, accountId);
    const running = await prisma.mailDraft.findFirst({
        where: { accountId, probe: true, state: { in: ["queued", "sending"] } },
        select: { id: true }
    });
    if (running) return readSendCheck(userId, accountId);

    const recent = await prisma.mailDelivery.findFirst({
        where: { accountId, probe: true, sentAt: { gte: new Date(Date.now() - CHECK_EVERY_MS) } },
        select: { id: true }
    });
    if (recent) return readSendCheck(userId, accountId);

    const to = [{ name: "", address: account.address }];
    const draft = await prisma.mailDraft.create({
        data: {
            accountId,
            toJson: asJson(to),
            subject: CHECK_SUBJECT,
            body: CHECK_BODY,
            probe: true
        },
        select: { id: true }
    });
    // Through the ordinary queue, with no wait: the undo window is for somebody
    // who might change their mind, and nobody changes their mind about this.
    await queueSend(userId, {
        accountId,
        identityId: null,
        to,
        cc: [],
        bcc: [],
        replyTo: "",
        subject: CHECK_SUBJECT,
        body: CHECK_BODY,
        attachmentIds: [],
        inReplyToId: null,
        forward: false,
        sendAt: new Date(),
        requestReceipt: false,
        draftId: draft.id
    });
    return readSendCheck(userId, accountId);
}

/**
 * Where the last check got to.
 *
 * The queue entry is the newer truth while it exists - it is deleted the moment
 * the message goes - so it is read first, and the delivery record answers for
 * everything after that.
 */
export async function readSendCheck(userId: string, accountId: string): Promise<MailSendCheck> {
    await ownedAccount(userId, accountId);

    const draft = await prisma.mailDraft.findFirst({
        where: { accountId, probe: true },
        orderBy: { createdAt: "desc" },
        select: { state: true, failure: true, createdAt: true, permanent: true }
    });
    if (draft && draft.state !== "failed") {
        return {
            stage: "sending",
            startedAt: draft.createdAt.toISOString(),
            detail: "Sending a message from this mailbox to itself.",
            waiting: true
        };
    }
    if (draft) {
        return {
            stage: "refused",
            startedAt: draft.createdAt.toISOString(),
            detail: draft.failure || "The outgoing server would not take the message.",
            waiting: !draft.permanent
        };
    }

    const sent = await prisma.mailDelivery.findFirst({
        where: { accountId, probe: true },
        orderBy: { sentAt: "desc" },
        select: { messageId: true, state: true, detail: true, sentCopy: true, sentAt: true }
    });
    if (!sent) {
        return { stage: "none", startedAt: "", detail: "", waiting: false };
    }
    if (sent.state === "bounced" || sent.state === "delayed") {
        return {
            stage: sent.state === "bounced" ? "bounced" : "accepted",
            startedAt: sent.sentAt.toISOString(),
            detail: sent.detail,
            waiting: sent.state === "delayed"
        };
    }

    // Did it come back? Anywhere but the folders holding this mailbox's own
    // outgoing copies - a message found in Sent is the copy Polaris filed there
    // itself, and reading that as an arrival would make this check pass on a
    // mailbox that cannot receive anything.
    const back = await prisma.mailMessage.findFirst({
        where: {
            accountId,
            messageId: sent.messageId,
            folder: { role: { notIn: ["sent", "drafts"] } }
        },
        select: { id: true }
    });
    if (back) {
        return {
            stage: "arrived",
            startedAt: sent.sentAt.toISOString(),
            detail: `${copyNote(sent.sentCopy)}The message was sent and came back into this mailbox, so sending and receiving both work.`.trim(),
            waiting: false
        };
    }
    return {
        stage: "accepted",
        startedAt: sent.sentAt.toISOString(),
        detail: `${copyNote(sent.sentCopy)}Your outgoing server accepted the message. It has not arrived back here yet, which for a mailbox at another provider can take a few minutes.`.trim(),
        waiting: true
    };
}

/** Said first where there is something to say about it, because a mailbox that
 *  sends but keeps no copy is a separate thing to fix. */
function copyNote(copy: string): string {
    if (copy === "failed") return "No copy could be filed in Sent. ";
    if (copy === "none") return "This mailbox has no Sent folder, so no copy was kept. ";
    return "";
}
