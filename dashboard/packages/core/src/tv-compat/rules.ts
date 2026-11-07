/**
 * The answer for a TV that is not on the list, from what its Settings > About
 * screen says. Listed or not, an Android TV or Google TV on Android 8 or newer
 * is a Home screen; Fire TV opens Polaris TV as an app; anything else gets the
 * Network filter. LG and Samsung stay there until their apps ship.
 */

import type { TvPlatform, TvQuirkId, TvTier } from "./schema.js";

/** Polaris TV's minSdk 26: Android 8.0. */
export const MIN_ANDROID = 8;
/** Fire OS 5 refuses every package-manager route the install takes. */
export const MIN_FIRE_OS = 6;

export interface TvRuling {
    readonly tier: TvTier;
    /** The quirks worth saying for this answer, as sentences on screen. */
    readonly quirks: readonly TvQuirkId[];
}

/** The leading number of a version as typed: "11", "Android 9", "7.7.1.7". */
export function majorVersion(version: string | null | undefined): number | null {
    const match = /\d+/.exec(version ?? "");
    return match ? Number.parseInt(match[0], 10) : null;
}

/**
 * The tier a platform and version get. A version left out on Android counts as
 * new enough, since the desktop app checks it before installing anything.
 */
export function tierFor(platform: TvPlatform, version?: string | null): TvRuling {
    const major = majorVersion(version);
    switch (platform) {
        case "android-tv":
        case "google-tv":
            return major !== null && major < MIN_ANDROID
                ? { tier: "network", quirks: ["android-too-old"] }
                : { tier: "full", quirks: [] };
        case "android":
            return {
                tier: "network",
                quirks: [
                    major !== null && major < MIN_ANDROID ? "android-too-old" : "android-check"
                ]
            };
        case "fire-os":
            return major !== null && major < MIN_FIRE_OS
                ? { tier: "network", quirks: ["android-too-old"] }
                : { tier: "app", quirks: ["fire-home-amazon"] };
        case "webos":
            return { tier: "network", quirks: ["app-coming"] };
        case "tizen":
            return { tier: "network", quirks: ["app-coming", "samsung-2023-signing"] };
        default:
            return { tier: "network", quirks: [] };
    }
}
