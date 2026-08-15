/**
 * Working out which chair in a call this request is sitting in.
 *
 * Two kinds of caller and one answer. Somebody signed in is resolved through
 * their session and the conversation the call is in; somebody on a guest link is
 * resolved through a cookie holding the key that was minted when they joined.
 * Both come back as the same seat, so nothing downstream branches on how
 * somebody arrived.
 *
 * The guest cookie is the credential for one participant row and nothing else.
 * It is httpOnly, so a script on the page cannot read it; it is scoped to the
 * meeting routes; and it stops meaning anything the moment that row is left or
 * the call ends. Losing it is losing a seat in one call, which is why it is
 * allowed to exist at all for somebody with no account.
 */

import { cookies } from "next/headers";
import { resolveSession } from "@/lib/session";
import { seatForGuestKey, seatForUser, type MeetingSeat } from "./meetings";

/** Where a guest's key lives. Named for what it is, so a person reading their
 *  own cookie jar can tell what it is for. */
export const GUEST_COOKIE = "polaris.meeting";

/** How long the cookie survives. A call is minutes; this is a few hours, so a
 *  browser that reloads or a laptop that slept still knows which seat was
 *  theirs, and it is gone long before it could be mistaken for a login. */
export const GUEST_COOKIE_MAX_AGE = 6 * 60 * 60;

/**
 * The seat this request holds in a given meeting, or null.
 *
 * The session is tried first: somebody who is signed in AND holds a guest cookie
 * from an earlier call should be seated as themselves, not as the guest they
 * once were.
 */
export async function resolveSeat(meetingId: string): Promise<MeetingSeat | null> {
    const session = await resolveSession();
    if (session) {
        const seat = await seatForUser(session.id, meetingId);
        if (seat) return seat;
    }

    const key = (await cookies()).get(GUEST_COOKIE)?.value;
    if (!key) return null;
    const seat = await seatForGuestKey(key);
    return seat && seat.meetingId === meetingId ? seat : null;
}

/** The seat this request holds anywhere, for a guest page that has the token
 *  rather than the meeting id. */
export async function resolveGuestSeat(): Promise<MeetingSeat | null> {
    const key = (await cookies()).get(GUEST_COOKIE)?.value;
    return key ? seatForGuestKey(key) : null;
}
