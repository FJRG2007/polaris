/**
 * The pass a played sound carries, so everybody in the call can hear it.
 *
 * A space's sound is readable by whoever reaches the space. A call is wider than
 * that: a direct message call with somebody from another space, a guest on a
 * link, a member who brought a sound from a space nobody else here is in. Each
 * of them has to fetch the clip the moment it is played, and none of them could.
 *
 * So the play carries a signature over the sound and the call, and the route
 * hands the clip to anybody who holds a seat in that call and presents it. The
 * sound itself is still only ever named by the server - the pass is minted by
 * the play that already checked the player may play it - and a pass for one
 * call opens nothing in any other. Signed with the app secret every install
 * already has, so it needs no configuration.
 *
 * Server-only.
 */

import { loadEnv } from "@polaris/config";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * How long a pass stays good.
 *
 * Long enough for a browser that was busy, or on a slow link, to fetch the
 * clip after the cue appeared; short enough that a pass copied out of a call is
 * worth nothing by the time anybody could use it - and a holder needs a seat in
 * the call anyway.
 */
const TTL_MS = 10 * 60 * 1000;

function sign(payload: string): string {
    return createHmac("sha256", loadEnv().POLARIS_AUTH_SECRET)
        .update(`soundboard:${payload}`)
        .digest("base64url");
}

/** A pass for one sound in one call. */
export function soundTicket(soundId: string, meetingId: string, now = Date.now()): string {
    const expires = String(now + TTL_MS);
    return `${expires}.${sign(`${soundId}:${meetingId}:${expires}`)}`;
}

/** Whether a pass was minted for exactly this sound in exactly this call, and
 *  is still good. */
export function readSoundTicket(
    ticket: string,
    soundId: string,
    meetingId: string,
    now = Date.now()
): boolean {
    const [expires, signature] = ticket.split(".");
    if (!expires || !signature || !/^\d{10,16}$/.test(expires)) return false;
    if (Number(expires) < now) return false;
    const expected = Buffer.from(sign(`${soundId}:${meetingId}:${expires}`), "utf8");
    const given = Buffer.from(signature, "utf8");
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Where a played sound is fetched from by everybody in the call. */
export function soundUrl(soundId: string, meetingId: string): string {
    return `/api/chat/sounds/${soundId}?m=${meetingId}&t=${soundTicket(soundId, meetingId)}`;
}
