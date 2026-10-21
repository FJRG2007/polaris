/**
 * GET /api/deck/state?watch=<base64url JSON> - live state for a deck's keys.
 *
 * `watch` is the list of keys on the deck: each one's own id, its action and
 * its settings (see `deckWatchSchema`). A server-sent event stream; see
 * `deckStateStream` for what it sends and when.
 */

import { deckCaller, deckWords } from "@/lib/deck/auth";
import { readWatch } from "@/lib/deck/deck-service";
import { deckStateStream } from "@/lib/deck/state-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const caller = await deckCaller(request, "stream");
    if (caller instanceof Response) return caller;
    const words = deckWords(caller);

    const watched = readWatch(new URL(request.url).searchParams.get("watch"));
    if (!watched) return Response.json({ error: words("deck.errors.badRequest") }, { status: 400 });

    return new Response(deckStateStream(caller, watched, words, request.signal), {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no"
        }
    });
}
