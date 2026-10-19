/**
 * The seat a browser holds in a call, kept over a route.
 *
 * A route rather than a server action: a server action is addressed by an id the
 * build that served the page minted, and a tab left open across a Polaris update
 * keeps calling the old one. Anything a long-lived tab calls on a timer goes
 * through here.
 */

/** Where this browser holds its seat in a call: POST to keep it, DELETE to give
 *  it back. */
function seatUrl(meetingId: string): string {
    return `/api/chat/meetings/${encodeURIComponent(meetingId)}/seat`;
}

/** Whether this person can be heard and can hear, and whether they are
 *  sharing a screen, as the seat reports it. */
export interface VoiceState {
    readonly muted: boolean;
    readonly deafened: boolean;
    readonly streaming: boolean;
}

/**
 * Keep the seat, failing on anything but a success so the beat can count it.
 *
 * Carries the controls too: the people outside the call are never connected to
 * the media server, so the seat is where they read who is muted or deafened, and
 * who is sharing a screen.
 */
export async function keepSeat(
    meetingId: string,
    voice: VoiceState,
    rejoin = false
): Promise<void> {
    const response = await fetch(seatUrl(meetingId), {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rejoin ? { ...voice, rejoin } : voice)
    });
    if (!response.ok) throw new SeatError(response.status);
}

/** A beat the seat route did not take, with the status it answered. */
class SeatError extends Error {
    constructor(readonly status: number) {
        super(`seat ${status}`);
    }
}

/**
 * Keep the seat, and take it back if it was closed under a tab still in the call.
 *
 * A 410 means the row has `leftAt` set while this browser is still carrying the
 * call - a reload whose departure arrived after the new page joined, a sweep
 * while the machine slept. Giving up on the beat there left the room on the
 * media server and the roster saying the person had gone. Asked again once,
 * saying so, and only while the call is still this tab's (`still`), so a beat
 * in flight as somebody hangs up never puts them back.
 */
export async function holdSeat(
    meetingId: string,
    voice: VoiceState,
    still: () => boolean
): Promise<void> {
    try {
        await keepSeat(meetingId, voice);
    } catch (caught) {
        if (!(caught instanceof SeatError) || caught.status !== 410 || !still()) throw caught;
        await keepSeat(meetingId, voice, true);
    }
}

/** Give the seat back. `keepalive`, so it is still sent from a tab that is
 *  closing. */
export function leaveSeat(meetingId: string): void {
    void fetch(seatUrl(meetingId), { method: "DELETE", keepalive: true }).catch(() => undefined);
}
