/**
 * POST /api/deck/authorize - the Stream Deck plugin asking to be connected.
 *
 * The CLI's device-authorization exchange (`/api/cli/authorize`) with the
 * deck's own closed list of scopes and its own approval screen. What it
 * becomes, once approved and claimed at `/api/deck/authorize/claim`, is an API
 * key of kind "streamdeck".
 */

import { z } from "zod";
import { openCliSignIn } from "@/lib/cli/sign-in";
import { rateLimit } from "@/lib/rate-limit-service";
import { readerWords } from "@/lib/i18n/reader-words";
import { DECK_SCOPES, deckApprovePath } from "@/lib/deck/scopes";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many requests one address may open. Enough for somebody retrying, far
 *  short of filling the table with codes. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

const askSchema = z.object({
    /** The computer's name, as the plugin read it. Shown on the approval screen. */
    deviceName: z.string().trim().min(1).max(80),
    clientVersion: z
        .string()
        .trim()
        .max(40)
        .regex(/^[0-9A-Za-z.+-]+$/)
        .optional(),
    /** What it wants to be allowed to do; every deck scope when it does not say. */
    scopes: z
        .array(z.enum(DECK_SCOPES))
        .min(1)
        .max(DECK_SCOPES.length)
        .transform((values) => [...new Set(values)])
        .default([...DECK_SCOPES])
});

function refusal(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const ip = await clientIp();
    const throttle = await rateLimit(
        `deck-authorize:${hashForLog(ip) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok) return refusal((await readerWords("api"))("errors.cliSignInsThrottled"), 429);

    const body = await request.json().catch(() => null);
    const asked = askSchema.safeParse(body);
    if (!asked.success) return refusal((await readerWords("api"))("errors.deckSignInAsk"));

    const opened = await openCliSignIn(
        {
            deviceName: asked.data.deviceName,
            clientVersion: asked.data.clientVersion ?? null,
            scopes: asked.data.scopes,
            kind: "streamdeck",
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
        // Paths rather than addresses: the plugin joins them to the address it
        // was given, which is the one the person can open.
        verificationPath: "/account/streamdeck",
        approvePath: deckApprovePath(opened.userCode)
    });
}
