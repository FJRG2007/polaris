/**
 * The rules every parkour course keeps (`parkour-layout`), checked over
 * thousands of courses: nothing touches, every jump has head room, the
 * checkpoints are spread out, and a trap or a slime pad only where it makes
 * sense.
 */

import { describe, expect, it } from "vitest";
import * as parkour from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour";
import * as layout from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/parkour-layout";

type Difficulty = "easy" | "medium" | "hard";

const courseOf = (difficulty: Difficulty, jumps: number, seed: string, design?: number) =>
    parkour.course(
        { place: { mode: "players" }, jumps, difficulty, height: 30 } as never,
        seed,
        { x: 40, z: -12 },
        100,
        design
    );

const SHAPES = (["easy", "medium", "hard"] as const).flatMap((difficulty) =>
    [8, 13, 20, 31, 45].map((jumps) => ({ difficulty, jumps }))
);

describe("a parkour course's layout", () => {
    it("keeps every rule, over thousands of courses", () => {
        let courses = 0;
        let slimes = 0;
        let specials = 0;
        for (const { difficulty, jumps } of SHAPES)
            for (let seed = 0; seed < 200; seed += 1) {
                const course = courseOf(difficulty, jumps, `layout-${seed}`);
                courses += 1;
                expect(course.platforms).toHaveLength(jumps + 1);
                expect(layout.layoutProblems(course.platforms)).toEqual([]);
                for (const one of course.platforms) {
                    if (one.trap === "slime") slimes += 1;
                    if (one.trap || one.climb) specials += 1;
                }
            }
        expect(courses).toBe(3000);
        // Still a course worth running: traps and climbs on plenty of them.
        expect(slimes).toBeGreaterThan(500);
        expect(specials).toBeGreaterThan(3000);
    });

    it("finds what was wrong with courses laid out before the rules", () => {
        const found = new Set<string>();
        for (let seed = 0; seed < 200; seed += 1)
            for (const problem of layout.layoutProblems(
                courseOf("hard", 40, `old-${seed}`, 2).platforms
            ))
                found.add(problem.replace(/\d+/g, "#"));
        expect([...found].sort()).toEqual([
            "platform # is in the way of jump #",
            "platforms # and # touch",
            "slime pad # throws nobody onto the next platform",
            "special # comes right after something else",
            "special # comes right before something else"
        ]);
    });

    it("keeps a race already running on the course it was built as", () => {
        const before = courseOf("hard", 30, "running", 2);
        expect(courseOf("hard", 30, "running", 2)).toEqual(before);
        expect(before.platforms.some((one) => one.turn)).toBe(false);
        expect(courseOf("hard", 30, "running").platforms.some((one) => one.turn)).toBe(true);
    });

    it("puts the finish at least a few jumps past the last checkpoint", () => {
        for (const jumps of [7, 8, 12, 13, 14, 19, 20, 25, 26])
            for (let seed = 0; seed < 20; seed += 1) {
                const { checkpoints } = courseOf("medium", jumps, `finish-${seed}`);
                expect(checkpoints.at(-1)).toBe(jumps);
                const last = checkpoints.at(-2) ?? 0;
                expect(jumps - last).toBeGreaterThanOrEqual(layout.FINISH_AFTER);
                for (let at = 1; at < checkpoints.length - 1; at += 1)
                    expect(checkpoints[at]! - checkpoints[at - 1]!).toBe(layout.CHECK_EVERY);
            }
    });

    it("never puts a trap or a climb next to the start, a checkpoint, the finish or a turn", () => {
        for (let seed = 0; seed < 300; seed += 1) {
            const { platforms } = courseOf("hard", 40, `traps-${seed}`);
            platforms.forEach((one, index) => {
                if (!one.trap && !one.climb) return;
                for (const near of [platforms[index - 1]!, platforms[index + 1]!]) {
                    expect(near.role).toBe("jump");
                    expect(near.turn).toBeUndefined();
                    expect(near.trap ?? near.climb).toBeUndefined();
                }
            });
        }
    });
});

describe("a slime pad's bounce", () => {
    it("falls back short of how high the jump onto it went, as the game's does", () => {
        const level = layout.bounce(0, 0);
        // A jump tops out about 1.25 blocks up; the bounce off a pad at the
        // same height loses some of that to drag.
        expect(level.apex).toBeGreaterThan(0.8);
        expect(level.apex).toBeLessThan(1.25);
        expect(layout.bounce(2, 0).apex).toBeGreaterThan(level.apex);
        expect(level.ticks).toBeGreaterThan(5);
    });

    it("is only laid where it carries whoever lands on it onto the next platform", () => {
        const pad: parkour.Platform = { x: 0, y: 10, z: 0, size: 1, role: "jump", trap: "slime" };
        const before: parkour.Platform = { x: -2, y: 10, z: 0, size: 1, role: "jump" };
        const level: parkour.Platform = { x: 2, y: 10, z: 0, size: 1, role: "jump" };
        expect(layout.bounceReaches(before, pad, level)).toBe(true);
        // Higher than a bounce off a jump at the same height ever goes.
        expect(layout.bounceReaches(before, pad, { ...level, y: 11 })).toBe(false);
        // Further than anybody carries in the air.
        expect(layout.bounceReaches(before, pad, { ...level, x: 5 })).toBe(false);
        let checked = 0;
        for (let seed = 0; seed < 300; seed += 1) {
            const { platforms } = courseOf("hard", 40, `slime-${seed}`);
            platforms.forEach((one, index) => {
                if (one.trap !== "slime") return;
                checked += 1;
                expect(platforms[index + 1]!.y).toBe(one.y);
                expect(
                    layout.bounceReaches(platforms[index - 1]!, one, platforms[index + 1]!)
                ).toBe(true);
            });
        }
        expect(checked).toBeGreaterThan(100);
    });
});

describe("the layout rules themselves", () => {
    const at = (x: number, y: number, z: number, extra: Partial<parkour.Platform> = {}) =>
        ({ x, y, z, size: 1, role: "jump", ...extra }) as parkour.Platform;

    it("sees two platforms touching, diagonals and stacked too close included", () => {
        const start = at(-6, 0, 0, { size: 5, role: "start" });
        expect(layout.layoutProblems([start, at(0, 0, 2), at(2, 0, 2)])).toEqual([]);
        // Corner to corner.
        expect(layout.layoutProblems([start, at(0, 0, 2), at(2, 0, 2), at(3, 0, 3)])).toContain(
            "platforms 2 and 3 touch"
        );
        // Over another, inside its head room.
        expect(
            layout.layoutProblems([start, at(0, 0, 2), at(2, 0, 2), at(4, 0, 2), at(2, 3, 2)])
        ).toEqual(
            expect.arrayContaining(["platforms 2 and 4 touch", "platform 4 is in the way of jump 3"])
        );
    });

    it("sees a slime pad right before a turn, and checkpoints bunched up", () => {
        const start = at(-6, 0, 0, { size: 5, role: "start" });
        const problems = layout.layoutProblems([
            start,
            at(0, 0, 2),
            at(2, 0, 2, { trap: "slime" }),
            at(2, 1, 4, { turn: true }),
            at(2, 2, 6, { size: 3, role: "checkpoint" }),
            at(0, 2, 10, { size: 3, role: "finish" })
        ]);
        expect(problems).toEqual(
            expect.arrayContaining([
                "special 2 comes right before something else",
                "slime pad 2 throws nobody onto the next platform",
                "checkpoints 4 and 5 too close"
            ])
        );
    });
});
