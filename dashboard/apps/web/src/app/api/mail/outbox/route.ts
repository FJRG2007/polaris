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
import { queueSend, queueSendOnce, SendInProgressError } from "@/lib/mailbox/compose";
import { apiPermission } from "@/lib/api-session";
import { answer, jsonBody, refusal } from "@/lib/mailbox/outbox-answer";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = core.mailComposeSchema.safeParse(await jsonBody(request));
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return answer(
            {
                error: issue?.message ?? (await readerWords("api"))("errors.checkMessage"),
                field: String(issue?.path[0] ?? "")
            },
            400
        );
    }
    try {
        const input = {
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
            draftId: parsed.data.draftId,
            reaction: parsed.data.reaction
        };
        const queued = parsed.data.sendKey
            ? await queueSendOnce(user.id, input, parsed.data.sendKey)
            : await queueSend(user.id, input);
        return answer({ draftId: queued.draftId, sendAt: queued.sendAt.toISOString() });
    } catch (caught) {
        // Its first attempt is still being taken: asked again in a moment.
        if (caught instanceof SendInProgressError) return answer({ error: "" }, 409);
        return refusal(caught, "That message could not be sent.");
    }
}
