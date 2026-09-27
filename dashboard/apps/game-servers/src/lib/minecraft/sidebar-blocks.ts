/**
 * Ready-made pieces for the side panel: a heading and the list or value under
 * it. The variables behind them are all typeable, but nobody finds
 * `{rank.deaths}` by guessing - this is the way in that does not need knowing
 * the name first.
 */

import { plainLine, type SidebarLine } from "./sidebar";
import { RANKINGS, STATS_RANKINGS } from "./rankings";

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
        label: "Top levels",
        lines: ["&6&lTop levels", '&f{rank.level | "Nobody on"}']
    },
    ...STATS_RANKINGS.map((id) => ({
        id,
        label: RANKINGS[id].label,
        lines: [`&6&l${RANKINGS[id].label}`, `&f{${id} | "Nobody yet"}`]
    })),
    {
        id: "death",
        label: "Last death",
        lines: ["&6&lLast death", '&7{death.message | "Nobody has died"}']
    },
    {
        id: "server.levels",
        label: "Everybody's level",
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
    const turn = (frames: string[]): SidebarLine => ({
        ...plainLine(frames[0] ?? ""),
        frames,
        every
    });
    return [
        ...lines,
        turn(blocks.map((block) => block.lines[0] ?? "")),
        turn(blocks.map((block) => block.lines[1] ?? ""))
    ];
}
