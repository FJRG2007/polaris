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
import type { GameId } from "@/lib/apps/games-catalog";

export interface GameTab {
    /** The path segment, and the empty string for the screen the bare id shows. */
    readonly slug: string;
    readonly label: string;
    /** What the viewer needs on this server to open it. */
    readonly permission: Permission;
    /** The games that actually have this screen. A Minecraft world can be
     *  regenerated from a seed and an ARK one cannot; ARK has no mod loader Polaris
     *  drives and no gamerules to toggle. Offering a screen the game has nothing
     *  behind is worse than not offering it - it opens on an error. */
    readonly games: readonly GameId[];
}

const EVERY_GAME: readonly GameId[] = ["minecraft", "ark"];

export const GAME_TABS: readonly GameTab[] = [
    { slug: "", label: "Overview", permission: "games.read", games: EVERY_GAME },
    { slug: "console", label: "Console", permission: "games.console", games: EVERY_GAME },
    { slug: "players", label: "Players", permission: "games.read", games: EVERY_GAME },
    { slug: "world", label: "World", permission: "games.manage", games: ["minecraft"] },
    { slug: "rules", label: "Rules", permission: "games.read", games: ["minecraft"] },
    { slug: "mods", label: "Mods", permission: "games.manage", games: ["minecraft"] },
    { slug: "usage", label: "Usage", permission: "games.read", games: EVERY_GAME },
    { slug: "security", label: "Security", permission: "games.manage", games: EVERY_GAME },
    { slug: "access", label: "Access", permission: "games.read", games: EVERY_GAME },
    { slug: "settings", label: "Settings", permission: "games.manage", games: EVERY_GAME }
];

/** The screens one game has at all, before anything about the viewer. */
export function tabsForGame(game: GameId | null): GameTab[] {
    return GAME_TABS.filter((tab) => game === null || tab.games.includes(game));
}

/** Whether a slug from the URL names one of the screens this game has. */
export function isGameTab(slug: string, game: GameId | null = null): boolean {
    return tabsForGame(game).some((tab) => tab.slug === slug);
}

/** The screens this viewer may open, given what they hold on this server. */
export function visibleGameTabs(held: readonly Permission[], game: GameId | null = null): GameTab[] {
    return tabsForGame(game).filter((tab) => held.includes(tab.permission));
}

/** Whether this viewer may open one screen. */
export function canOpenGameTab(slug: string, held: readonly Permission[], game: GameId | null = null): boolean {
    const tab = tabsForGame(game).find((entry) => entry.slug === slug);
    return tab !== undefined && held.includes(tab.permission);
}

/** Where a screen lives, so every link is built the same way. */
export function gameTabHref(installedAppId: string, slug: string): string {
    return slug ? `/apps/installed/${installedAppId}/${slug}` : `/apps/installed/${installedAppId}`;
}
