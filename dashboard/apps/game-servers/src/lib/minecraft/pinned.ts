/**
 * The announcement a server keeps on screen, as it is recorded on the install.
 *
 * One is on top at a time. A short timed one sent while a held one is up goes
 * over it rather than replacing it: the held one is kept underneath and comes
 * back when the short one's time is over, so a five-second notice never takes
 * down something an admin meant to stay until they remove it.
 *
 * Pure, so what is kept and what comes back can be asserted without a server.
 */

import { announcementSchema } from "./announcement-templates";
import { holdEndsAt, type Announcement } from "./announcement";

/** Where the announcement being kept up is recorded on the install. */
export const PINNED_KEY = "pinnedAnnouncement";

/** An announcement being kept on screen, and when it comes down. */
export interface PinnedAnnouncement {
    readonly announcement: Announcement;
    readonly sentAt: number;
    /** A moment, or null for "until somebody takes it down". */
    readonly endsAt: number | null;
    /** The held one a timed one went over, back on screen when it ends. */
    readonly underneath: PinnedAnnouncement | null;
}

function readOne(stored: unknown): PinnedAnnouncement | null {
    if (!stored || typeof stored !== "object") return null;
    const record = stored as Record<string, unknown>;
    const announcement = announcementSchema.safeParse(record.announcement);
    if (!announcement.success) return null;
    const sentAt = Number(record.sentAt);
    const endsAt = record.endsAt === null ? null : Number(record.endsAt);
    if (!Number.isFinite(sentAt) || (endsAt !== null && !Number.isFinite(endsAt))) return null;
    return { announcement: announcement.data, sentAt, endsAt, underneath: null };
}

export function readPinned(config: Record<string, unknown>): PinnedAnnouncement | null {
    const stored = config[PINNED_KEY];
    const top = readOne(stored);
    if (!top) return null;
    const below = readOne((stored as Record<string, unknown>).underneath);
    return below && below.announcement.hold !== "timed" ? { ...top, underneath: below } : top;
}

function lasts(pinned: PinnedAnnouncement, now: number): boolean {
    return pinned.endsAt === null || now < pinned.endsAt;
}

/**
 * What is pinned once `announcement` is sent over `current`. A held one replaces
 * everything; a timed one keeps the held one that was up, to come back after it.
 */
export function pinOver(
    current: PinnedAnnouncement | null,
    announcement: Announcement,
    sentAt: number
): PinnedAnnouncement {
    const endsAt = holdEndsAt(announcement, sentAt);
    if (announcement.hold !== "timed" || !current) {
        return { announcement, sentAt, endsAt, underneath: null };
    }
    const held =
        current.announcement.hold !== "timed"
            ? { ...current, underneath: null }
            : current.underneath;
    return {
        announcement,
        sentAt,
        endsAt,
        underneath: held && lasts(held, sentAt) ? held : null
    };
}

/** What is still pinned at `now`: the one on top, the held one under it once
 *  the top one has ended, or nothing. */
export function pinnedAt(
    pinned: PinnedAnnouncement | null,
    now: number
): PinnedAnnouncement | null {
    if (!pinned || lasts(pinned, now)) return pinned;
    return pinned.underneath && lasts(pinned.underneath, now) ? pinned.underneath : null;
}
