/**
 * The extension's answer to one command Polar sent its browser.
 *
 * Checked against the shared schema (`@polaris/core/browser-agent`) before it
 * is filed, and filed only under a command this same connection was handed:
 * another browser of the account, or one that guessed an id, gets a 404.
 */

import { readCappedBody } from "@/lib/request-body";
import { deliverResult } from "@/lib/polar/browser-relay";
import { browserAnswer } from "@polaris/core/browser-agent";
import { bearerToken, readExtensionToken } from "@/lib/extension/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A read is capped at 30,000 characters; this leaves room for the rest. */
const BODY_MOST = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearerToken(request));
    if (!principal) return Response.json({ error: "connection-ended" }, { status: 401 });

    const bytes = await readCappedBody(request, BODY_MOST);
    if (!bytes) return Response.json({ error: "too-large" }, { status: 413 });
    let raw: unknown;
    try {
        raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return Response.json({ error: "invalid" }, { status: 400 });
    }
    const answer = browserAnswer.safeParse(raw);
    if (!answer.success) return Response.json({ error: "invalid" }, { status: 400 });

    const filed = deliverResult(principal.userId, principal.id, answer.data.id, answer.data.result);
    if (!filed) return Response.json({ error: "not_found" }, { status: 404 });
    return new Response(null, { status: 204 });
}
