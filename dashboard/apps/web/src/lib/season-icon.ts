/**
 * The addresses of the Polaris mark in a season's dress, for the places a
 * browser or a system fetches an icon by URL before any script runs: the tab's
 * first icon, the home-screen icon, the installed app's icons.
 *
 * The season is part of the address, so a browser that cached last season's
 * icon fetches the new one - a favicon is only refetched when its URL changes.
 * Without a season these are the plain files in public/.
 */

import * as core from "@polaris/core";

/** The raster sizes asked for: Apple's home-screen icon and the manifest's. */
export const SEASON_ICON_SIZES = [128, 180, 192, 512] as const;

export type SeasonIconSize = (typeof SEASON_ICON_SIZES)[number];

const PLAIN_PNG: Record<SeasonIconSize, string> = {
    128: "/polaris-mark-128.png",
    180: "/apple-touch-icon.png",
    192: "/polaris-mark-192.png",
    512: "/polaris-mark-512.png"
};

export function seasonIconSvg(season: core.Season | null): string {
    return season ? `/season-icon/${season}.svg` : "/icon.svg";
}

export function seasonIconPng(season: core.Season | null, size: SeasonIconSize): string {
    return season ? `/season-icon/${season}-${size}.png` : PLAIN_PNG[size];
}

/** The season and size a `/season-icon/<file>` address names, or null. */
export function parseSeasonIconFile(
    file: string
): { season: core.Season; size: SeasonIconSize | null } | null {
    const match = /^([A-Za-z]+)(?:-(\d+))?\.(svg|png)$/.exec(file);
    if (!match) return null;
    const season = core.SEASONS.find((each) => each === match[1]);
    if (!season) return null;
    if (match[3] === "svg") return match[2] ? null : { season, size: null };
    const size = SEASON_ICON_SIZES.find((each) => String(each) === match[2]);
    return size ? { season, size } : null;
}
