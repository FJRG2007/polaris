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
import { can } from "@polaris/auth";
import * as core from "@polaris/core";
import { cookies } from "next/headers";
import * as chat from "@/lib/chat/chat-service";
import * as meetings from "@/lib/chat/meetings";
import * as calls from "@/lib/chat/call-server";
import { requirePermission } from "@/lib/session";
import type { MeetingView } from "@/lib/chat/meetings";
import { ChatAccessError, requireChannel } from "@/lib/chat/access";
import { GUEST_COOKIE, GUEST_COOKIE_MAX_AGE, resolveSeat } from "@/lib/chat/meeting-seat";

/**
 * Whether this account may be in a call at all.
 *
 * Its own grant rather than part of holding the chat: a call is the one thing in
 * here that takes somebody's microphone and everybody else's attention, and an
 * instance that wants text and no voice had no way to say so. Guests are not
 * asked - they arrive on a link somebody with the grant created, which is the
 * decision.
 */
const NO_CALLS = "You are not allowed to be in calls here";

async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        if (caught instanceof ChatAccessError) return { error: caught.message };
        throw caught;
    }
}

/**
 * Why a call cannot be started here, or null when one can.
 *
 * Read by every screen with a call button on it, so a button that is drawn as
 * available is one this will accept. It is about the instance rather than about
 * the reader - what it can say is "there is nowhere for a call to run", which is
 * not a fact about anybody - so holding the chat is gate enough.
 */
export async function callsUnavailableAction(): Promise<string | null> {
    await requirePermission("chat.use");
    return calls.callsUnavailable();
}

/**
 * Start the call in a conversation, or step into the one already running.
 *
 * Refused outright when there is no working call server. Every call goes through
 * one, so starting without it is a room that opens microphones and carries
 * nothing - two people watching each other's names, which is the state nobody
 * can diagnose from inside.
 */
export async function startCallAction(
    channelId: string
): Promise<{ meetingId?: string; error?: string }> {
    const user = await requirePermission("chat.use");
    if (!(await can(user.id, "chat.call"))) return { error: NO_CALLS };
    const off = await calls.callsUnavailable();
    if (off) return { error: off };
    const result = await guard(() =>
        meetings.startOrJoin({ id: user.id, name: user.name }, channelId)
    );
    return result.error ? { error: result.error } : { meetingId: result.value!.meetingId };
}

/**
 * Bring somebody into the call.
 *
 * Answers where the call is now, because it may not be where it was: a
 * one-to-one that takes a third person becomes a group, and the browser that
 * asked has to follow it there.
 */
const inviteSchema = z.object({
    meetingId: z.string().uuid(),
    userIds: z.array(z.string().uuid()).min(1).max(core.MAX_GROUP_MEMBERS)
});

export async function inviteToCallAction(
    input: unknown
): Promise<{ meetingId?: string; channelId?: string; moved?: boolean; error?: string }> {
    const user = await requirePermission("chat.use");
    if (!(await can(user.id, "chat.call"))) return { error: NO_CALLS };
    const parsed = inviteSchema.safeParse(input);
    if (!parsed.success) return { error: "Pick somebody to bring in" };

    const result = await guard(() =>
        meetings.inviteToCall(
            { id: user.id, name: user.name },
            parsed.data.meetingId,
            parsed.data.userIds,
            (channelId, userIds) => chat.addChannelMembers({ id: user.id }, channelId, userIds),
            (userIds) => chat.openDirect({ id: user.id }, userIds)
        )
    );
    return result.error ? { error: result.error } : { ...result.value! };
}

