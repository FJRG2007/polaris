/**
 * Ready-made pieces for the side panel: a heading and the list or value under
 * it. The variables behind them are all typeable, but nobody finds
 * `{rank.deaths}` by guessing - this is the way in that does not need knowing
 * the name first.
 */

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
    {
        id: "rank.deaths",
        label: "Most deaths",
        lines: ["&6&lMost deaths", '&f{rank.deaths | "Nobody yet"}']
    },
    {
        id: "rank.kills",
        label: "Most mobs killed",
        lines: ["&6&lMost mobs killed", '&f{rank.kills | "Nobody yet"}']
    },
    {
        id: "rank.pvp",
        label: "Most players killed",
        lines: ["&6&lMost players killed", '&f{rank.pvp | "Nobody yet"}']
    },
    {
        id: "rank.playtime",
        label: "Most time played",
        lines: ["&6&lMost time played", '&f{rank.playtime | "Nobody yet"}']
    },
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
    lines: readonly string[],
    block: SidebarBlock,
    max: number
): string[] | null {
    return lines.length + block.lines.length > max ? null : [...lines, ...block.lines];
}
