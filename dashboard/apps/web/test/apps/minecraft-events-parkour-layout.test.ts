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

const courseOf = (
    difficulty: Difficulty,
    jumps: number,
    seed: string,
    design?: number,
    shapes: readonly ("rows" | "tower")[] = ["rows", "tower"]
) =>
    parkour.course(
        { place: { mode: "players" }, jumps, difficulty, height: 30, shapes } as never,
        seed,
        { x: 40, z: -12 },
        100,
        design
    );

const SHAPES = (["easy", "medium", "hard"] as const).flatMap((difficulty) =>
    [8, 13, 20, 31, 45].map((jumps) => ({ difficulty, jumps }))
);

describe("a parkour course's layout", () => {
    it("keeps every rule and leaves nothing to skip, over thousands of courses of both shapes", () => {
        let courses = 0;
        let slimes = 0;
        let specials = 0;
        for (const shape of ["rows", "tower"] as const)
            for (const { difficulty, jumps } of SHAPES)
                for (let seed = 0; seed < 100; seed += 1) {
                    const course = courseOf(difficulty, jumps, `layout-${seed}`, undefined, [
                        shape
                    ]);
                    courses += 1;
                    expect(course.platforms).toHaveLength(jumps + 1);
                    expect(layout.layoutProblems(course.platforms)).toEqual([]);
                    expect(layout.skipProblems(course.platforms)).toEqual([]);
                    for (const one of course.platforms) {
                        if (one.trap === "slime") slimes += 1;
                        if (one.trap || one.climb) specials += 1;
                    }
                }
        expect(courses).toBe(3000);
        // Still a course worth running: traps and climbs on plenty of them.
        // Fewer slime pads than before nothing could be skipped: a pad's
        // bounce has to reach the next platform, and the jump before the pad
        // must not.
        expect(slimes).toBeGreaterThan(150);
        expect(specials).toBeGreaterThan(3000);
    });

    it("draws the shape among those the event leaves on, the same for the same run", () => {
        const drawn = new Set<string>();
        for (let seed = 0; seed < 40; seed += 1)
            drawn.add(parkour.shapeFor({ shapes: ["rows", "tower"] } as never, `shape-${seed}`));
        expect([...drawn].sort()).toEqual(["rows", "tower"]);
        for (let seed = 0; seed < 20; seed += 1)
            expect(parkour.shapeFor({ shapes: ["tower"] } as never, `shape-${seed}`)).toBe("tower");
        expect(parkour.shapeFor({ shapes: ["rows", "tower"] } as never, "same")).toBe(
            parkour.shapeFor({ shapes: ["rows", "tower"] } as never, "same")
        );
        // A tower goes round its four sides; rows only back and forth.
        const tower = courseOf("medium", 30, "round", undefined, ["tower"]).platforms.slice(1);
        const xs = tower.map((one) => one.x);
        const zs = tower.map((one) => one.z);
        expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(layout.TOWER_SIDE + 2);
        expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(5);
        expect(tower.at(-1)!.y).toBeGreaterThan(tower[0]!.y + 10);
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
                // Level with the pad, or a block down from it.
                expect(one.y - platforms[index + 1]!.y).toBeGreaterThanOrEqual(0);
                expect(one.y - platforms[index + 1]!.y).toBeLessThanOrEqual(1);
                expect(
                    layout.bounceReaches(platforms[index - 1]!, one, platforms[index + 1]!)
                ).toBe(true);
            });
        }
        expect(checked).toBeGreaterThan(30);
    });
});

describe("nothing but the next platform within a jump", () => {
    const at = (x: number, y: number, z: number, extra: Partial<parkour.Platform> = {}) =>
        ({ x, y, z, size: 1, role: "jump", ...extra }) as parkour.Platform;

    it("takes a jump as far as a sprint jump goes, a little further falling, never two up", () => {
        expect(layout.reachAcross(0)).toBe(4);
        expect(layout.reachAcross(1)).toBe(3);
        expect(layout.reachAcross(2)).toBe(-1);
        expect(layout.reachAcross(-1)).toBe(5);
        expect(layout.reachAcross(-10)).toBe(7);
        // Four blocks of air on the level is in reach; five is not.
        expect(layout.reaches(at(0, 5, 0), at(5, 5, 0))).toBe(true);
        expect(layout.reaches(at(0, 5, 0), at(6, 5, 0))).toBe(false);
        // A block up: three; two up, never.
        expect(layout.reaches(at(0, 5, 0), at(4, 6, 0))).toBe(true);
        expect(layout.reaches(at(0, 5, 0), at(5, 6, 0))).toBe(false);
        expect(layout.reaches(at(0, 5, 0), at(2, 7, 0))).toBe(false);
        // Diagonals count as the longer way.
        expect(layout.reaches(at(0, 5, 0), at(5, 5, 5))).toBe(true);
    });

    it("counts the bounce off a slime pad, and either place of a moving platform", () => {
        const before = at(-2, 5, 0);
        const pad = at(0, 5, 0, { trap: "slime" });
        // Five blocks of air: out of reach for a jump, in reach for the bounce.
        expect(layout.reaches(at(0, 5, 0), at(6, 5, 0))).toBe(false);
        expect(layout.reaches(pad, at(6, 5, 0), before)).toBe(true);
        // A moving platform a block across is in reach from either place.
        expect(layout.reaches(at(0, 5, 0), at(5, 5, 6))).toBe(false);
        expect(layout.reaches(at(0, 5, 0), at(5, 5, 6, { trap: "shift" }))).toBe(true);
    });

    it("names every platform that can be reached from further back", () => {
        const start = at(-6, 0, 0, { size: 5, role: "start" });
        // Three on the level a block apart: the third is in reach of the first.
        expect(layout.skipProblems([start, at(1, 0, 2), at(3, 0, 2), at(5, 0, 2)])).toContain(
            "platform 3 can be reached from 1"
        );
        // Each a block up: the platform after next is two up, out of reach.
        expect(layout.skipProblems([start, at(1, 1, 2), at(3, 2, 2), at(5, 3, 2)])).toEqual([]);
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
            expect.arrayContaining([
                "platforms 2 and 4 touch",
                "platform 4 is in the way of jump 3"
            ])
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
