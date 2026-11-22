/**
 * What this page tells a client whose icon is shared with other Polaris hosts -
 * the desktop app's window, taskbar, tray and Dock icon, the phone app's
 * launcher icon - so the client can settle every host's report by one rule
 * (`appIconSeason` in core) instead of wearing whichever page spoke last.
 *
 * The page only knows its own host, so it reports that host's calendar and the
 * season this host alone would choose by the same rule, plus the dressed marks
 * the client may need: this host's own season and the official one, the only
 * two the rule can pick from this host's report.
 */

import * as core from "@polaris/core";

export interface AppIconReport {
    /** The season this host alone would put on the icon. */
    readonly season: core.Season | null;
    /** Whether that season is the one of Polaris's own calendar. */
    readonly official: boolean;
    /** This host's calendar, null when its seasons are off. */
    readonly calendar: core.SeasonCalendar | null;
    /** The seasons the client may end up wearing from this report. */
    readonly seasons: readonly core.Season[];
}

export function appIconReport(calendar: core.SeasonCalendar | null, now: Date): AppIconReport {
    const host = "self";
    const season = core.appIconSeason([{ host, calendar }], now);
    const official = core.officialSeasonOn(now);
    const own = calendar ? core.seasonOn(now, calendar) : null;
    const seasons = calendar ? [...new Set([official, own].filter((s): s is core.Season => !!s))] : [];
    return { season, official: !!season && season === official, calendar, seasons };
}
