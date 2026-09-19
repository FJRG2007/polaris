/**
 * What the composer's endpoints read and answer.
 *
 * Writing a draft, queueing a message, taking it back and sending it at once are
 * routes rather than server actions, and the reason is the router. A server
 * action is a POST the router owns: it runs them one at a time, a navigation
 * supersedes the one in flight, and one dispatched while that navigation is
 * still loading can be dropped and never answer at all. The composer awaited
 * those inside a transition, which is what every link in Polaris waits behind -
 * so a lost answer was a screen where no link worked until a reload. A `fetch`
 * belongs to nobody but the composer, and always answers.
 */

import { NextResponse } from "next/server";
import { MailAccessError } from "./access";

const NO_STORE = { "cache-control": "private, no-store" } as const;

/** An answer that nothing in between may keep. */
export function answer(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * The request's JSON body, or null.
 *
 * Only a body that says it is JSON is read. That is the part that matters for
 * who may send it: a page on another site can post a form here without asking,
 * but it cannot send `application/json` without the browser asking this server
 * first, and this server never says yes.
 */
export async function jsonBody(request: Request): Promise<unknown> {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().startsWith("application/json")) return null;
    return request.json().catch(() => null);
}

/**
 * A refusal the writer can act on, or a fault that is logged and not described.
 *
 * Somebody else's draft or mailbox answers exactly as one that is not there.
 * Anything else can name a host or a credential, so it stays in the log.
 */
export function refusal(caught: unknown, fallback: string): NextResponse {
    if (caught instanceof MailAccessError) return answer({ error: caught.message }, 404);
    console.error("polaris: a mail send request failed:", caught);
    return answer({ error: fallback }, 500);
}
