/**
 * The steps of getting into a call, as routes rather than server actions.
 *
 * A server action is addressed by an id only the build that served the page
 * knows, and Next runs a tab's actions one at a time, behind its navigations.
 * A tab open across a Polaris update, or one whose Join went out while the
 * address was still changing, sat on "Going in" until it was reloaded. A
 * route's path is the same in every build and waits on nothing else the screen
 * is doing. Each step runs the action it replaces, so who may do what, and the
 * answer, stay exactly what they were. Read with `call-requests.ts`.
 *
 * The steps a seat proves - the ticket, the call as drawn, the voice it was
 * left with - take no session: a guest holds a seat without one.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { actionRoute } from "@/lib/poll-route";
import * as calls from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const channel = z.object({ channelId: z.string().trim().min(1).max(100) });
const meeting = z.object({ meetingId: z.string().uuid() });
const guest = { signedIn: false };

const STEPS: Record<string, (request: Request) => Promise<Response>> = {
    start: actionRoute(channel, ({ channelId }) => calls.startCallAction(channelId)),
    join: actionRoute(meeting, ({ meetingId }) => calls.joinCallAction(meetingId)),
    "join-meeting": actionRoute(meeting, ({ meetingId }) => calls.joinMeetingAction(meetingId)),
    ticket: actionRoute(meeting, ({ meetingId }) => calls.callTokenAction(meetingId), guest),
    read: actionRoute(meeting, ({ meetingId }) => calls.readCallAction(meetingId), guest),
    "own-voice": actionRoute(meeting, ({ meetingId }) => calls.ownVoiceAction(meetingId), guest),
    "licensed-filter": actionRoute(
        meeting,
        ({ meetingId }) => calls.licensedFilterAction(meetingId),
        guest
    ),
    claim: actionRoute(
        meeting.extend({ deviceId: z.string().max(100) }),
        ({ meetingId, deviceId }) => calls.claimCallAction(meetingId, deviceId),
        guest
    )
};

export async function POST(
    request: Request,
    { params }: { params: Promise<{ op: string }> }
): Promise<Response> {
    const { op } = await params;
    const step = Object.hasOwn(STEPS, op) ? STEPS[op] : undefined;
    // i18n-ignore: a status body no screen shows
    if (!step) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return step(request);
}
