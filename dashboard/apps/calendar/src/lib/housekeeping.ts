/**
 * The hourly tidy-up: what sat in the trash past its time goes for good, and
 * booking requests nobody confirmed stop holding their slot.
 *
 * Server-only.
 */

import { purgeExpiredTrash } from "./trash";

export async function sweepCalendarHousekeeping(now = new Date()): Promise<{ purged: number; stale: number }> {
    const purged = await purgeExpiredTrash(now);
    const booking = await import("./booking");
    const stale = await booking.sweepStaleBookings(now);
    return { purged, stale };
}
