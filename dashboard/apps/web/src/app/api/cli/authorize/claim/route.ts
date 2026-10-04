/**
 * Asking where a CLI sign-in stands, and collecting it once approved.
 *
 * Answers 200 with a status while it is still waiting, because this is a poll
 * rather than an attempt (RFC 8628's `authorization_pending`). An approval is
 * spent on the first claim, so the credential is handed over exactly once.
 */

import { z } from "zod";
import { claimCliSignIn } from "@/lib/cli/sign-in";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A poll every couple of seconds for five minutes, with room for a retry. */
const LIMIT = 300;
const WINDOW_MS = 10 * 60 * 1000;

const claimSchema = z.object({ deviceCode: z.string().trim().min(16).max(256) });

export async function POST(request: Request): Promise<Response> {
    const throttle = await rateLimit(
        `cli-claim:${hashForLog(await clientIp()) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) {
        return Response.json(
            { error: "Too many requests. Wait a minute and run plr login again." },
            { status: 429 }
        );
    }

    const body = await request.json().catch(() => null);
    const asked = claimSchema.safeParse(body);
    if (!asked.success)
        return Response.json({ error: "A device code is required." }, { status: 400 });

    const claim = await claimCliSignIn(asked.data.deviceCode);
    if (claim.status !== "approved") return Response.json({ status: claim.status });
    return Response.json(
        {
            status: "approved",
            token: claim.token,
            keyId: claim.keyId,
            scopes: claim.scopes,
            account: claim.account
        },
        // A credential: nothing between here and the CLI may keep a copy.
        { headers: { "cache-control": "no-store" } }
    );
}
