/**
 * Writing, saving, scheduling, unsending and finally sending.
 *
 * One idea holds the whole file together: **everything leaves through the queue.**
 * Pressing Send does not open a socket - it writes a draft with an hour on it
 * and lets the queue take it. Send later is the same row with a later hour, and
 * Undo is clearing the hour before it arrives. Without that, "undo send" is a
 * second code path that has to know how to unpick a message that may already be
 * gone, which is the version of this feature that loses mail.
 *
 * The hour is usually a few seconds away. A timer in this process picks it up at
 * the second, and the scheduled sweep is the safety net for anything a restart
 * dropped - so a message queued a moment before a deploy is late rather than
 * lost.
 */

import { withImap, type MailConnectionSource } from "./imap";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import * as core from "@polaris/core";
import { refreshThreads } from "./sync";
import { rememberContacts } from "./contacts";
import { MailAuthError } from "./credentials";
import { readUpload, attachUploads } from "./uploads";
import { composeMime, sendMime, type OutgoingMessage } from "./send";
import { ACCOUNT_COLUMNS, MailAccessError, ownedAccount } from "./access";
import { addressesFrom, asJson, stringsFrom } from "./json";

/**
 * How long a sent message sits in the queue before it actually goes.
 *
 * Long enough to catch the two mistakes everybody makes - the wrong recipient
 * and the missing attachment - and short enough that nobody wonders whether it
 * sent. Every client that has this sets it around here.
 */
export const UNDO_WINDOW_MS = 10_000;

/** What the composer sends up. */
export interface ComposeInput {
    readonly accountId: string;
    readonly identityId: string | null;
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly bcc: readonly core.MailAddress[];
    readonly replyTo: string;
    readonly subject: string;
    readonly body: string;
    readonly attachmentIds: readonly string[];
    readonly inReplyToId: string | null;
    readonly forward: boolean;
    readonly sendAt: Date | null;
    readonly requestReceipt: boolean;
    readonly draftId: string | null;
}

/**
 * Write down what is being composed, without sending it.
 *
 * Called constantly - every few seconds while somebody types - so it is one
 * upsert and no server round trip. The copy on the mail server's own Drafts
 * folder is deliberately not written here: appending on every keystroke would
 * leave a trail of half-written messages in everybody's Drafts, which is what
 * clients that do it are complained about for. It is written when the composer
 * closes.
 */
export async function saveDraft(userId: string, input: ComposeInput): Promise<string> {
    await ownedAccount(userId, input.accountId);
    const ancestry = await ancestryFor(userId, input.inReplyToId);

    const data = {
        accountId: input.accountId,
        identityId: input.identityId,
        toJson: asJson(input.to),
        ccJson: asJson(input.cc),
        bccJson: asJson(input.bcc),
        subject: input.subject,
        body: input.body,
        replyTo: input.replyTo,
        inReplyToId: input.inReplyToId,
        inReplyToHeader: ancestry.inReplyTo,
        references: asJson(ancestry.references),
        forward: input.forward,
        requestReceipt: input.requestReceipt,
        state: "draft",
        failure: ""
    };

    const draft = input.draftId
        ? await prisma.mailDraft.update({
              where: { id: await ownedDraftId(userId, input.draftId) },
              data,
              select: { id: true }
          })
        : await prisma.mailDraft.create({ data, select: { id: true } });

    await attachUploads(userId, draft.id, input.attachmentIds);
    return draft.id;
}

/**
 * Put a message in the queue.
 *
 * Answers with the draft id, so the composer can offer Undo against it without
 * a second lookup, and with the moment it will actually go, so the screen can
 * count down rather than guess.
 */
export async function queueSend(
    userId: string,
    input: ComposeInput
): Promise<{ draftId: string; sendAt: Date }> {
    const draftId = await saveDraft(userId, input);
    const sendAt = input.sendAt ?? new Date(Date.now() + UNDO_WINDOW_MS);
    await prisma.mailDraft.update({
        where: { id: draftId },
        data: { state: "queued", sendAt, attempts: 0, failure: "" }
    });
    scheduleQueued(draftId, sendAt);
    publishMail({ accountId: input.accountId, kind: "sending", actorId: userId });
    return { draftId, sendAt };
}

/**
 * Take it back out of the queue.
 *
 * Only possible while it is still queued: a message being sent, or sent, is
 * somebody else's now. The screen stops offering Undo the moment the countdown
 * reaches zero for exactly this reason, and this refuses anyway, because the
 * screen's clock and this one's are not the same clock.
 */
export async function cancelSend(userId: string, draftId: string): Promise<boolean> {
    const id = await ownedDraftId(userId, draftId);
    const undone = await prisma.mailDraft.updateMany({
        where: { id, state: "queued" },
        data: { state: "draft", sendAt: null }
    });
    return undone.count > 0;
}

/** The draft, if it is on one of this person's mailboxes. */
async function ownedDraftId(userId: string, draftId: string): Promise<string> {
    const draft = await prisma.mailDraft.findFirst({
        where: { id: draftId, account: { userId } },
        select: { id: true }
    });
    if (!draft) throw new MailAccessError("That draft is not yours.");
    return draft.id;
}

