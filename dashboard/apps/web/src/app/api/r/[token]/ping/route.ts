/**
 * Drop-point presence heartbeat. The public page pings this while it is open so
 * the owner's Visitors view can show who is connected, for how long, and whether
 * they uploaded. It sets an opaque per-browser cookie to group a visitor's pings
 * and uploads, records/refreshes the session, and always answers 204 - it never
 * reveals whether the token is valid or the drop point is open. Node runtime for
 * Prisma and cookies.
 */

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { getSession } from "@/lib/session";
import { clientIp, clientUserAgent } from "@/lib/request-context";
import {
    fileRequestUsability,
    fileRequestVisitCookie,
    recordVisit,
    resolveFileRequestByToken
} from "@/lib/file-request-service";
import { rateLimit } from "@/lib/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
    _request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const fileRequest = await resolveFileRequestByToken(token);
    // Only track live sessions while the drop point is actually accepting uploads.
    if (!fileRequest || !fileRequestUsability(fileRequest).ok) {
        return new Response(null, { status: 204 });
    }

    const store = await cookies();
    const cookieName = fileRequestVisitCookie(fileRequest.id);
    let visitorKey = store.get(cookieName)?.value;
    if (!visitorKey) {
        visitorKey = randomBytes(12).toString("hex");
        const env = loadEnv();
        store.set(cookieName, visitorKey, {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: 60 * 60 * 24
        });
    }

    // Backstop throttle so a chatty client cannot hammer the database.
    if ((await rateLimit(`drop-ping:${fileRequest.id}:${visitorKey}`, 12, 60 * 1000)).ok) {
        const session = await getSession();
        const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
        await recordVisit({
            requestId: fileRequest.id,
            visitorKey,
            ip: await clientIp(),
            userId,
            userAgent: await clientUserAgent()
        });
    }
    return new Response(null, { status: 204 });
}
