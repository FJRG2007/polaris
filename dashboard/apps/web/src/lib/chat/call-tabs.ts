/**
 * What one tab tells the other tabs of the same device about a ringing call.
 *
 * A call arriving is announced to every tab the reader has open, which is right:
 * a telephone that only rings in the window they happen to be looking at is a
 * missed call. Only one of them is answered, though, and until now the rest
 * never found out - the card went on offering to join a call that had been
 * answered next door, the tab holding the connection went on ringing, and the
 * notice the operating system had drawn stayed up. All of it until a reload.
 *
 * So the tab that deals with a call says so, and the others put it down. Two
 * things can be said about a call, and they are different in exactly one way:
 *
 * - **settled** - answered, declined, or gone. Every tab drops it. What was
 *   decided does not travel, because answering and declining leave every other
 *   tab with the same thing to do.
 * - **silenced** - the sound is off and the card stays. Somebody who hushed a
 *   ringing telephone in one window has hushed it in this browser, and the card
 *   is still there in all of them because they have not said no yet.
 *
 * Messages arrive unvalidated - a tab still running a previous build of Polaris
 * is on this channel too - so they are parsed before they are believed.
 */

import { z } from "zod";

/** The channel name. Scoped per account by the peer channel itself. */
export const CALLS_CHANNEL = "chat.calls";

export const callTabMessageSchema = z.object({
    kind: z.enum(["settled", "silenced"]),
    meetingId: z.string().min(1).max(100)
});

/** One call, dealt with somewhere in this browser. */
export type CallTabMessage = z.infer<typeof callTabMessageSchema>;
