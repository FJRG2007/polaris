/**
 * What the server list is, before anything draws it: what one row knows, what
 * state it is in, and how a search, a filter and a sort fold a set of them into
 * the rows actually on screen.
 *
 * Pure, and apart from the view for the usual reason - the rules are worth testing
 * without a browser, and "which of these is in trouble" is a question the badge and
 * the sort must answer identically. Two implementations of that would let a table
 * sorted by status put a green row above a red one.
 *
 * All of it runs on rows that are already in the browser. A dozen servers is not a
 * data set; asking the server to filter would put a round trip between a keystroke
 * and a table that could have been reordered as it was typed.
 */

import type { GameId } from "@/lib/apps/games-catalog";
import type { GameServerFacts, GameServerLive } from "@/lib/apps/games-service";

/** What the page knows about one server before anything is polled. */
export interface GameServerSeed {
    id: string;
    name: string;
    catalogId: string;
    catalogName: string;
    /** Which game it plays. Null only for a catalog that has drifted. */
    game: GameId | null;
    /** The service behind it, for the screens that reach past the game. */
    applicationId: string | null;
    status: string;
    /** Whether this viewer may start, stop and redeploy THIS server. Access is per
     *  server: a table can hold one somebody runs and one they were only invited to
     *  watch. */
    canManage: boolean;
    /** Whether they may delete it. The owner's, and an administrator's. */
    canRemove: boolean;
    /** Where THIS viewer keeps it. Not a property of the server: the same one is
     *  its owner's favourite and one of four somebody else was invited to help
     *  with. */
    favorite: boolean;
    archived: boolean;
}

/** What a row is, as its two reads catch up with the seed. */
export interface ServerView extends GameServerSeed {
    /** Where it runs and where a player connects. Null until the first read. */
    facts: GameServerFacts | null;
    /** Who is on it. Null until the servers themselves have answered. */
    live: GameServerLive | null;
}

/** What the two sortable columns sort on, and nothing being sorted at all. */
export type SortKey = "status" | "players" | null;
export type SortDir = "asc" | "desc";

/** Which way a column sorts on the first click, chosen per column because the
 *  interesting end differs: the servers with something wrong, and the servers with
 *  people on them. */
export const FIRST_CLICK: Record<Exclude<SortKey, null>, SortDir> = { status: "asc", players: "desc" };

/** The states a row can report, worst first. Sorting by status ascending puts
 *  everything that needs somebody at the top, which is the only reason to sort a
 *  list of servers by what they are doing. */
export const STATUS_ORDER = ["failed", "down", "starting", "online", "stopped", "unknown"] as const;
export type StatusKind = (typeof STATUS_ORDER)[number];

/** What each status is called on the row, and how the badge is toned. */
export const STATUS_BADGE: Record<StatusKind, { label: string; variant?: "danger" | "warning" | "success" }> = {
    failed: { label: "Failed", variant: "danger" },
    down: { label: "Not running", variant: "danger" },
    starting: { label: "Starting", variant: "warning" },
    online: { label: "Online", variant: "success" },
    stopped: { label: "Stopped" },
    unknown: { label: "Loading" }
};

/** The status filter's groups. Narrower than the badge: somebody filtering for what
 *  is wrong does not care whether it failed to build or fell over later. */
export const STATUS_FILTERS: Record<string, readonly StatusKind[]> = {
    online: ["online"],
    starting: ["starting"],
    stopped: ["stopped"],
    problem: ["failed", "down"]
};

/**
 * What one row is doing, in one word.
 *
 * An install that failed stays failed however the container reads: a create that
 * fell over leaves nothing running, and reporting that as merely "stopped" invites
 * somebody to press Start on a server that was never built. Meant to be up and not
 * running is neither stopped nor starting - something took it down from outside, or
 * it fell over. And a server that is up but has not answered yet is still starting:
 * saying it is online before it has said so would be reporting the container, which
 * is the thing an operator opens this page to distrust.
 */
export function statusOf(server: ServerView): StatusKind {
    const { facts, live } = server;
    if (server.status === "failed" && !facts?.running) return "failed";
    if (facts === null) return "unknown";
    if (!facts.running) return "stopped";
    if (live?.containerRunning === false) return "down";
    if (live === null) return "starting";
    return live.answering ? "online" : "starting";
}

