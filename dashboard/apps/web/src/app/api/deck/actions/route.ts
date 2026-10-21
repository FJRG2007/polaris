/**
 * GET /api/deck/actions - what this deck may put on a key.
 *
 * Already narrowed to the key's scopes (themselves narrowed to what its owner
 * holds right now) and to the apps installed, in the owner's language. The
 * plugin draws its picker from this and nothing else.
 */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { deckCatalogue } from "@/lib/deck/deck-service";
import { deckCaller, deckWords } from "@/lib/deck/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await deckCaller(request, "call");
    if (caller instanceof Response) return caller;
    const actions = await deckCatalogue(caller, deckWords(caller));
    return Response.json({ actions }, { headers: { "cache-control": "no-store" } });
});
