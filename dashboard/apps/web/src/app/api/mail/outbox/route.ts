/**
 * Send a message: put it in the queue.
 *
 * Nothing is sent here. The draft is written with an hour on it and the queue
 * takes it when the hour comes - see `lib/mailbox/compose`, where Undo and Send
 * now are the same row with its hour cleared or moved. A route rather than a
 * server action for the reason in `outbox-answer`: the composer must never wait
 * on the router.
 */

import * as core from "@polaris/core";
import { queueSend } from "@/lib/mailbox/compose";
import { apiPermission } from "@/lib/api-session";
import { answer, jsonBody, refusal } from "@/lib/mailbox/outbox-answer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = core.mailComposeSchema.safeParse(await jsonBody(request));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return answer(
            { error: issue?.message ?? "Check the message.", field: String(issue?.path[0] ?? "") },
            400
        );
    }
    try {
        const queued = await queueSend(user.id, {
            accountId: parsed.data.accountId,
            identityId: parsed.data.identityId,
            to: parsed.data.to,
            cc: parsed.data.cc,
            bcc: parsed.data.bcc,
            replyTo: parsed.data.replyTo,
            subject: parsed.data.subject,
            body: parsed.data.body,
            attachmentIds: parsed.data.attachmentIds,
            inReplyToId: parsed.data.inReplyToId,
            forward: parsed.data.forward,
            sendAt: parsed.data.sendAt,
            requestReceipt: parsed.data.requestReceipt,
            draftId: parsed.data.draftId
        });
        return answer({ draftId: queued.draftId, sendAt: queued.sendAt.toISOString() });
    } catch (caught) {
        return refusal(caught, "That message could not be sent.");
    }
}
