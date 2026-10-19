/**
 * The call running in a conversation, and who is sitting in it.
 *
 * A route rather than a server action because a conversation drawing a call
 * from outside asks it again on a timer: after an update the action's id was
 * gone, the ask failed, and the failure read as "no call" - the call banner and
 * its Join button vanished for everybody not in it until they reloaded.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { backgroundUser, sessionCan } from "@/lib/session";
import { ChatAccessError, requireChannel } from "@/lib/chat/access";
import * as meetings from "@/lib/chat/meetings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const channelIdSchema = z.string().uuid();

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ channelId: string }> }
): Promise<Response> {
    const user = await backgroundUser();
    // i18n-ignore: a status body the call banner never shows
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = channelIdSchema.safeParse((await params).channelId);
    if (!parsed.success || !(await sessionCan(user, "chat.use")))
        return NextResponse.json({ live: null });
    try {
        await requireChannel({ id: user.id }, parsed.data);
    } catch (caught) {
        if (caught instanceof ChatAccessError) return NextResponse.json({ live: null });
        throw caught;
    }
    const live = await meetings.liveIn(parsed.data);
    return NextResponse.json(
        {
            live: live ? { meetingId: live.id, count: live.count, people: live.people } : null
        },
        { headers: { "cache-control": "no-store" } }
    );
}
