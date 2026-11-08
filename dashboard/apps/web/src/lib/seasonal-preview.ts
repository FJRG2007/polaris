/**
 * An admin trying a season on: its look and its sounds, forced for the session
 * that asked, whatever the date or the calendar says. Nobody else sees it.
 *
 * Kept in a cookie so the root layout can paint the first frame in it, with no
 * flash. The cookie names the session it was set on: another account signed in
 * on the same browser, or the same account on a later session, reads nothing.
 */

import * as core from "@polaris/core";
import { cookies, headers } from "next/headers";

export const SEASON_PREVIEW_COOKIE = "polaris.seasonPreview";

/** The season a cookie value previews for this session, or null. */
export function readSeasonPreview(
    value: string | undefined,
    sessionId: string | null | undefined
): core.Season | null {
    if (!value || !sessionId) return null;
    const cut = value.lastIndexOf(":");
    if (cut <= 0 || value.slice(0, cut) !== sessionId) return null;
    const season = value.slice(cut + 1);
    return (core.SEASONS as readonly string[]).includes(season) ? (season as core.Season) : null;
}

/** The season this session is previewing, or null. */
export async function seasonPreviewFor(
    sessionId: string | null | undefined
): Promise<core.Season | null> {
    return readSeasonPreview((await cookies()).get(SEASON_PREVIEW_COOKIE)?.value, sessionId);
}

/** Start previewing a season on this session, or stop with null. */
export async function setSeasonPreview(
    sessionId: string,
    season: core.Season | null
): Promise<void> {
    const store = await cookies();
    if (!season) {
        store.delete(SEASON_PREVIEW_COOKIE);
        return;
    }
    // A session cookie: a preview is for testing, never something left behind.
    store.set(SEASON_PREVIEW_COOKIE, `${sessionId}:${season}`, {
        httpOnly: true,
        sameSite: "lax",
        // Secure where the browser reached Polaris over HTTPS; a LAN install on
        // plain HTTP would otherwise never get the cookie back.
        secure: (await headers()).get("x-forwarded-proto")?.split(",")[0]?.trim() === "https",
        path: "/"
    });
}
