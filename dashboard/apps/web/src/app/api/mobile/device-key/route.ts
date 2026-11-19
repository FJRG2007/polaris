/**
 * A phone running the Polaris app says which key it signs with.
 *
 * The private half never leaves the phone's keystore; this keeps the public
 * one, for this account, so a view-once file can be handed to a request that
 * phone signed (`lib/chat/view-once`). Sent again before every open: it is an
 * upsert, and it is how a phone that changed accounts moves its key along.
 */

import { apiPermission } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { deviceKeySchema, registerDeviceKey } from "@/lib/chat/view-once";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const allowed = await rateLimit(`mobile-device-key:${user.id}`, 30, 60_000);
    if (!allowed.ok) {
        return Response.json({ error: (await readerWords("chat"))("viewOnce.tooMany") }, { status: 429 });
    }
    const input = deviceKeySchema.safeParse(await request.json().catch(() => null));
    if (!input.success || !(await registerDeviceKey(user.id, input.data.publicKey, input.data.platform))) {
        return Response.json({ error: (await readerWords("chat"))("viewOnce.refused.device") }, { status: 400 });
    }
    return new Response(null, { status: 204 });
}
