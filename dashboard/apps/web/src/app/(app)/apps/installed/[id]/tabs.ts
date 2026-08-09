/**
 * A game server's screens, as data.
 *
 * Each one is a real path (`/apps/installed/<id>/console`) rather than a piece of
 * client state, so a screen can be reloaded, bookmarked and sent to somebody -
 * an operator who reloads while reading the console should land back on the
 * console, not on the overview.
 *
 * Each also carries the grant it needs on this particular server, because access
 * is not all-or-nothing any more: somebody invited to moderate sees who is playing
 * and can throw them out, and does not see the console, the worlds or the
 * settings. The tab bar is drawn from that, and the actions behind each screen
 * check it again - a screen that is merely hidden is not a screen anybody is kept
 * out of.
 *
 * Deliberately outside the client component that renders them: the route reads
 * this list to decide whether a slug is real, and a value exported from a
 * "use client" module arrives there as a client reference rather than the array
 * itself - which fails at request time, not at build time.
 */

import type { Permission } from "@polaris/core";

export interface GameTab {
    /** The path segment, and the empty string for the screen the bare id shows. */
    readonly slug: string;
    readonly label: string;
    /** What the viewer needs on this server to open it. */
    readonly permission: Permission;
}

export const GAME_TABS: readonly GameTab[] = [
    { slug: "", label: "Overview", permission: "games.read" },
    { slug: "console", label: "Console", permission: "games.manage" },
    { slug: "players", label: "Players", permission: "games.read" },
    { slug: "world", label: "World", permission: "games.manage" },
    { slug: "mods", label: "Mods", permission: "games.manage" },
    { slug: "usage", label: "Usage", permission: "games.read" },
    { slug: "security", label: "Security", permission: "games.manage" },
    { slug: "access", label: "Access", permission: "games.read" },
    { slug: "settings", label: "Settings", permission: "games.manage" }
];

/** Whether a slug from the URL names one of the screens. */
export function isGameTab(slug: string): boolean {
    return GAME_TABS.some((tab) => tab.slug === slug);
}

/** The screens this viewer may open, given what they hold on this server. */
export function visibleGameTabs(held: readonly Permission[]): GameTab[] {
    return GAME_TABS.filter((tab) => held.includes(tab.permission));
}

/** Whether this viewer may open one screen. */
export function canOpenGameTab(slug: string, held: readonly Permission[]): boolean {
    const tab = GAME_TABS.find((entry) => entry.slug === slug);
    return tab !== undefined && held.includes(tab.permission);
}

/** Where a screen lives, so every link is built the same way. */
export function gameTabHref(installedAppId: string, slug: string): string {
    return slug ? `/apps/installed/${installedAppId}/${slug}` : `/apps/installed/${installedAppId}`;
}
