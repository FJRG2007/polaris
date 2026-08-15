"use server";

/**
 * Everything a call screen calls.
 *
 * Split from the chat actions because half of these are reachable by somebody
 * with no account at all - the guest joining on a link - and mixing those into
 * a file whose every other export starts with `requirePermission` is how one
 * eventually gets written without it.
 *
 * The rule that separates them: an action that takes a meeting id proves a seat
 * (a session, or the guest cookie); an action that takes a channel id proves the
 * conversation. There is no third way in.
 */

import { z } from "zod";
import { cookies } from "next/headers";
import * as meetings from "@/lib/chat/meetings";
import { requirePermission } from "@/lib/session";
import { ChatAccessError } from "@/lib/chat/access";
import type { MeetingView } from "@/lib/chat/meetings";
import { GUEST_COOKIE, GUEST_COOKIE_MAX_AGE, resolveSeat } from "@/lib/chat/meeting-seat";

async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof ChatAccessError) return { error: caught.message };
        throw caught;
    }
}

/** Start the call in a conversation, or step into the one already running. */
export async function startCallAction(
    channelId: string
): Promise<{ meetingId?: string; error?: string }> {
    const user = await requirePermission("chat.use");
    const result = await guard(() =>
        meetings.startOrJoin({ id: user.id, name: user.name }, channelId)
    );
    return result.error ? { error: result.error } : { meetingId: result.value!.meetingId };
}

/** Join a call by id, as an account. */
export async function joinCallAction(meetingId: string): Promise<{ error?: string }> {
    const user = await requirePermission("chat.use");
    const result = await guard(() => meetings.join({ id: user.id, name: user.name }, meetingId));
    return result.error ? { error: result.error } : {};
}

/**
 * Join on a guest link.
 *
 * No permission and no session, which is the whole point - and so the only two
 * things it trusts are the token, which an account holder created deliberately,
 * and a name, which is a label rather than a claim. What it hands back is a
 * cookie that means "this participant row", nothing more.
 */
const guestJoinSchema = z.object({
    token: z.string().min(1).max(200),
    // Long enough for a real name, short enough that nobody writes an essay in
    // the roster.
    name: z.string().trim().min(1, "Say who you are").max(60)
});

export async function joinAsGuestAction(
    input: unknown
): Promise<{ meetingId?: string; admission?: string; error?: string }> {
    const parsed = guestJoinSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That did not work" };

    const result = await guard(() =>
        meetings.joinAsGuest(parsed.data.token, parsed.data.name)
    );
    if (result.error || !result.value) return { error: result.error ?? "That did not work" };

    const seat = result.value;
    if (seat.guestKey) {
        (await cookies()).set(GUEST_COOKIE, seat.guestKey, {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            maxAge: GUEST_COOKIE_MAX_AGE
        });
    }
    return { meetingId: seat.meetingId, admission: seat.admission };
}

/** The call as the screen draws it, for whoever holds a seat in it. */
export async function readCallAction(
    meetingId: string
): Promise<{ meeting?: MeetingView | null; participantId?: string; error?: string }> {
    const seat = await resolveSeat(meetingId);
    if (!seat) return { error: "You are not in that call" };
    const result = await guard(() => meetings.readMeeting(seat));
    return result.error
        ? { error: result.error }
        : { meeting: result.value, participantId: seat.participantId };
}

/** Still here. */
export async function keepSeatAction(meetingId: string): Promise<void> {
    const seat = await resolveSeat(meetingId);
    if (seat) await meetings.keepSeat(seat);
}

export async function leaveCallAction(meetingId: string): Promise<void> {
    const seat = await resolveSeat(meetingId);
    if (seat) await meetings.leave(seat);
}

export async function admitAction(
    meetingId: string,
    participantId: string,
    admitted: boolean
): Promise<{ error?: string }> {
    const seat = await resolveSeat(meetingId);
    if (!seat) return { error: "You are not in that call" };
    return guard(() => meetings.decideAdmission(seat, participantId, admitted));
}

export async function endCallAction(meetingId: string): Promise<{ error?: string }> {
    const user = await requirePermission("chat.use");
    return guard(() => meetings.end({ id: user.id }, meetingId));
}

export async function setGuestLinkAction(
    meetingId: string,
    open: boolean,
    approveGuests: boolean
): Promise<{ token?: string | null; error?: string }> {
    const user = await requirePermission("chat.use");
    const result = await guard(() =>
        meetings.setGuestLink({ id: user.id }, meetingId, open, approveGuests)
    );
    return result.error ? { error: result.error } : { token: result.value ?? null };
}

/** Whether a conversation has a call running in it, for the header. */
export async function liveCallAction(
    channelId: string
): Promise<{ meetingId: string; count: number } | null> {
    await requirePermission("chat.use");
    const live = await meetings.liveIn(channelId);
    return live ? { meetingId: live.id, count: live.count } : null;
}

/** The addresses this browser should try. Server-side because a TURN credential
 *  is configuration, and the browser needs it to connect at all. */
export async function iceServersAction(): Promise<RTCIceServer[]> {
    return meetings.iceServers() as RTCIceServer[];
}
