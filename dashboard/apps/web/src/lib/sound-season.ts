/**
 * Which season's sounds play in this tab, or null for the ordinary ones.
 *
 * A module value rather than context because the sounds are plain functions
 * called from timers and streams no hook reaches. Set by the frame (see
 * `components/seasonal`) from the account's choice, the deployment's switch and
 * the reader's own calendar; read by the call sounds and the alert chime.
 */

import type { Season } from "@polaris/core";

let current: Season | null = null;

export function soundSeason(): Season | null {
    return current;
}

export function setSoundSeason(season: Season | null): void {
    current = season;
}
