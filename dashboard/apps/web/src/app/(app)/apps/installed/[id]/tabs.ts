/**
 * A game server's screens, as data.
 *
 * Each one is a real path (`/apps/installed/<id>/console`) rather than a piece of
 * client state, so a screen can be reloaded, bookmarked and sent to somebody -
 * an operator who reloads while reading the console should land back on the
 * console, not on the overview.
 *
 * Deliberately outside the client component that renders them: the route reads
 * this list to decide whether a slug is real, and a value exported from a
 * "use client" module arrives there as a client reference rather than the array
 * itself - which fails at request time, not at build time.
 */

export interface GameTab {
    /** The path segment, and the empty string for the screen the bare id shows. */
    readonly slug: string;
    readonly label: string;
}

export const GAME_TABS: readonly GameTab[] = [
    { slug: "", label: "Overview" },
    { slug: "console", label: "Console" },
    { slug: "players", label: "Players" },
    { slug: "mods", label: "Mods" },
    { slug: "usage", label: "Usage" },
    { slug: "settings", label: "Settings" }
];

/** Whether a slug from the URL names one of the screens. */
export function isGameTab(slug: string): boolean {
    return GAME_TABS.some((tab) => tab.slug === slug);
}

/** Where a screen lives, so every link is built the same way. */
export function gameTabHref(installedAppId: string, slug: string): string {
    return slug ? `/apps/installed/${installedAppId}/${slug}` : `/apps/installed/${installedAppId}`;
}
