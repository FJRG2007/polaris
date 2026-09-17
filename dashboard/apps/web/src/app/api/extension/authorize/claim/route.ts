/**
 * Asking where a connection request stands, and collecting it once approved.
 *
 * Answers 200 with a status while it is still waiting, because this is a poll
 * rather than an attempt: a refusal shape would have the extension treating "not
 * yet" as a failure. An approval is spent on the first claim, so the token is
 * handed over exactly once.
 */

import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit-service";
import { claimExtensionConnection } from "@/lib/extension/sessions";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A poll every couple of seconds for five minutes, with room for a retry. */
const LIMIT = 300;
const WINDOW_MS = 10 * 60 * 1000;

const claimSchema = z.object({ deviceCode: z.string().trim().min(16).max(256) });

export async function POST(request: Request): Promise<Response> {
    const throttle = await rateLimit(
        `extension-claim:${hashForLog(await clientIp()) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) {
        return Response.json({ error: "Too many requests from here." }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    const asked = claimSchema.safeParse(body);
    if (!asked.success) return Response.json({ error: "A device code is required." }, { status: 400 });

    const claim = await claimExtensionConnection(asked.data.deviceCode, {
        ip: (await clientIp()) ?? null,
        userAgent: (await clientUserAgent()) ?? null,
        host: (await clientHost()) ?? null
    });
    if (claim.status !== "approved") return Response.json({ status: claim.status });
    return Response.json({ status: "approved", token: claim.token, account: claim.account });
}