/** The headers that keep a reply in its conversation. */
async function ancestryFor(
    userId: string,
    inReplyToId: string | null
): Promise<{ inReplyTo: string; references: string[] }> {
    if (!inReplyToId) return { inReplyTo: "", references: [] };
    const parent = await prisma.mailMessage.findFirst({
        where: { id: inReplyToId, account: { userId } },
        select: { messageId: true, references: true }
    });
    if (!parent?.messageId) return { inReplyTo: "", references: [] };
    const held = stringsFrom(parent.references).map(core.bareMessageId).filter(Boolean);
    return {
        inReplyTo: `<${parent.messageId}>`,
        // The whole chain, oldest first, with this message's own id last. A
        // client that drops the middle of it is what breaks a long thread in
        // everybody else's mailbox.
        references: [...held, parent.messageId].map((id) => `<${id}>`)
    };
}

/* -------------------------------------------------------------------------- */
/* Actually sending                                                            */
/* -------------------------------------------------------------------------- */

/** Timers for messages queued in this process. The sweep is the safety net; this
 *  is what makes a ten-second undo window feel like ten seconds. */
const TIMERS = Symbol.for("polaris.mail.timers");

function timers(): Map<string, NodeJS.Timeout> {
    const holder = globalThis as { [TIMERS]?: Map<string, NodeJS.Timeout> };
    if (!holder[TIMERS]) holder[TIMERS] = new Map();
    return holder[TIMERS];
}

/** Wake up for this one at its hour, where the hour is close enough to be worth
 *  holding a timer for. Anything further out is the sweep's. */
function scheduleQueued(draftId: string, sendAt: Date): void {
    const delay = sendAt.getTime() - Date.now();
    if (delay > 10 * 60 * 1000) return;
    const held = timers();
    clearTimeout(held.get(draftId));
    held.set(
        draftId,
        setTimeout(() => {
            held.delete(draftId);
            void deliverQueued(draftId).catch(() => undefined);
        }, Math.max(0, delay))
    );
}

/**
 * Send one queued message.
 *
 * The state moves to `sending` in a conditional update, which is what stops the
 * timer and the sweep both sending it: whichever gets there first is the one
 * that finds a row to move, and the other finds none.
 */
export async function deliverQueued(draftId: string): Promise<boolean> {
    const claimed = await prisma.mailDraft.updateMany({
        where: { id: draftId, state: "queued" },
        data: { state: "sending", attempts: { increment: 1 } }
    });
    if (claimed.count === 0) return false;

    const draft = await prisma.mailDraft.findUnique({
        where: { id: draftId },
        select: {
            id: true,
            accountId: true,
            subject: true,
            body: true,
            replyTo: true,
            toJson: true,
            ccJson: true,
            bccJson: true,
            inReplyToHeader: true,
            references: true,
            requestReceipt: true,
            identity: { select: { address: true, displayName: true, signature: true } },
            attachments: { select: { id: true } }
        }
    });
    if (!draft) return false;

    const account = await prisma.mailAccount.findUnique({
        where: { id: draft.accountId },
        select: { ...ACCOUNT_COLUMNS, user: { select: { name: true } } }
    });
    if (!account) return false;

    try {
        const attachments = [];
        for (const file of draft.attachments) {
            const held = await readUpload(account.userId, file.id);
            if (!held) continue;
            attachments.push({
                filename: held.name,
                contentType: held.contentType,
                content: held.bytes,
                ...(held.inline && held.contentId ? { cid: held.contentId } : {})
            });
        }

        const from: core.MailAddress = {
            name: draft.identity?.displayName || account.displayName || account.user.name,
            address: draft.identity?.address || account.address
        };
        const signature = draft.identity?.signature || account.signature;
        const message: OutgoingMessage = {
            from,
            to: addressesFrom(draft.toJson),
            cc: addressesFrom(draft.ccJson),
            bcc: addressesFrom(draft.bccJson),
            replyTo: draft.replyTo,
            subject: draft.subject,
            body: withSignature(draft.body, signature, account.signatureAboveQuote),
            attachments,
            inReplyTo: draft.inReplyToHeader,
            references: stringsFrom(draft.references),
            requestReceipt: draft.requestReceipt
        };

        const mime = await composeMime(message);
        await sendMime(account, message, mime);
        await fileInSent(account, mime);
        await rememberContacts(account.id, "sent", {
            from: [from],
            to: message.to,
            cc: message.cc
        });

        // Gone means gone: the row is the queue entry, not a record of what was
        // sent. What was sent is in the Sent folder, which is where somebody
        // looks for it.
        await prisma.mailDraft.delete({ where: { id: draft.id } });
        if (draft.inReplyToHeader) await markAnswered(account.id, draft.inReplyToHeader);
        await refreshThreads(account.id);
        publishMail({ accountId: account.id, kind: "sending", actorId: account.userId });
        return true;
    } catch (caught) {
        const auth = caught instanceof MailAuthError;
        await prisma.mailDraft.update({
            where: { id: draft.id },
            data: {
                state: "failed",
                // The two failures somebody can act on are said. Anything else is
                // the server having a bad day, and the queue will try again.
                failure: auth
                    ? caught.message
                    : "The outgoing server would not take this message. Polaris will try again."
            }
        });
        publishMail({ accountId: draft.accountId, kind: "sending", actorId: account.userId });
        return false;
    }
}

