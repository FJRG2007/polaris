/**
 * One queued message: send it now, or take it back.
 *
 * POST skips what is left of the wait; DELETE is Undo. Both only work while the
 * message is still in the queue, and both answer with whether they did - a
 * message that has already gone is not an error, it is the answer "too late".
 */

import * as core from "@polaris/core";
import { apiPermission } from "@/lib/api-session";
import { cancelSend, sendNow } from "@/lib/mailbox/compose";
import { answer, refusal } from "@/lib/mailbox/outbox-answer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ draftId: string }> };

/** The draft named in the address, if it is a draft id at all. */
async function draftIdOf(params: Params["params"]): Promise<string | null> {
    const parsed = core.mailDraftIdSchema.safeParse((await params).draftId);
    return parsed.success ? parsed.data : null;
}

export async function POST(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const draftId = await draftIdOf(params);
    if (!draftId) return answer({ error: "That message is not in the queue." }, 404);
    try {
        return answer({ sent: await sendNow(user.id, draftId) });
    } catch (caught) {
        return refusal(caught, "That message could not be sent now.");
    }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const draftId = await draftIdOf(params);
    if (!draftId) return answer({ error: "That message is not in the queue." }, 404);
    try {
        return answer({ undone: await cancelSend(user.id, draftId) });
    } catch (caught) {
        return refusal(caught, "That message has already gone.");
    }
}
