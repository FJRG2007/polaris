/**
 * The sending check: start one, and ask where it got to.
 *
 * A route rather than a server action for the reason in `outbox-answer`: the
 * screen asks for this once per mailbox on load and then again every few seconds
 * while a check is in flight, and the router runs server actions one at a time -
 * so a settings page with three mailboxes would queue its own navigation behind
 * them.
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { readSendCheck, startSendCheck } from "@/lib/mailbox/selftest";
import { answer, jsonBody, refusal } from "@/lib/mailbox/outbox-answer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The mailbox, and nothing else. Which mailboxes are this caller's is decided
 *  in the service, never here. */
const askSchema = z.object({ accountId: z.string().uuid() });

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = askSchema.safeParse({
        accountId: new URL(request.url).searchParams.get("accountId") ?? ""
    });
    if (!parsed.success) return answer({ error: "That mailbox is not one of yours." }, 400);
    try {
        return answer(await readSendCheck(user.id, parsed.data.accountId));
    } catch (caught) {
        return refusal(caught, "That check could not be read.");
    }
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const parsed = askSchema.safeParse(await jsonBody(request));
    if (!parsed.success) return answer({ error: "That mailbox is not one of yours." }, 400);
    try {
        return answer(await startSendCheck(user.id, parsed.data.accountId));
    } catch (caught) {
        return refusal(caught, "That check could not be started.");
    }
}