/** Join a call by id, as an account. */
export async function joinCallAction(meetingId: string): Promise<{ error?: string }> {
    const user = await requirePermission("chat.use");
    if (!(await can(user.id, "chat.call"))) return { error: NO_CALLS };
    const off = await calls.callsUnavailable();
    if (off) return { error: off };
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

    const result = await guard(() => meetings.joinAsGuest(parsed.data.token, parsed.data.name));
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

/**
 * The call as the screen draws it, for whoever holds a seat in it.
 *
 * `gone` is the answer that matters and it is separate from `error` on purpose.
 * Not holding a seat is not a failure to read the call - it is this browser not
 * being in it, which is what happens when the call ended, when the seat was
 * swept, or when another device took it over. Reported as an error it drew a
 * sentence on a screen that went on showing the call bar for a room nobody was
 * in; reported as itself, the screen lets go.
 */
export async function readCallAction(meetingId: string): Promise<{
    meeting?: MeetingView | null;
    participantId?: string;
    gone?: boolean;
    error?: string;
}> {
    const seat = await resolveSeat(meetingId);
    if (!seat) return { gone: true };
    const result = await guard(() => meetings.readMeeting(seat));
    return result.error
        ? { error: result.error }
        : { meeting: result.value, participantId: seat.participantId };
}

/**
 * The ticket for the server a call runs through.
 *
 * The signing key never leaves the server. What comes back is good for one room,
 * for a few minutes, under the identity of the seat this request already holds -
 * so a browser cannot ask for a ticket to a call it was not admitted to, and the
 * waiting room is enforced exactly once, here.
 *
 * Waiting in the lobby is answered as waiting rather than as an error, and that
 * distinction is the whole reason this returns three things instead of two. A
 * browser at the door is told "not yet" and asks again on the next roster
 * change, silently; anything else has gone wrong and belongs on screen. Reported
 * as one shape, an instance whose media server had died looked exactly like a
 * guest waiting to be let in, and said nothing to either of them.
 */
export async function callTokenAction(
    meetingId: string
): Promise<{ url?: string; token?: string; waiting?: boolean; error?: string }> {
    const seat = await resolveSeat(meetingId);
    if (!seat) return { error: "You are not in that call" };
    if (seat.admission !== "admitted") return { waiting: true };

    const endpoint = await calls.callServer();
    if (!endpoint) return { error: calls.NO_CALL_SERVER };

    const token = await calls.joinToken(endpoint, meetingId, seat.participantId);
    return { url: endpoint.url, token };
}

/**
 * A call this account is already in, on some other device.
 *
 * Asked by a browser that is not in one, so it can offer to take it over rather
 * than leave somebody looking at a phone that says nothing while their computer
 * holds a live microphone in another room.
 *
 * It answers about the account rather than about a conversation, which is what
 * makes it safe to ask from anywhere: the only thing it can tell you is where
 * your own seat is.
 */
export async function callElsewhereAction(): Promise<meetings.CallElsewhere | null> {
    const user = await requirePermission("chat.use");
    if (!(await can(user.id, "chat.call"))) return null;
    return meetings.callElsewhere(user.id);
}

/**
 * Take the call over on this device.
 *
 * The seat is already this account's - joining reuses it - so this says nothing
 * about who may be in the room. What it does is tell the browser that had it
 * that it no longer does, which is the half that was missing: two devices held
 * one seat and neither knew.
 */
export async function claimCallAction(meetingId: string, deviceId: string): Promise<void> {
    const seat = await resolveSeat(meetingId);
    if (!seat || seat.admission !== "admitted") return;
    // The seat comes from the request rather than from the browser: which chair
    // a claim is about is exactly the thing a browser must not be able to name.
    meetings.claimCall(meetingId, seat.participantId, String(deviceId).slice(0, 100));
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

/**
 * Whether a conversation has a call running in it, for the header.
 *
 * The conversation is proved, not just the permission: "is anybody on a call in
 * this channel, and how many" is something about a room, and answering it for a
 * channel id somebody guessed would be a way to read a private conversation one
 * bit at a time.
 */
export async function liveCallAction(
    channelId: string
): Promise<{ meetingId: string; count: number } | null> {
    const user = await requirePermission("chat.use");
    const result = await guard(async () => {
        await requireChannel({ id: user.id }, channelId);
        return meetings.liveIn(channelId);
    });
    const live = result.value;
    return live ? { meetingId: live.id, count: live.count } : null;
}

/**
 * The licensed noise filter an administrator connected, if there is one.
 *
 * Both halves of it reach the browser, because that is where a filter on a
 * microphone runs - there is no arrangement in which the page does not hold
 * them. So the gate is the same one the join ticket has: a seat in this call,
 * admitted. That is the most that can be true of something a browser has to be
 * given, and the dialog that stores it says so.
 */
export async function licensedFilterAction(
    meetingId: string
): Promise<{ moduleUrl: string; token: string } | null> {
    const seat = await resolveSeat(meetingId);
    if (!seat || seat.admission !== "admitted") return null;
    return await meetings.licensedFilter();
}
