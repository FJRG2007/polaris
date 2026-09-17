/**
 * A browser extension asking to be connected to an account.
 *
 * Unauthenticated by nature: nobody has said who they are yet. What comes back
 * is a short code the extension shows and a secret it polls with, and neither is
 * worth anything until somebody signed in to Polaris approves it on
 * `/account/extension`.
 *
 * The extension reaches this from a background worker on an origin it holds a
 * permission for, so there is no preflight to answer and no cookie in play - the
 * whole exchange is the body and what the request itself says about its sender.
 */

import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit-service";
import { openExtensionConnection } from "@/lib/extension/sessions";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many requests one address may open. Enough for somebody retrying, far
 *  short of filling the table with codes. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

const askSchema = z.object({
    /** The extension's own id for this install. Capped rather than shaped: it is
     *  the extension's to choose and means nothing here beyond telling two
     *  installs apart. */
    deviceId: z.string().trim().min(8).max(128),
    deviceName: z.string().trim().min(1).max(120)
});

function refusal(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const ip = await clientIp();
    const throttle = await rateLimit(
        `extension-authorize:${hashForLog(ip) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) return refusal("Too many requests from here. Try again shortly.", 429);

    const body = await request.json().catch(() => null);
    const asked = askSchema.safeParse(body);
    if (!asked.success) return refusal("An extension id and a name are required.");

    const opened = await openExtensionConnection(
        {
            deviceId: asked.data.deviceId,
            deviceName: asked.data.deviceName,
            // Read off the request rather than taken from the body: what the
            // approval screen shows must not be something the asker wrote.
            requestIp: ip ?? null,
            requestUserAgent: (await clientUserAgent()) ?? null,
            requestHost: (await clientHost()) ?? null
        },
        (size) => crypto.getRandomValues(new Uint8Array(size))
    );
    if (!opened) return refusal("Could not start a request just now. Try again.");

    return Response.json({
        userCode: opened.userCode,
        deviceCode: opened.deviceCode,
        expiresAt: opened.expiresAt.toISOString(),
        pollMs: opened.pollMs,
        // Where somebody goes to answer it. Sent rather than built by the
        // extension so the address stays this deployment's to decide.
        approveUrl: `/account/extension?code=${opened.userCode}`
    });
}