/**
 * Put the same bytes in Sent.
 *
 * Skipped where the service files its own copy - Gmail does, and appending a
 * second one is how a Gmail mailbox ends up with everything sent twice. Never
 * allowed to fail the send: the message has already gone, and telling somebody
 * it failed because a copy could not be filed would be a lie.
 */
async function fileInSent(
    account: MailConnectionSource & { id: string; appendToSent: boolean },
    mime: Buffer
): Promise<void> {
    if (!account.appendToSent) return;
    const sent = await prisma.mailFolder.findFirst({
        where: { accountId: account.id, role: "sent" },
        select: { path: true }
    });
    if (!sent) return;
    try {
        await withImap(account, async (client) => {
            await client.append(sent.path, mime, ["\\Seen"]);
        });
    } catch {
        /* the message is sent; the copy is a convenience */
    }
}

/** Mark the message this answered as answered, so the list draws the arrow. */
async function markAnswered(accountId: string, inReplyToHeader: string): Promise<void> {
    const messageId = core.bareMessageId(inReplyToHeader);
    if (!messageId) return;
    await prisma.mailMessage.updateMany({
        where: { accountId, messageId },
        data: { answered: true }
    });
}

/**
 * The signature, put where its owner wants it.
 *
 * Above the quoted history is what everybody expects; below is what a mailing
 * list expects, and the setting exists because both camps are certain. Nothing
 * else is ever added to a message here.
 */
function withSignature(body: string, signature: string, above: boolean): string {
    const trimmed = signature.trim();
    if (!trimmed) return body;
    // The two-hyphen line is the convention every client recognises as the start
    // of a signature, which is what lets them collapse it.
    const block = `-- \n${trimmed}`;
    const lines = body.split("\n");
    // Where the reply somebody wrote ends and the message they are replying to
    // begins: the attribution line the composer wrote, or failing that the first
    // quoted line. A message with no history has neither, and then both settings
    // put the signature in the same place - at the end.
    const quoteStart = above
        ? lines.findIndex((line) => line.startsWith(">") || /^On .* wrote:$/.test(line.trim()))
        : -1;
    if (quoteStart <= 0) return `${body}\n\n${block}`;
    return [...lines.slice(0, quoteStart), "", block, "", ...lines.slice(quoteStart)].join("\n");
}

/**
 * Everything whose hour has come, sent.
 *
 * The safety net for a restart, and what sends anything scheduled further out
 * than a timer was held for. A message that has failed several times is left
 * alone: the queue is not a place to hammer somebody's mail server from.
 */
export async function sweepDueSends(): Promise<number> {
    const due = await prisma.mailDraft.findMany({
        where: { state: { in: ["queued", "failed"] }, sendAt: { not: null, lte: new Date() }, attempts: { lt: 5 } },
        select: { id: true, state: true },
        orderBy: { sendAt: "asc" },
        take: 50
    });
    let sent = 0;
    for (const draft of due) {
        if (draft.state === "failed") {
            await prisma.mailDraft.update({ where: { id: draft.id }, data: { state: "queued" } });
        }
        if (await deliverQueued(draft.id)) sent += 1;
    }
    return sent;
}

/** One message somebody started and has not sent. */
export interface MailDraftView {
    readonly id: string;
    readonly accountId: string;
    readonly identityId: string | null;
    readonly to: readonly core.MailAddress[];
    readonly cc: readonly core.MailAddress[];
    readonly bcc: readonly core.MailAddress[];
    readonly subject: string;
    readonly body: string;
    readonly inReplyToId: string | null;
    readonly forward: boolean;
    /** Set only while it is waiting to go, which is what the Outbox shows. */
    readonly sendAt: string | null;
    readonly updatedAt: string;
}

/**
 * Everything this person has started and not sent.
 *
 * Polaris' own drafts rather than the Drafts folder on the mail server. They are
 * not the same thing and conflating them is what left this screen permanently
 * empty: the composer saves here as somebody types, and nothing has ever been
 * appended to the server's folder - so a draft was saved, was real, and could
 * not be reached from anywhere.
 */
export async function listDrafts(userId: string): Promise<MailDraftView[]> {
    const rows = await prisma.mailDraft.findMany({
        where: { account: { userId } },
        orderBy: { updatedAt: "desc" },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        identityId: row.identityId,
        to: addressesFrom(row.toJson),
        cc: addressesFrom(row.ccJson),
        bcc: addressesFrom(row.bccJson),
        subject: row.subject,
        body: row.body,
        inReplyToId: row.inReplyToId,
        forward: row.forward,
        sendAt: row.sendAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString()
    }));
}

/** Throw one away. Nothing was ever sent, so there is nothing to take back. */
export async function discardDraft(userId: string, draftId: string): Promise<void> {
    await prisma.mailDraft.deleteMany({ where: { id: draftId, account: { userId } } });
}
