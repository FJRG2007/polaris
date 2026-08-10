/**
 * Who may trigger scheduled work from outside.
 *
 * Polaris runs its own schedule now, so these routes are the optional half: an
 * operator who would rather drive it from their own cron, and the installers
 * that already do. The contract is the one they were written against and does not
 * change - a bearer token, or an `x-cron-key` header - so nothing anybody already
 * has stops working.
 *
 * Six routes used to carry their own copy of this, each comparing the token with
 * `!==`. That leaks the secret a character at a time to anybody willing to time
 * the responses, which is worth nothing on a LAN and quite a lot on an instance
 * published to the internet. Compared here once, on digests so the comparison is
 * over two buffers of equal length whatever was presented.
 */

import { loadEnv } from "@polaris/config";
import { createHash, timingSafeEqual } from "node:crypto";

/** The token the caller presented, in either of the two shapes accepted. */
export function presentedToken(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return request.headers.get("x-cron-key")?.trim() ?? "";
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value).digest();
}

/**
 * Whether this request may run scheduled work, or the response to send back
 * instead.
 *
 * An instance with no secret set refuses rather than opening: unset must never
 * come to mean "no password needed". It is not a problem the way it once was -
 * the schedule runs regardless now - so it stays a 503 saying only this door is
 * shut.
 */
export function authorizeCron(request: Request): Response | null {
    const secret = loadEnv().POLARIS_CRON_SECRET;
    if (!secret) return Response.json({ error: "Cron is not configured." }, { status: 503 });
    if (!timingSafeEqual(digest(presentedToken(request)), digest(secret))) {
        return Response.json({ error: "Not authorized." }, { status: 401 });
    }
    return null;
}
