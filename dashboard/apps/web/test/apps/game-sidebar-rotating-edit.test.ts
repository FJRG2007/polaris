/**
 * Leaderboards taking turns on the side panel: every one of them can be chosen,
 * several at once the way files are in an explorer, and a pair already on the
 * panel can be chosen again.
 *
 * The report: the dialog stopped at eight, had no way to take several at once,
 * and once added the pair could only be picked apart text by text.
 */

import { describe, expect, it } from "vitest";
import { allChosen, pressedSelection } from "@polaris/ui";

const { SIDEBAR_BLOCKS, rotatingBlocksAt, withRotatingBlocks, withRotatingBlocksAt } = await import(
    "@polaris-app/game-servers/src/lib/minecraft/sidebar-blocks"
);
const { DEFAULT_SIDEBAR, SIDEBAR_FRAMES_MAX, SIDEBAR_LINES_MAX, plainLine, sidebarProblems } =
    await import("@polaris-app/game-servers/src/lib/minecraft/sidebar");

const blocks = (...ids: string[]) =>
    ids.map((id) => SIDEBAR_BLOCKS.find((block) => block.id === id)!);

describe("choosing several", () => {
    const order = ["a", "b", "c", "d", "e"];

    it("takes or leaves one with a press", () => {
        expect(pressedSelection(order, ["a"], "c", null)).toEqual(["a", "c"]);
        expect(pressedSelection(order, ["a", "c"], "a", "c")).toEqual(["c"]);
    });

    it("takes the whole stretch from the last press with Shift, and leaves it the same way", () => {
        expect(pressedSelection(order, ["b"], "e", "b", { shiftKey: true })).toEqual([
            "b",
            "c",
            "d",
            "e"
        ]);
        expect(pressedSelection(order, ["a", "b", "c", "d"], "b", "d", { shiftKey: true })).toEqual(
            ["a"]
        );
    });

    it("takes everything with Ctrl+A, keeping the turns already chosen first", () => {
        expect(allChosen(order, ["d", "a"])).toEqual(["d", "a", "b", "c", "e"]);
    });
});

describe("every leaderboard at once", () => {
    it("fits in one pair taking turns, and saves", () => {
        expect(SIDEBAR_BLOCKS.length).toBeLessThanOrEqual(SIDEBAR_FRAMES_MAX);
        const lines = withRotatingBlocks([], SIDEBAR_BLOCKS, 5, SIDEBAR_LINES_MAX)!;
        expect(lines[0]!.frames).toHaveLength(SIDEBAR_BLOCKS.length);
        const problems = sidebarProblems({ ...DEFAULT_SIDEBAR, enabled: true, lines });
        expect(problems.lines.flat().filter(Boolean)).toEqual([]);
    });
});

describe("a pair already on the panel", () => {
    const panel = [
        plainLine("Online"),
        ...withRotatingBlocks([], blocks("rank.deaths", "rank.mined", "rank.fish"), 8, 15)!
    ];

    it("is recognised at its heading, with its leaderboards in turn order", () => {
        expect(rotatingBlocksAt(panel, 1)).toEqual({
            ids: ["rank.deaths", "rank.mined", "rank.fish"],
            every: 8
        });
        expect(rotatingBlocksAt(panel, 0)).toBeNull();
        expect(rotatingBlocksAt(panel, 2)).toBeNull();
    });

    it("is still recognised after its list was restyled", () => {
        const restyled = panel.map((line, index) =>
            index === 2
                ? { ...line, frames: line.frames.map((text) => text.replace("&f", "&e&l")) }
                : line
        );
        expect(rotatingBlocksAt(restyled, 1)?.ids).toEqual([
            "rank.deaths",
            "rank.mined",
            "rank.fish"
        ]);
    });

    it("takes other leaderboards in place, keeping the texts and effects of the ones that stay", () => {
        const styled = panel.map((line, index) =>
            index === 1
                ? {
                      ...line,
                      frames: ["&cDeaths!", ...line.frames.slice(1)],
                      effect: { ...line.effect, kind: "shine" as const }
                  }
                : line
        );
        const next = withRotatingBlocksAt(
            styled,
            1,
            blocks("rank.fish", "rank.deaths", "rank.jumps"),
            4
        )!;
        expect(next).toHaveLength(panel.length);
        expect(next[0]).toEqual(panel[0]);
        expect(next[1]!.frames).toEqual([panel[1]!.frames[2], "&cDeaths!", "&6&lMost jumps"]);
        expect(next[1]!.effect.kind).toBe("shine");
        expect(next[1]!.every).toBe(4);
        expect(rotatingBlocksAt(next, 1)?.ids).toEqual(["rank.fish", "rank.deaths", "rank.jumps"]);
    });

    it("is left alone when the line is not such a pair", () => {
        expect(withRotatingBlocksAt(panel, 0, blocks("rank.fish", "rank.jumps"), 4)).toBeNull();
    });
});
