/**
 * The rules of a pin that both sides need: the lengths a pin can be set for,
 * the shape a request has to have, and how many one conversation holds.
 *
 * Its own module, free of the database, because the screen asks the reader to
 * choose a length from the same list the server accepts - and a client
 * component that imported the service would pull Prisma into the browser bundle.
 */

import { z } from "zod";

/** How long a pin can be set for. The first three are WhatsApp's; the last is
 *  Discord's, where a pin stays until somebody unpins it. */
export const PIN_DURATIONS = ["day", "week", "month", "forever"] as const;
export type PinDuration = (typeof PIN_DURATIONS)[number];

/** What a pin request has to look like on the way in. */
export const pinInputSchema = z.object({
    messageId: z.string().uuid(),
    duration: z.enum(PIN_DURATIONS)
});
export type PinInput = z.infer<typeof pinInputSchema>;

/** How many pins one conversation holds at once. Discord's long-standing cap;
 *  past it the next pin is refused with a sentence that says to unpin one. */
export const MAX_PINS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const LASTS_MS: Readonly<Record<PinDuration, number | null>> = {
    day: DAY_MS,
    week: 7 * DAY_MS,
    month: 30 * DAY_MS,
    forever: null
};

/** When a pin set now for `duration` lapses, or null when it does not. */
export function pinExpiry(duration: PinDuration, now: Date = new Date()): Date | null {
    const lasts = LASTS_MS[duration];
    return lasts === null ? null : new Date(now.getTime() + lasts);
}
