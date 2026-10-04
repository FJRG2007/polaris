/**
 * The command-line client asking to be signed in to an account (`plr login`).
 *
 * Unauthenticated by nature: nobody has said who they are yet. What comes back
 * is a short code the CLI shows, a secret it polls with, and the screen where
 * somebody signed in answers it - none of it worth anything until they approve.
 * The same device-authorization exchange as the extension's
 * (`/api/extension/authorize`), with the scopes the CLI wants named up front so
 * the approval screen can show them.
 */

import { z } from "zod";
import { openCliSignIn } from "@/lib/cli/sign-in";
import { rateLimit } from "@/lib/rate-limit-service";
import { CLI_SCOPES, cliApprovePath } from "@/lib/cli/scopes";
import { clientHost, clientIp, clientUserAgent, hashForLog } from "@/lib/request-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many requests one address may open. Enough for somebody retrying, far
 *  short of filling the table with codes. */
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

const askSchema = z.object({
    /** The machine's name, as the CLI read it. Shown on the approval screen. */
    deviceName: z.string().trim().min(1).max(80),
    clientVersion: z
        .string()
        .trim()
        .max(40)
        .regex(/^[0-9A-Za-z.+-]+$/)
        .optional(),
    /** What it wants to be allowed to do; every CLI scope when it does not say. */
    scopes: z
        .array(z.enum(CLI_SCOPES))
        .min(1)
        .max(CLI_SCOPES.length)
        .transform((values) => [...new Set(values)])
        .default([...CLI_SCOPES])
});

function refusal(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
}

export async function POST(request: Request): Promise<Response> {
    const ip = await clientIp();
    const throttle = await rateLimit(
        `cli-authorize:${hashForLog(ip) ?? "unknown"}`,
        LIMIT,
        WINDOW_MS
    );
    if (!throttle.ok)
        return refusal(
            "Too many sign-in requests from here. Wait a few minutes and try again.",
            429
        );

    const body = await request.json().catch(() => null);
    const asked = askSchema.safeParse(body);
    if (!asked.success)
        return refusal("A device name is required, and only deploy scopes can be asked for.");

    const opened = await openCliSignIn(
        {
            deviceName: asked.data.deviceName,
            clientVersion: asked.data.clientVersion ?? null,
            scopes: asked.data.scopes,
            requestIp: ip ?? null,
            requestUserAgent: (await clientUserAgent()) ?? null,
            requestHost: (await clientHost()) ?? null
        },
        (size) => crypto.getRandomValues(new Uint8Array(size))
    );
    if (!opened) return refusal("Could not start a sign-in just now. Try again.", 503);

    return Response.json({
        userCode: opened.userCode,
        deviceCode: opened.deviceCode,
        expiresAt: opened.expiresAt.toISOString(),
        pollMs: opened.pollMs,
        // Paths rather than addresses: the CLI joins them to the address it was
        // given, which is the one the person can open.
        verificationPath: "/account/cli",
        approvePath: cliApprovePath(opened.userCode)
    });
}
