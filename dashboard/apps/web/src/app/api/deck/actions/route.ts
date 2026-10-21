/**
 * GET /api/deck/actions - what this deck may put on a key.
 *
 * Already narrowed to the key's scopes (themselves narrowed to what its owner
 * holds right now) and to the apps installed, in the owner's language. The
 * plugin draws its picker from this and nothing else.
 *
 * It also carries the newest released plugin and Companion module, so a copy
 * installed from a file - which never updates itself - can say a newer one is
 * on the Downloads screen. Asked of this Polaris rather than of GitHub, so a
 * deck never needs to reach anything but the server it is signed in to.
 */

import { loadEnv } from "@polaris/config";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { deckReleases } from "@/lib/deck/releases";
import { deckCatalogue } from "@/lib/deck/deck-service";
import { deckCaller, deckWords } from "@/lib/deck/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await deckCaller(request, "call");
    if (caller instanceof Response) return caller;
    const [actions, latest] = await Promise.all([
        deckCatalogue(caller, deckWords(caller)),
        deckReleases(loadEnv().POLARIS_REPO)
    ]);
    return Response.json({ actions, latest }, { headers: { "cache-control": "no-store" } });
});
