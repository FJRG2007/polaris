/**
 * DELETE /api/tv/session - a TV disconnecting itself. Only a TV's own key can end
 * itself here.
 */

import { revokeApiKey } from "@polaris/auth";
import { tvCaller } from "@/lib/tv/auth";
import { recordAudit } from "@/lib/audit-service";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    await revokeApiKey(caller.userId, caller.keyId);
    await recordAudit({
        actorId: caller.userId,
        action: "account.tv.disconnected",
        targetType: "apiKey",
        targetId: caller.keyId
    });
    return new Response(null, { status: 204 });
});
