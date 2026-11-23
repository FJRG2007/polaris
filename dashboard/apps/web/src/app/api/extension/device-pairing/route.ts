/**
 * The extension asking for a nonce to hand Polaris Desktop, so its connection
 * can be proven to run on the same computer (`lib/device-sessions/device-pairing`).
 *
 * Proves itself with its own token, like every extension call. Answers
 * `{ paired: true }` once the connection holds a device key, which is what
 * tells the extension to stop asking. Rate limited per connection.
 */

import { z } from "zod";
import { CHROMIUM_EXTENSION_ID_PATTERN } from "@polaris/core";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientHost, clientIp, clientUserAgent } from "@/lib/request-context";
import { bearerToken, readExtensionToken } from "@/lib/extension/sessions";
import { offerPairing } from "@/lib/device-sessions/device-pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;

const askSchema = z.object({
    runtimeId: z.string().trim().regex(CHROMIUM_EXTENSION_ID_PATTERN).nullish()
});

export async function POST(request: Request): Promise<Response> {
    const principal = await readExtensionToken(bearerToken(request), {
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null,
        host: (await clientHost()) ?? null
    });
    if (!principal) return Response.json({ error: "connection-ended" }, { status: 401 });

    const asked = askSchema.safeParse(await request.json().catch(() => null));
    if (!asked.success) return Response.json({ error: "bad-request" }, { status: 400 });

    const throttle = await rateLimit(`extension-device-pairing:${principal.id}`, LIMIT, WINDOW_MS);
    if (!throttle.ok) return Response.json({ error: "rate-limited" }, { status: 429 });

    const offer = await offerPairing(principal, asked.data.runtimeId ?? null);
    return Response.json(
        offer.paired ? { paired: true } : { paired: false, nonce: offer.nonce, expiresAt: offer.expiresAt.toISOString() },
        { headers: { "Cache-Control": "no-store" } }
    );
}