/** Everything a row can be searched by. The address and the machine are in it
 *  because those are what somebody actually remembers about the server they are
 *  looking for. */
function haystack(server: ServerView): string {
    return [
        server.name,
        server.catalogName,
        server.facts?.address,
        server.facts?.serverName,
        server.facts?.release,
        server.facts?.software
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
}

/** The rows a search and the two filters leave. An empty filter is not a filter:
 *  every one of them only narrows when it has been set. */
export function filterServers(
    servers: readonly ServerView[],
    query: string,
    game: string,
    status: string
): ServerView[] {
    const wanted = query.trim().toLowerCase();
    const states = STATUS_FILTERS[status];
    return servers.filter((server) => {
        if (game && server.game !== game) return false;
        if (states && !states.includes(statusOf(server))) return false;
        return wanted.length === 0 || haystack(server).includes(wanted);
    });
}

/**
 * The rows in the order they are read in.
 *
 * Favourites first whatever the sort, because that is what starring one is for: a
 * list reordered by player count that buries the server somebody lives in has not
 * done what they asked. Below them, the chosen column, and the name to break every
 * tie - without it a table of stopped servers reshuffles itself on every poll.
 */
export function sortServers(servers: readonly ServerView[], key: SortKey, dir: SortDir): ServerView[] {
    const direction = dir === "asc" ? 1 : -1;
    return [...servers].sort((left, right) => {
        if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
        if (key === "status") {
            const gap = STATUS_ORDER.indexOf(statusOf(left)) - STATUS_ORDER.indexOf(statusOf(right));
            if (gap !== 0) return gap * direction;
        }
        if (key === "players") {
            const gap = (left.live?.online ?? 0) - (right.live?.online ?? 0);
            if (gap !== 0) return gap * direction;
        }
        return key === null ? 0 : left.name.localeCompare(right.name);
    });
}

/**
 * The line under the status badge: when the server came up, or when it last was.
 *
 * The same line a player's row carries, and for the same reason - "Stopped" is the
 * same word whether it went down ten minutes ago or in March, and those are not the
 * same server. Never both: a server that is answering has not "last been online",
 * and saying so beside a green badge reads as a contradiction. Null for a server
 * that has never been seen up, where there is nothing to say rather than a nothing
 * to print.
 */
export function uptimeLine(server: ServerView): { prefix: string; at: string } | null {
    const { facts, live } = server;
    if (!facts) return null;
    if (live?.answering === true) return facts.onlineSince ? { prefix: "up since", at: facts.onlineSince } : null;
    return facts.lastOnlineAt ? { prefix: "last up", at: facts.lastOnlineAt } : null;
}

/**
 * Whether this server's files can be browsed at all.
 *
 * The explorer runs its listing inside the container, so a server that is not
 * running has nothing to list - and it answered with an empty directory, which
 * reads as a world that has been deleted. A server Polaris means to be up and that
 * is not counts as down for this: the container is what would be read.
 */
export function canBrowseFiles(server: ServerView): boolean {
    return (server.facts?.running ?? false) && server.live?.containerRunning !== false;
}

/** What the server runs, in the two words an operator would say: "Paper 1.21.4",
 *  "1.21.51". Null for a game that updates itself, where a version column would be
 *  a column of dashes. */
export function releaseLabel(facts: GameServerFacts | null): string | null {
    if (!facts?.release) return null;
    return [facts.software, facts.release].filter(Boolean).join(" ");
}

/** The direction a click on a sortable column leaves it in, and null once it has
 *  come back round to the order the page was built in. */
export function nextSort(
    current: { key: SortKey; dir: SortDir },
    clicked: Exclude<SortKey, null>
): { key: SortKey; dir: SortDir } {
    if (current.key !== clicked) return { key: clicked, dir: FIRST_CLICK[clicked] };
    if (current.dir === FIRST_CLICK[clicked]) return { key: clicked, dir: current.dir === "asc" ? "desc" : "asc" };
    return { key: null, dir: FIRST_CLICK[clicked] };
}
