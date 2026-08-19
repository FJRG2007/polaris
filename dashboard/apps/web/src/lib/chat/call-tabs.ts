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
 * So the tab that deals with a call says so, and the others put it down. What
 * travels is the meeting it was about and nothing else: what was decided is
 * nobody else's business, because answering and declining leave every other tab
 * with exactly the same thing to do.
 *
 * Messages arrive unvalidated - a tab still running a previous build of Polaris
 * is on this channel too - so they are parsed before they are believed.
 */

import { z } from "zod";

/** The channel name. Scoped per account by the peer channel itself. */
export const CALLS_CHANNEL = "chat.calls";

export const callTabMessageSchema = z.object({
    kind: z.literal("settled"),
    meetingId: z.string().min(1).max(100)
});

/** One call, dealt with somewhere in this browser. */
export type CallTabMessage = z.infer<typeof callTabMessageSchema>;
