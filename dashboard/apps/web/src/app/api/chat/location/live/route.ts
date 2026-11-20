import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { moveLive, stopLive } from "@/lib/chat/locations";
import { rateLimit } from "@/lib/rate-limit-service";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Moves a minute, per person: one every few seconds is all a device sends. */
const MOVES_PER_MINUTE = 30;

/**
 * Where the sender is now, for every live share they are running.
 *
 * A route rather than a server action because the phone apps call it too, from
 * a foreground service with the page closed - signed in with the page's own
 * cookie. JSON only, which a cross-site form cannot send without asking first.
 *
 * Answers how many shares are still running; zero tells the device to stop.
 */
export async function POST(request: Request): Promise<Response> {
    // i18n-ignore: status bodies no screen shows
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
    }
    const session = await backgroundUser();
    // i18n-ignore: status bodies no screen shows
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) return NextResponse.json({ running: 0 });

    const parsed = core.geoPointSchema.safeParse(await request.json().catch(() => null));
    // i18n-ignore: status bodies no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Invalid point" }, { status: 400 });
    if (!(await rateLimit(`chat-live-move:${session.id}`, MOVES_PER_MINUTE, 60_000)).ok) {
        return NextResponse.json({ running: -1 }, { status: 429 });
    }
    const { running } = await moveLive({ id: session.id }, parsed.data);
    return NextResponse.json({ running });
}

/** Stop every live share the caller runs: the phone notification's Stop. */
export async function DELETE(request: Request): Promise<Response> {
    // i18n-ignore: status bodies no screen shows
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
    }
    const session = await backgroundUser();
    // i18n-ignore: status bodies no screen shows
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    await stopLive({ id: session.id }, null);
    return NextResponse.json({ running: 0 });
}
