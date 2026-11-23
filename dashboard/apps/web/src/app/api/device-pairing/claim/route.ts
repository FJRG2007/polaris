/**
 * Polaris Desktop presenting a nonce the extension on the same computer handed
 * it through native messaging (`lib/device-sessions/device-pairing`).
 *
 * Only a signed-in session that carries a device key can bind anything, and the
 * key is the one the session guard holds for this session - checked against the
 * device header on this very request, so a browser session replaying the
 * desktop's cookie without the desktop's claim binds nothing. Rate limited per
 * session. The answer says only whether it bound; why not stays in the log.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { PAIRING_NONCE_PATTERN } from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { deviceKeyFor, requestDeviceClaim } from "@/lib/device-sessions/device-key";
import { claimPairing } from "@/lib/device-sessions/device-pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 30;
const WINDOW_MS = 60 * 60 * 1000;

const claimSchema = z.object({ nonce: z.string().trim().regex(PAIRING_NONCE_PATTERN) });

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (user.viewingAs) return Response.json({ error: "refused" }, { status: 403 });

    const body = claimSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: "bad-request" }, { status: 400 });

    const throttle = await rateLimit(`device-pairing-claim:${user.sessionId}`, LIMIT, WINDOW_MS);
    if (!throttle.ok) return Response.json({ error: "rate-limited" }, { status: 429 });

    const [state, claim] = await Promise.all([
        prisma.sessionState.findUnique({ where: { sessionId: user.sessionId }, select: { userId: true, deviceKey: true } }),
        requestDeviceClaim()
    ]);
    const presented = deviceKeyFor(user.id, claim.id);
    const deviceKey = state && state.userId === user.id && presented && state.deviceKey === presented ? presented : null;

    const result = await claimPairing({ userId: user.id, deviceKey: deviceKey }, body.data.nonce);
    if (!result.bound) {
        console.warn(`[device-pairing] claim refused: ${result.reason}`);
        return Response.json({ bound: false }, { status: 409 });
    }
    return Response.json({ bound: true });
}
