/**
 * POST /api/computers/pair - a runner on somebody's computer trading the
 * pairing code its owner was shown for its own credential.
 *
 * Public: the code is the whole proof. It was opened by somebody signed in,
 * lives ten minutes, is spent by the first collection, and this route is rate
 * limited per address, so guessing one is not a way in. The credential is
 * handed over exactly once and stored only as a hash. See
 * `lib/computers/computer-service.ts` and `docs/runner-protocol.md`.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { claimPairing, computerNameSchema } from "@/lib/computers/computer-service";
import { readUserCode } from "@/lib/device-code";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    code: z.string().max(20),
    name: computerNameSchema
});

export async function POST(request: Request): Promise<Response> {
    const ip = await clientIp();
    const throttle = await rateLimit(`computer-pair:${hashForLog(ip) ?? "unknown"}`, 10, 10 * 60_000);
    if (!throttle.ok)
        return Response.json(
            // i18n-ignore read by the runner, which shows its own words
            { error: "rate_limited" },
            { status: 429, headers: { "retry-after": String(Math.ceil(throttle.retryAfterMs / 1000)) } }
        );
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    const code = parsed.success ? readUserCode(parsed.data.code) : null;
    // i18n-ignore read by the runner, which shows its own words
    if (!parsed.success || !code) return Response.json({ error: "invalid_request" }, { status: 400 });
    const claimed = await claimPairing({ code, name: parsed.data.name });
    // i18n-ignore read by the runner, which shows its own words
    if (!claimed) return Response.json({ error: "invalid_code" }, { status: 400 });
    return Response.json(
        {
            runnerId: claimed.runnerId,
            token: claimed.token,
            socketPath: core.RUNNER_SOCKET_PATH,
            protocol: core.RUNNER_PROTOCOL_VERSION
        },
        { headers: { "cache-control": "no-store" } }
    );
}
