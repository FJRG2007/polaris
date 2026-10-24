/**
 * What a delegate does in a mailbox lent to them beyond reading it
 * (`mail.mailbox` at `respond` or `manage` - see `./delegate`).
 *
 * Every function here asks the grant first (`requireDelegate`), narrows what
 * it was handed to the lent mailbox's inbox - the only part of it a delegate
 * sees - and only then runs the ordinary mail operation as the mailbox's
 * holder, because every one of those is narrowed to the holder already. So a
 * delegate never reaches a message, a folder or a mailbox the screen did not
 * show them, and taking the grant back stops the next call.
 *
 * A delegate's drafts are their own (`MailDraft.authorId`): written, queued,
 * retried and thrown away only by them, never listed to the holder, and the
 * grant is asked once more when the message actually goes (`deliverQueued`).
 * Every send and every action is written to the access log naming the
 * delegate, which is what the holder's Share dialog reads as activity.
 */

import { prisma } from "@polaris/db";
import { addressesFrom } from "./json";
import type { z } from "zod";
import type * as core from "@polaris/core";
import { actOnMessages } from "./messages";
import { MailAccessError } from "./access";
import { recordGrantUse } from "@/lib/access/grants";
import { inboxOf, requireDelegate } from "./delegate";
import { cancelSend, discardDraft, queueSend, retrySend } from "./compose";

/**
 * Do one thing to messages of the lent mailbox's inbox. Only `manage` reaches
 * it. Ids outside the inbox are dropped rather than refused, the same as the
 * holder's own bulk actions, so a stale row does not fail the other ninety.
 */
export async function delegateAct(
    userId: string,
    input: z.infer<typeof core.mailDelegateActionSchema>
): Promise<number> {
    const { holderId, grantId } = await requireDelegate(userId, input.accountId, "manage");
    const inboxId = await inboxOf(input.accountId);
    if (!inboxId) return 0;
    const inside = await prisma.mailMessage.findMany({
        where: {
            id: { in: [...input.messageIds] },
            accountId: input.accountId,
            folderId: inboxId,
            deleted: false,
            draft: false
        },
        select: { id: true },
        take: input.messageIds.length
    });
    if (inside.length === 0) return 0;
    const ids = inside.map((row) => row.id);
    const done = await actOnMessages(holderId, ids, input.action, { strict: true });
    for (const id of ids) {
        await recordGrantUse({
            grantId,
            subjectType: "mail.mailbox",
            subjectId: input.accountId,
            targetType: "mail.message",
            targetId: id,
            userId,
            action: input.action,
            outcome: "done"
        });
    }
    return done;
}

/**
 * Put a message written by a delegate in the queue, from the lent mailbox's
 * own address. Only `respond` and above. A reply must answer a message of the
 * inbox the delegate can see; the From line is the mailbox's, and the Sender
 * is decided when it goes.
 */
export async function delegateSend(
    userId: string,
    input: core.MailDelegateCompose
): Promise<{ draftId: string; sendAt: Date }> {
    const { holderId } = await requireDelegate(userId, input.accountId, "respond");
    if (input.inReplyToId) {
        const inboxId = await inboxOf(input.accountId);
        const parent = inboxId
            ? await prisma.mailMessage.findFirst({
                  where: {
                      id: input.inReplyToId,
                      accountId: input.accountId,
                      folderId: inboxId,
                      deleted: false,
                      draft: false
                  },
                  select: { id: true }
              })
            : null;
        if (!parent) throw new MailAccessError();
    }
    return queueSend(
        holderId,
        {
            accountId: input.accountId,
            identityId: null,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            replyTo: "",
            subject: input.subject,
            body: input.body,
            attachmentIds: [],
            inReplyToId: input.inReplyToId,
            forward: false,
            sendAt: null,
            requestReceipt: false,
            draftId: input.draftId
        },
        userId
    );
}

/** One message a delegate wrote from a lent mailbox and has not seen go. */
export interface DelegateDraft {
    readonly id: string;
    readonly subject: string;
    readonly to: string[];
    readonly state: string;
    readonly failure: string;
    readonly permanent: boolean;
    readonly sendAt: Date | null;
    readonly updatedAt: Date;
}

/** This delegate's own unsent messages on one lent mailbox, newest first. Any
 *  level: a delegate who lost `respond` still sees what did not go. */
export async function delegateDrafts(userId: string, accountId: string): Promise<DelegateDraft[]> {
    await requireDelegate(userId, accountId, "view");
    const rows = await prisma.mailDraft.findMany({
        where: { accountId, authorId: userId, probe: false },
        select: {
            id: true,
            subject: true,
            toJson: true,
            state: true,
            failure: true,
            permanent: true,
            sendAt: true,
            updatedAt: true
        },
        orderBy: { updatedAt: "desc" },
        take: 50
    });
    return rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        to: addressesFrom(row.toJson).map((entry) => entry.address),
        state: row.state,
        failure: row.failure,
        permanent: row.permanent,
        sendAt: row.sendAt,
        updatedAt: row.updatedAt
    }));
}

/** Undo a delegate's send while it waits. Their own draft only. */
export async function delegateCancel(
    userId: string,
    accountId: string,
    draftId: string
): Promise<boolean> {
    const { holderId } = await requireDelegate(userId, accountId, "view");
    return cancelSend(holderId, draftId, userId);
}

/** Try a delegate's refused message again. Sending needs `respond`. */
export async function delegateRetry(
    userId: string,
    accountId: string,
    draftId: string
): Promise<boolean> {
    const { holderId } = await requireDelegate(userId, accountId, "respond");
    return retrySend(holderId, draftId, userId);
}

/** Throw a delegate's own draft away. Any level, so losing `respond` never
 *  leaves them unable to clear what they wrote. */
export async function delegateDiscard(
    userId: string,
    accountId: string,
    draftId: string
): Promise<void> {
    const { holderId } = await requireDelegate(userId, accountId, "view");
    await discardDraft(holderId, draftId, userId);
}
