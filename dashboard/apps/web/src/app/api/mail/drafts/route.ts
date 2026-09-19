/**
 * Write the draft being composed.
 *
 * Asked for a few seconds after typing stops, for as long as a composer is open,
 * so it is a route and not a server action: anything a tab sends on a timer must
 * not go through the router, which runs actions one at a time and can drop one
 * that is dispatched while a navigation is loading. See `outbox-answer`.
 */

import * as core from "@polaris/core";
import { saveDraft } from "@/lib/mailbox/compose";
import { apiPermission } from "@/lib/api-session";
import { answer, jsonBody, refusal } from "@/lib/mailbox/outbox-answer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = core.mailDraftSchema.safeParse(await jsonBody(request));
    if (!parsed.success) return answer({ error: "That draft could not be saved." }, 400);
    try {
        const draftId = await saveDraft(user.id, {
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
            draftId: parsed.data.id
        });
        return answer({ draftId });
    } catch (caught) {
        return refusal(caught, "That draft could not be saved.");
    }
}
