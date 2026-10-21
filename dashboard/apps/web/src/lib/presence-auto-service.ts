/**
 * Automatic status: the setting, and the calendar half of the facts it reads.
 *
 * The call half needs nothing here - a seat on a call already lapses when its
 * heartbeats stop (`PARTICIPANT_TTL_MS`), so "in a call" read from the seats
 * clears itself on leaving or on a closed laptop. The calendar half asks the
 * app that keeps calendars, through the extension registry, because core never
 * imports an app's modules.
 *
 * What the calendar said is held for half a minute per person. Presence is
 * asked about by every avatar strip on every refresh, and a meeting changes far
 * less often than that; half a minute is also how late an edited event can be
 * to show, which is under the store's own refresh.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

/** How long one person's calendar answer is reused. */
const MEETINGS_TTL_MS = 30_000;

/** The most people held at once; the oldest goes first past it. */
const MEETINGS_HELD = 5_000;

const held = new Map<string, { at: number; key: string; events: readonly core.BusyEvent[] }>();

/** This account's setting, with the defaults for anything it never set. */
export async function autoPresenceSettingsOf(userId: string): Promise<core.AutoPresence> {
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { autoPresence: true }
    });
    return core.parseAutoPresence(row?.autoPresence);
}

export async function saveAutoPresence(userId: string, settings: core.AutoPresence): Promise<void> {
    await prisma.user.update({
        where: { id: userId },
        data: { autoPresence: JSON.stringify(settings) }
    });
    held.delete(userId);
}

/** The calendars this account may pick from, or null when no installed app
 *  keeps calendars - which the screen says rather than offering a switch that
 *  could never apply. */
export async function autoPresenceCalendarsOf(
    userId: string
): Promise<{ id: string; name: string; color: string }[] | null> {
    const { presenceCalendarsFor } = await import("@/lib/app-extensions/registry");
    return presenceCalendarsFor(userId).catch((caught: unknown) => {
        console.error("polaris: could not list calendars for automatic status:", caught);
        return null;
    });
}

/**
 * The meeting each of these people is in at `now`, and when their next one
 * starts. People with no calendar app, or whose calendar could not be read, are
 * simply not in a meeting: a failure here must not take the dots down.
 */
export async function meetingsNow(
    people: readonly { id: string; settings: core.AutoPresence["meeting"]; zone: string }[],
    now: Date
): Promise<Map<string, ReturnType<typeof core.meetingAt>>> {
    const answer = new Map<string, ReturnType<typeof core.meetingAt>>();
    if (people.length === 0) return answer;
    const at = now.getTime();
    const keyOf = (person: (typeof people)[number]) =>
        `${person.zone}|${person.settings.calendars?.join(",") ?? "*"}`;

    const stale = people.filter((person) => {
        const entry = held.get(person.id);
        return !entry || entry.key !== keyOf(person) || at - entry.at >= MEETINGS_TTL_MS;
    });
    if (stale.length > 0) {
        // Wide enough for the largest margin either side and the lookahead, so
        // one read answers every setting the cache may be asked with.
        const margin = core.MAX_AUTO_PRESENCE_MARGIN * 60_000;
        const window = {
            from: new Date(at - margin),
            to: new Date(at + margin + core.AUTO_PRESENCE_LOOKAHEAD_MS)
        };
        const { presenceBusyFor } = await import("@/lib/app-extensions/registry");
        const found = await presenceBusyFor(
            stale.map((person) => ({
                userId: person.id,
                calendarIds: person.settings.calendars,
                zone: person.zone
            })),
            window
        ).catch((caught: unknown) => {
            console.error("polaris: could not read calendars for automatic status:", caught);
            return null;
        });
        if (found) {
            for (const person of stale) {
                held.delete(person.id);
                held.set(person.id, { at, key: keyOf(person), events: found.get(person.id) ?? [] });
            }
            while (held.size > MEETINGS_HELD) held.delete(held.keys().next().value!);
        }
    }

    for (const person of people) {
        const events = held.get(person.id)?.events ?? [];
        answer.set(person.id, core.meetingAt(events, person.settings, now));
    }
    return answer;
}

/** Forget what was held, for tests. */
export function forgetMeetings(): void {
    held.clear();
}
