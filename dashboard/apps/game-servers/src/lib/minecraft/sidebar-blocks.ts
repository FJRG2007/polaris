/**
 * Ready-made pieces for the side panel: a heading and the list or value under
 * it. The variables behind them are all typeable, but nobody finds
 * `{rank.deaths}` by guessing - this is the way in that does not need knowing
 * the name first.
 */

import { EVENTS_RANKING, RANKINGS, STATS_RANKINGS } from "./rankings";
import { plainLine, type SidebarLine } from "./sidebar";

export interface SidebarBlock {
    readonly id: string;
    /** What the menu offers. */
    readonly label: string;
    /** The lines it adds, heading first. */
    readonly lines: readonly string[];
}

export const SIDEBAR_BLOCKS: readonly SidebarBlock[] = [
    {
        id: "rank.level",
        label: "Top levels", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        lines: ["&6&lTop levels", '&f{rank.level | "Nobody on"}']
    },
    ...STATS_RANKINGS.map((id) => ({
        id,
        label: RANKINGS[id].label,
        lines: [`&6&l${RANKINGS[id].label}`, `&f{${id} | "Nobody yet"}`]
    })),
    {
        id: EVENTS_RANKING,
        label: "Most events won", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        lines: ["&6&lEvent winners", `&f{${EVENTS_RANKING} | "No winners yet"}`]
    },
    {
        id: "death",
        label: "Last death", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        lines: ["&6&lLast death", '&7{death.message | "Nobody has died"}']
    },
    {
        id: "server.levels",
        label: "Everybody's level", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        lines: ["&6&lLevels", '&f{server.levels | "Nobody on"}']
    }
];

/** The panel's lines with a block added at the end, or null when it does not
 *  fit in `max` lines. */
export function withBlock(
    lines: readonly SidebarLine[],
    block: SidebarBlock,
    max: number
): SidebarLine[] | null {
    return lines.length + block.lines.length > max
        ? null
        : [...lines, ...block.lines.map(plainLine)];
}

/**
 * Several blocks in the room of one, taking turns: a heading line and a line
 * under it, each with one text per block, turning together every `every`
 * seconds. The way to show several leaderboards on a panel of fifteen lines.
 * Null when it does not fit, or for fewer than two blocks.
 */
export function withRotatingBlocks(
    lines: readonly SidebarLine[],
    blocks: readonly SidebarBlock[],
    every: number,
    max: number
): SidebarLine[] | null {
    if (blocks.length < 2 || lines.length + 2 > max) return null;
    return [...lines, ...turnLines(blocks, every, null, lines.length)];
}

/** The block a list line's text shows: written as the block writes it, or
 *  with the block's variable in it however it was restyled since. */
function blockShowing(text: string): SidebarBlock | null {
    const shown = variableIn(text);
    return (
        SIDEBAR_BLOCKS.find((block) => block.lines[1] === text) ??
        (shown
            ? SIDEBAR_BLOCKS.find((block) => variableIn(block.lines[1] ?? "") === shown)
            : null) ??
        null
    );
}

/** The first variable a text shows, by name. */
function variableIn(text: string): string | null {
    return /\{\s*([\w.]+)\s*[|}]/.exec(text)?.[1]?.toLowerCase() ?? null;
}

/**
 * The leaderboards the line at `at` and the one under it take turns between,
 * in turn order, and how long each shows - when they are a pair made by
 * `withRotatingBlocks`. Null for any other line, so only such a pair offers
 * to be chosen again.
 */
export function rotatingBlocksAt(
    lines: readonly SidebarLine[],
    at: number
): { readonly ids: string[]; readonly every: number } | null {
    const heading = lines[at];
    const list = lines[at + 1];
    if (!heading || !list || heading.frames.length < 2) return null;
    if (heading.frames.length !== list.frames.length) return null;
    // A heading shows no leaderboard of its own; a pair starts at the heading.
    if (heading.frames.some((text) => blockShowing(text))) return null;
    const ids = list.frames.map((text) => blockShowing(text)?.id ?? null);
    if (ids.some((id) => id === null)) return null;
    return { ids: ids as string[], every: heading.every };
}

/**
 * The pair at `at` taking turns between other leaderboards. One that stays
 * keeps its texts as they were restyled, and the lines keep their effects;
 * one that is new comes as its block writes it.
 */
export function withRotatingBlocksAt(
    lines: readonly SidebarLine[],
    at: number,
    blocks: readonly SidebarBlock[],
    every: number
): SidebarLine[] | null {
    if (blocks.length < 2 || !rotatingBlocksAt(lines, at)) return null;
    return [...lines.slice(0, at), ...turnLines(blocks, every, lines, at), ...lines.slice(at + 2)];
}

/** The heading line and the list line of a pair, from `lines` at `at` where it
 *  already has them. */
function turnLines(
    blocks: readonly SidebarBlock[],
    every: number,
    lines: readonly SidebarLine[] | null,
    at: number
): [SidebarLine, SidebarLine] {
    const had = lines ? rotatingBlocksAt(lines, at) : null;
    const line = (row: 0 | 1): SidebarLine => {
        const frames = blocks.map((block) => {
            const was = had ? had.ids.indexOf(block.id) : -1;
            return was >= 0 ? (lines?.[at + row]?.frames[was] ?? "") : (block.lines[row] ?? "");
        });
        const before = had ? lines?.[at + row] : undefined;
        return { ...(before ?? plainLine("")), frames, every };
    };
    return [line(0), line(1)];
}
