/**
 * DELETE /api/deck/session - a deck disconnecting itself.
 *
 * The plugin's Disconnect: the key it presents is revoked, the same as the
 * Disconnect on the Downloads screen. Only a deck's own key can end itself
 * here; any other key is refused and left alone.
 */

import { revokeApiKey } from "@polaris/auth";
import { deckCaller } from "@/lib/deck/auth";
import { recordAudit } from "@/lib/audit-service";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await deckCaller(request, "call");
    if (caller instanceof Response) return caller;
    await revokeApiKey(caller.userId, caller.keyId);
    await recordAudit({
        actorId: caller.userId,
        action: "account.streamdeck.disconnected",
        targetType: "apiKey",
        targetId: caller.keyId
    });
    return new Response(null, { status: 204 });
});
