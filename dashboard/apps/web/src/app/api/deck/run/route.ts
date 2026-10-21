/**
 * POST /api/deck/run - a key was pressed or a dial turned.
 *
 * The body names the action and its settings. Unknown actions, actions the key
 * may not use and settings that do not parse are all a 4xx with a sentence for
 * the inspector; what the action itself refuses comes back the same way.
 */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { deckCaller, deckWords } from "@/lib/deck/auth";
import { deckRunSchema, runDeckAction } from "@/lib/deck/deck-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await deckCaller(request, "call");
    if (caller instanceof Response) return caller;
    const words = deckWords(caller);

    const body = await request.json().catch(() => null);
    const asked = deckRunSchema.safeParse(body);
    if (!asked.success) {
        return Response.json(
            { ok: false, message: words("deck.errors.badRequest") },
            { status: 400 }
        );
    }

    const result = await runDeckAction(caller, asked.data, words);
    return Response.json(result, {
        status: result.ok ? 200 : 422,
        headers: { "cache-control": "no-store" }
    });
});
