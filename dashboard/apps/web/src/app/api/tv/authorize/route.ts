/**
 * POST /api/tv/authorize - Polaris TV asking to be connected.
 *
 * The CLI's device-authorization exchange with an approval screen of its own.
 * What it becomes, once approved and claimed at `/api/tv/authorize/claim`, is an
 * API key of kind "tv" with no scopes.
 */

import { z } from "zod";
import { tvApprovePath } from "@/lib/tv/scopes";
import { openCliSignIn } from "@/lib/cli/sign-in";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many requests one address may open. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

const askSchema = z.object({
    /** The set's make and model, as it reports them. Shown on the approval screen. */
    deviceName: z.string().trim().min(1).max(80),
    clientVersion: z
        .string()
        .trim()
        .max(40)
        .regex(/^[0-9A-Za-z.+-]+$/)
        .optional()
});

function refusal(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const ip = await clientIp();
    const throttle = await rateLimit(
        `tv-authorize:${hashForLog(ip) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) return refusal((await readerWords("api"))("errors.cliSignInsThrottled"), 429);

    const asked = askSchema.safeParse(await request.json().catch(() => null));
    if (!asked.success) return refusal((await readerWords("api"))("errors.tvSignInAsk"));

    const opened = await openCliSignIn(
        {
            deviceName: asked.data.deviceName,
            clientVersion: asked.data.clientVersion ?? null,
            scopes: [],
            kind: "tv",
            requestIp: ip ?? null,
            requestUserAgent: (await clientUserAgent()) ?? null,
            requestHost: (await clientHost()) ?? null
        },
        (size) => crypto.getRandomValues(new Uint8Array(size))
    );
    if (!opened) return refusal((await readerWords("api"))("errors.cliSignInUnavailable"), 503);

    return Response.json({
        userCode: opened.userCode,
        deviceCode: opened.deviceCode,
        expiresAt: opened.expiresAt.toISOString(),
        pollMs: opened.pollMs,
        verificationPath: "/account/tv",
        approvePath: tvApprovePath(opened.userCode)
    });
}
