/**
 * The extension waiting for something Polar wants done in its browser.
 *
 * Held open for up to `POLL_HOLD_MS`: 200 with one command as soon as Polar has
 * one for this account, 204 when the hold ran out with nothing. The extension
 * polls again straight away either way, which is also what tells Polar the
 * browser is there (`lib/polar/browser-relay.ts`). Proves itself with the
 * connection's token, like every other extension call, and an account Polar is
 * not for gets the same 403 the dashboard would give it.
 *
 * `x-polar-sites` carries the sites the person allowed "always" in that
 * browser, comma-separated, so the chat does not ask again for one of them.
 * Anything that is not a bare site is dropped.
 */

import { polarAccessFor } from "@/lib/polar/access";
import { nextCommand, noteSites, sitesHeader } from "@/lib/polar/browser-relay";
import { bearerToken, readExtensionToken } from "@/lib/extension/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearerToken(request));
    if (!principal) return Response.json({ error: "connection-ended" }, { status: 401 });
    const allowed = await polarAccessFor(principal.userId)
        .then((access) => access.use)
        .catch(() => false);
    if (!allowed) return Response.json({ error: "polar-off" }, { status: 403 });

    noteSites(principal.id, sitesHeader(request.headers.get("x-polar-sites")));
    const envelope = await nextCommand(principal.userId, principal.id, undefined, request.signal);
    if (!envelope) return new Response(null, { status: 204 });
    return Response.json(envelope, { headers: { "cache-control": "no-store" } });
}
