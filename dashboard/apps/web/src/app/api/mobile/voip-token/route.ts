/**
 * An iPhone running the Polaris app registers the token Apple rings it on.
 *
 * Sent by the app whenever PushKit hands it a token and whenever it signs in to
 * another account, so a call to this account rings that phone with the app
 * closed (`lib/mobile/voip-push`). DELETE forgets it, for signing out.
 */

import { apiPermission } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { sameOrigin } from "@/lib/same-origin";
import { forgetVoipToken, registerVoipToken, voipTokenSchema } from "@/lib/mobile/voip-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request, register: boolean): Promise<Response> {
    // Only the app (or a page of this Polaris) may point a phone at an account:
    // another site's request would have a phone ring for somebody else's calls.
    // i18n-ignore: a status body no screen shows
    if (!sameOrigin(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const allowed = await rateLimit(`mobile-voip-token:${user.id}`, 30, 60_000);
    // i18n-ignore: a status body no screen shows
    if (!allowed.ok) return Response.json({ error: "Too many requests" }, { status: 429 });
    const input = voipTokenSchema.safeParse(await request.json().catch(() => null));
    // i18n-ignore: as above
    if (!input.success) return Response.json({ error: "Bad request" }, { status: 400 });
    if (register) await registerVoipToken(user.id, input.data.token);
    else await forgetVoipToken(user.id, input.data.token);
    return new Response(null, { status: 204 });
}

export function POST(request: Request): Promise<Response> {
    return handle(request, true);
}

export function DELETE(request: Request): Promise<Response> {
    return handle(request, false);
}
