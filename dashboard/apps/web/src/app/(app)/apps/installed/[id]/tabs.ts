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
    /** What one game calls this screen, where the shared name would be wrong.
     *  A Minecraft mod and a FiveM resource are the same tab and not the same
     *  word, and calling a FiveM server's resources "mods" is the sort of thing
     *  that makes an operator wonder whether they are on the right screen. */
    readonly labelByGame?: Partial<Record<GameId, string>>;
    /** What the viewer needs on this server to open it. */
    readonly permission: Permission;
    /** The games that actually have this screen. A Minecraft world can be
     *  regenerated from a seed and an ARK one cannot. Offering a screen the game
     *  has nothing behind is worse than not offering it - it opens on an error. */
    readonly games: readonly GameId[];
}

const EVERY_GAME: readonly GameId[] = ["minecraft", "ark", "fivem"];

export const GAME_TABS: readonly GameTab[] = [
    { slug: "", label: "Overview", permission: "games.read", games: EVERY_GAME },
    { slug: "console", label: "Console", permission: "games.console", games: EVERY_GAME },
    // Titles, a line in the chat and a sound, written with colours rather than
    // typed as JSON into the console. The same grant, since it is the server
    // talking to everybody on it; Minecraft only, the one game with titles.
    { slug: "announce", label: "Announce", permission: "games.console", games: ["minecraft"] },
    // The box on the right of every player's screen. Its own screen rather than
    // the bottom of Announce, where nobody looking for it thought to scroll.
    { slug: "panel", label: "Side panel", permission: "games.console", games: ["minecraft"] },
    // The chat group or space the server talks through: whose call `{call.*}`
    // reads, where members ask it `/online`, where announcements are repeated.
    // A setting of the server, so the manager's.
    { slug: "chat", label: "Linked chat", permission: "games.manage", games: ["minecraft"] },
    { slug: "players", label: "Players", permission: "games.read", games: EVERY_GAME },
    { slug: "world", label: "World", permission: "games.manage", games: ["minecraft"] },
    { slug: "rules", label: "Rules", permission: "games.read", games: EVERY_GAME },
    {
        slug: "mods",
        label: "Mods",
        labelByGame: { fivem: "Resources" },
        permission: "games.manage",
        games: EVERY_GAME
    },
    { slug: "usage", label: "Usage", permission: "games.read", games: EVERY_GAME },
    { slug: "security", label: "Security", permission: "games.manage", games: EVERY_GAME },
    // Anti X-Ray and the movement watch: reading the evidence is a moderator's,
    // as it is on the players it is about.
    { slug: "anticheat", label: "Anti-cheat", permission: "games.moderate", games: ["minecraft"] },
    { slug: "access", label: "Access", permission: "games.read", games: EVERY_GAME },
    // Restarts, backups, sleeping when empty: when things happen on their own.
    { slug: "schedule", label: "Schedule", permission: "games.manage", games: EVERY_GAME },
    { slug: "settings", label: "Settings", permission: "games.manage", games: EVERY_GAME }
];

/** What this game calls one screen. */
export function gameTabLabel(tab: GameTab, game: GameId | null): string {
    return (game && tab.labelByGame?.[game]) || tab.label;
}

/** The screens one game has at all, before anything about the viewer. */
export function tabsForGame(game: GameId | null): GameTab[] {
    return GAME_TABS.filter((tab) => game === null || tab.games.includes(game));
}

/** Whether a slug from the URL names one of the screens this game has. */
export function isGameTab(slug: string, game: GameId | null = null): boolean {
    return tabsForGame(game).some((tab) => tab.slug === slug);
}

/** The screens this viewer may open, given what they hold on this server. */
export function visibleGameTabs(
    held: readonly Permission[],
    game: GameId | null = null
): GameTab[] {
    return tabsForGame(game).filter((tab) => held.includes(tab.permission));
}

/** Whether this viewer may open one screen. */
export function canOpenGameTab(
    slug: string,
    held: readonly Permission[],
    game: GameId | null = null
): boolean {
    const tab = tabsForGame(game).find((entry) => entry.slug === slug);
    return tab !== undefined && held.includes(tab.permission);
}

/** Where a screen lives, so every link is built the same way. */
export function gameTabHref(installedAppId: string, slug: string): string {
    return slug ? `/apps/installed/${installedAppId}/${slug}` : `/apps/installed/${installedAppId}`;
}
