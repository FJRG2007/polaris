/**
 * Which season an app-level icon wears when one client talks to several
 * Polaris hosts: the desktop app's window, taskbar, tray and Dock icon, the
 * phone app's launcher icon, the extension's toolbar button.
 *
 * Each host has its own calendar and its own switch, and an icon shared by all
 * of them cannot follow each one in turn - it would flip every time another
 * host's page spoke. So there is one rule, decided here and nowhere else:
 *
 * - Polaris's own calendar wins. When today falls inside a season of the
 *   calendar Polaris ships with, that season is worn, whatever dates any host
 *   moved or switched off.
 * - Only when no shipped season is in force may a host's own dates apply, and
 *   then the first host in a stable order (by its key, the origin) that has one
 *   decides, so the answer never depends on which page spoke last.
 * - A host whose operator turned seasons off (`calendar: null`) or that is too
 *   old to say (`calendar: undefined`) takes no part. With no host taking part
 *   the icon stays plain: an operator who said no is not overruled by the
 *   shipped dates.
 *
 * A tab's own icon is not app-level: it follows the host it shows.
 */

import { DEFAULT_SEASON_CALENDAR, seasonOn, type Season, type SeasonCalendar } from "./seasons.js";

export interface HostSeasonReport {
    /** What identifies the host, the same every time it reports: its origin. */
    readonly host: string;
    /** The host's calendar; null when its seasons are off; undefined when it
     *  predates reporting one. */
    readonly calendar: SeasonCalendar | null | undefined;
}

/** The season of the calendar Polaris ships with, on `now`'s local date. */
export function officialSeasonOn(now: Date): Season | null {
    return seasonOn(now, DEFAULT_SEASON_CALENDAR);
}

/** The season an icon shared by every host in `reports` wears on `now`. */
export function appIconSeason(reports: readonly HostSeasonReport[], now: Date): Season | null {
    const taking = reports
        .filter((report): report is HostSeasonReport & { calendar: SeasonCalendar } => !!report.calendar)
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    if (taking.length === 0) return null;
    const official = officialSeasonOn(now);
    if (official) return official;
    for (const report of taking) {
        const season = seasonOn(now, report.calendar);
        if (season) return season;
    }
    return null;
}
