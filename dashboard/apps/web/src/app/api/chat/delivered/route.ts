import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { markDelivered } from "@/lib/chat/delivered";
import { rateLimit } from "@/lib/rate-limit-service";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Acknowledgements a minute, per person. A screen gathers a burst into one,
 *  so this is several devices' worth of a busy afternoon. */
const ACKS_PER_MINUTE = 120;

/**
 * "This device now holds what arrived in these conversations" - the second tick.
 *
 * Sent by the screen that holds the live channel when it is told a message
 * landed, whether or not the conversation is open. A route rather than an
 * action so anything signed in with the page's cookie can say it, and JSON
 * only, which a cross-site form cannot send without asking first.
 *
 * Only ever moves the caller's own marks, only forwards, and only in
 * conversations they are a member of (see `markDelivered`): a conversation they
 * are not in is ignored rather than refused, so the answer says nothing about
 * which conversations exist.
 */
export async function POST(request: Request): Promise<Response> {
    // i18n-ignore: status bodies no screen shows
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
    }
    const session = await backgroundUser();
    // i18n-ignore: status bodies no screen shows
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) return NextResponse.json({ moved: 0 });

    const parsed = core.chatDeliveredSchema.safeParse(await request.json().catch(() => null));
    // i18n-ignore: status bodies no screen shows
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    if (!(await rateLimit(`chat-delivered:${session.id}`, ACKS_PER_MINUTE, 60_000)).ok) {
        return NextResponse.json({ moved: 0 }, { status: 429 });
    }
    const moved = await markDelivered(session.id, parsed.data.channelIds);
    return NextResponse.json({ moved: moved.length });
}
