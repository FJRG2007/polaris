/**
 * Whether somebody is in the middle of something an update's restart would cut:
 * a venue taking an order or a payment right now, or a call with somebody on it.
 *
 * Read at the moment a scheduled install comes due, so the install steps back
 * and the watcher's next pass looks again - up to `BUSY_POSTPONE_CAP_MS` past
 * the planned moment, after which it installs regardless, since a fix that
 * waits forever is worse than one restart. Nothing is stored: the planned
 * moment comes from the first-seen row, so every container answers the same.
 */

import { prisma } from "@polaris/db";

/** An order line or a payment this recent means the venue is in service. */
export const BUSY_ORDER_WINDOW_MS = 10 * 60_000;
/** A seat a browser reported within this is somebody still on a call. Twice the
 *  call heartbeat's own presence window (`PARTICIPANT_TTL_MS`), so one late
 *  heartbeat does not read as an empty room. */
export const BUSY_CALL_WINDOW_MS = 60_000;
/** How long past its planned moment an install steps back for live activity. */
export const BUSY_POSTPONE_CAP_MS = 2 * 60 * 60_000;

export async function liveActivityNow(now = new Date()): Promise<boolean> {
    const orders = new Date(now.getTime() - BUSY_ORDER_WINDOW_MS);
    const [line, payment, seat] = await Promise.all([
        prisma.hospitalityOrderLine.findFirst({ where: { createdAt: { gte: orders } }, select: { id: true } }),
        prisma.hospitalityPayment.findFirst({ where: { createdAt: { gte: orders } }, select: { id: true } }),
        prisma.meetingParticipant.findFirst({
            where: {
                leftAt: null,
                admission: "admitted",
                lastSeenAt: { gte: new Date(now.getTime() - BUSY_CALL_WINDOW_MS) }
            },
            select: { id: true }
        })
    ]);
    return Boolean(line || payment || seat);
}

/**
 * Whether an install planned for `runsAt` steps back now: something is live and
 * the cap has not run out. A failed read never holds an install back.
 */
export async function postponeForActivity(runsAt: Date, now = new Date()): Promise<boolean> {
    if (now.getTime() - runsAt.getTime() >= BUSY_POSTPONE_CAP_MS) return false;
    return liveActivityNow(now).catch(() => false);
}
