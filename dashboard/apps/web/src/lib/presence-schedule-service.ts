/**
 * An account's status schedule: the windows it wrote once and stopped thinking
 * about.
 *
 * Storage and nothing else. Whether a window is open at this moment, and whether
 * it beats what somebody chose by hand, is decided by `presenceInForce` in
 * @polaris/core - a pure function, because the picker, the dot beside a face and
 * the screen that writes these all have to agree about it and only one of them
 * can reach a database.
 *
 * Every read and every write is scoped by the account, in the `where` rather
 * than checked afterwards: a schedule is one of the more revealing things an
 * account holds - it says when somebody sleeps - and the id of one is not a
 * capability to read or move it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getReportedTimeZone, resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

/** A stored window, as the screens read it. */
export interface PresenceScheduleView extends core.PresenceScheduleRule {}

/** What the schedule screen shows, and the clock it is all read against. */
export interface PresenceScheduleSettings {
    readonly schedules: readonly PresenceScheduleView[];
    /** The zone these run on. "auto" only for an account no browser has ever
     *  reported for, which the screen says out loud. */
    readonly timeZone: string;
    /** Whether that zone was chosen in Preferences rather than taken from the
     *  browser. The difference is worth a sentence: a zone that follows the
     *  browser follows it abroad, and these hours move with it. */
    readonly pinned: boolean;
}

/** A row, or null for one whose stored mode is not a mode any more. Nothing can
 *  write one today; a hand-edited row is dropped rather than drawn as a state
 *  the account cannot see or turn off. */
function toRule(row: {
    id: string;
    presence: string;
    days: number;
    startMinute: number;
    endMinute: number;
    enabled: boolean;
}): PresenceScheduleView | null {
    if (!core.isScheduledPresence(row.presence)) return null;
    return {
        id: row.id,
        presence: row.presence,
        days: row.days,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        enabled: row.enabled
    };
}

const ORDER = [{ startMinute: "asc" as const }, { createdAt: "asc" as const }];

/** The id column is a native uuid, and a query comparing it against something
 *  that is not one is refused by the engine rather than answered with no rows.
 *  Since "no rows" is what a made-up id means, it is checked here and the caller
 *  gets the same answer either way. */
const LOOKS_LIKE_AN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GONE = { error: "That schedule is gone." };

/** Every window this account keeps, the switched-off ones included - this is the
 *  screen that edits them, and one that hid what it had turned off would look
 *  like it had lost it. */
export async function schedulesOf(userId: string): Promise<PresenceScheduleView[]> {
    const rows = await prisma.presenceSchedule.findMany({ where: { userId }, orderBy: ORDER });
    return rows.map(toRule).filter((rule): rule is PresenceScheduleView => rule !== null);
}

/**
 * The windows in force for a page of people, by account.
 *
 * Only the switched-on ones, and only for accounts that have any: this is asked
 * on every refresh of every avatar strip, so the shape that matters is that the
 * overwhelming majority of accounts have no rows at all and the query costs one
 * indexed lookup that finds none.
 */
export async function activeSchedulesFor(
    ids: readonly string[]
): Promise<Map<string, PresenceScheduleView[]>> {
    const found = new Map<string, PresenceScheduleView[]>();
    if (ids.length === 0) return found;
    const rows = await prisma.presenceSchedule.findMany({
        where: { userId: { in: [...ids] }, enabled: true },
        orderBy: ORDER
    });
    for (const row of rows) {
        const rule = toRule(row);
        if (!rule) continue;
        const held = found.get(row.userId);
        if (held) held.push(rule);
        else found.set(row.userId, [rule]);
    }
    return found;
}

/** The clock one account's windows are read against. Through the shared
 *  resolver, which is memoized per request - the layout has already asked for
 *  the same preferences by the time anything here does. */
export async function scheduleZoneOf(userId: string): Promise<string> {
    return (await resolveDisplayPreferencesFor(userId)).timeZone;
}

export async function scheduleSettingsOf(userId: string): Promise<PresenceScheduleSettings> {
    const [schedules, timeZone, reported] = await Promise.all([
        schedulesOf(userId),
        scheduleZoneOf(userId),
        getReportedTimeZone(userId)
    ]);
    // Both reads are the same memoized row, so this costs nothing over the zone
    // on its own.
    return { schedules, timeZone, pinned: timeZone !== reported };
}

/**
 * Add one.
 *
 * Capped, because the list arrives from a browser and a table of them per
 * account is a table somebody could grow without limit. The ceiling is far above
 * what anybody writes: hitting it means something went wrong, not that somebody
 * needs a twenty-first window.
 */
export async function createSchedule(
    userId: string,
    input: core.PresenceScheduleInput
): Promise<{ error?: string }> {
    const held = await prisma.presenceSchedule.count({ where: { userId } });
    if (held >= core.MAX_PRESENCE_SCHEDULES) {
        return { error: `You can keep ${core.MAX_PRESENCE_SCHEDULES} schedules. Delete one first.` };
    }
    await prisma.presenceSchedule.create({ data: { userId, ...input } });
    return {};
}

/** Change one. Scoped by account, so the id of somebody else's is not a way in. */
export async function updateSchedule(
    userId: string,
    id: string,
    input: core.PresenceScheduleInput
): Promise<{ error?: string }> {
    if (!LOOKS_LIKE_AN_ID.test(id)) return GONE;
    const changed = await prisma.presenceSchedule.updateMany({ where: { id, userId }, data: input });
    return changed.count === 0 ? GONE : {};
}

/** Turn one on or off without losing it - the week somebody is away, and the one
 *  thing a delete cannot be undone from. */
export async function setScheduleEnabled(
    userId: string,
    id: string,
    enabled: boolean
): Promise<{ error?: string }> {
    if (!LOOKS_LIKE_AN_ID.test(id)) return GONE;
    const changed = await prisma.presenceSchedule.updateMany({
        where: { id, userId },
        data: { enabled }
    });
    return changed.count === 0 ? GONE : {};
}

export async function deleteSchedule(userId: string, id: string): Promise<{ error?: string }> {
    if (!LOOKS_LIKE_AN_ID.test(id)) return {};
    await prisma.presenceSchedule.deleteMany({ where: { id, userId } });
    return {};
}
