/**
 * Hide and seek's hall and rules, pure: the hall drawn from the run's id and
 * checked against its rules over thousands of seeds, what it is built of, the
 * cage, the seekers drawn, a find, the scores and what players read.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as hs from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hide-and-seek-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SEEDS = 3000;
const box = hs.hallBox({ x: 100, z: -40 }, 100);

describe("hide and seek's hall", () => {
    it("keeps every rule over thousands of seeds, never falling back to a bare hall", () => {
        let bare = 0;
        const counts = { wall: 0, hedge: 0, crate: 0, stack: 0 };
        const corners = new Set<string>();
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const layout = hs.layoutFor(`run-${seed}`);
            expect(hs.layoutProblems(layout)).toEqual([]);
            if (layout.bare) bare += 1;
            for (const [kind, count] of Object.entries(hs.hidingPlaces(layout)))
                counts[kind as hs.PieceKind] += count;
            corners.add(`${layout.flipX},${layout.flipZ}`);
            expect(layout.pieces.length).toBe(20);
        }
        expect(bare).toBe(0);
        // Every kind of hiding place, plenty of each, the gallery in every corner.
        for (const count of Object.values(counts)) expect(count / SEEDS).toBeGreaterThan(2);
        expect(corners.size).toBe(4);
    });

    it("is the same hall for the same run, and another for another", () => {
        expect(hs.layoutFor("abc")).toEqual(hs.layoutFor("abc"));
        expect(hs.layoutFor("abc")).not.toEqual(hs.layoutFor("abd"));
    });

    it("finds a corner sealed off, pieces touching, the stairs blocked and a piece through the gallery", () => {
        const layout = hs.layoutFor("run-1");
        const piece = (over: Partial<hs.Piece>): hs.Piece => ({
            kind: "wall",
            x: 22,
            z: 22,
            level: 1,
            w: 1,
            d: 1,
            h: 3,
            ...over
        });
        const bare = { ...layout, pieces: [] };
        expect(hs.layoutProblems(bare)).toEqual([]);
        // Two walls closing the corner of the hall off from the rest.
        const sealed = [piece({ x: 23, z: 22, w: 3 }), piece({ x: 22, z: 23, d: 3 })];
        expect(hs.layoutProblems({ ...bare, pieces: sealed }).join(" ")).toMatch(
            /cannot be reached/
        );
        expect(hs.layoutProblems({ ...bare, pieces: sealed })).toContain("pieces 0 and 1 touch");
        expect(
            hs.layoutProblems({ ...bare, pieces: [piece({ x: 7, z: layout.stairsZ })] })
        ).toContain("piece 0 is in the way of the stairs, the ladder or the cage");
        expect(hs.layoutProblems({ ...bare, pieces: [piece({ x: 2, z: 10, h: 5 })] })).toContain(
            "piece 0 has no room under the gallery"
        );
        expect(
            hs.layoutProblems({ ...bare, pieces: [piece({ x: 12, z: 12, level: 5, h: 1 })] })
        ).toContain("piece 0 is off the gallery");
    });
});

describe("hide and seek's hall in the world", () => {
    const layout = hs.layoutFor("run-1");
    const fills = hs.hallFills(box, layout);

    it("is built only into air inside its box, its floor last as the proof", () => {
        for (const one of fills) {
            expect(arena.fillKeep(one.box, one.block)).toMatch(/ keep$/);
            expect(one.box.x1).toBeGreaterThanOrEqual(box.x1);
            expect(one.box.x2).toBeLessThanOrEqual(box.x2);
            expect(one.box.y1).toBeGreaterThanOrEqual(box.y1);
            expect(one.box.y2).toBeLessThanOrEqual(box.y2);
            expect(one.box.z1).toBeGreaterThanOrEqual(box.z1);
            expect(one.box.z2).toBeLessThanOrEqual(box.z2);
            expect(hs.HALL_BLOCKS).toContain(one.block.replace(/\[.*$/, ""));
        }
        expect(fills.at(-1)).toMatchObject({
            block: "minecraft:smooth_stone",
            box: { x1: box.x1 + 1, z1: box.z1 + 1, y1: box.y1 + 1 }
        });
        // Leaves that never wither, and stairs and a ladder turned with the hall.
        expect(fills.some((one) => one.block === "minecraft:oak_leaves[persistent=true]")).toBe(
            true
        );
        const flipped = hs.hallFills(box, { ...layout, flipX: true, flipZ: true });
        expect(flipped.some((one) => one.block === "minecraft:spruce_stairs[facing=east]")).toBe(
            true
        );
        expect(flipped.some((one) => one.block === "minecraft:ladder[facing=north]")).toBe(true);
    });

    it("takes the cage down by its barrier alone, inside its own box", () => {
        const cage = hs.cageBox(box, layout);
        expect(cage.x2 - cage.x1).toBe(4);
        expect(cage.y1).toBe(box.y1 + 2);
        expect(hs.cageDown(box, layout)).toBe(
            `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace minecraft:barrier`
        );
        // The seekers wait inside it, the hiders round it.
        for (let index = 0; index < 3; index += 1) {
            const spot = hs.seekerSpot(box, layout, index);
            expect(spot.x).toBeGreaterThan(cage.x1);
            expect(spot.x).toBeLessThan(cage.x2);
            expect(spot.z).toBeGreaterThan(cage.z1);
            expect(spot.z).toBeLessThan(cage.z2);
        }
        const starts = new Set<string>();
        for (let index = 0; index < hs.MOST; index += 1) {
            const spot = hs.hiderSpot(box, layout, index);
            expect(
                spot.x < cage.x1 || spot.x > cage.x2 || spot.z < cage.z1 || spot.z > cage.z2
            ).toBe(true);
            expect(spot.y).toBe(box.y1 + 2);
            starts.add(`${spot.x},${spot.z}`);
        }
        expect(starts.size).toBe(hs.MOST);
    });
});

describe("hide and seek's rules", () => {
    const names = ["Ana", "Ben", "Cy", "Dee"];

    it("draws the seekers from the run's id, never everybody", () => {
        const two = hs.seekersFor("run-1", names, 2);
        expect(two).toHaveLength(2);
        expect(hs.seekersFor("run-1", [...names].reverse(), 2)).toEqual(two);
        expect(hs.seekersFor("run-1", ["Ana", "Ben"], 3)).toHaveLength(1);
    });

    it("finds a hider only beside a seeker who struck", () => {
        const at = { x: 0, y: 100, z: 0 };
        expect(hs.foundBy(at, [{ name: "Ben", x: 2, y: 100, z: 0 }])).toBe("Ben");
        expect(hs.foundBy(at, [{ name: "Ben", x: 9, y: 100, z: 0 }])).toBeNull();
        expect(
            hs.foundBy(at, [
                { name: "Ben", x: 3, y: 100, z: 0 },
                { name: "Cy", x: 1, y: 100, z: 1 }
            ])
        ).toBe("Cy");
    });

    it("scores a point a second hidden and a fixed number a find", () => {
        const state = hs.stateSchema.parse({
            seekers: ["Ben"],
            finds: [
                { hider: "Ana", by: "Ben", at: 1 },
                { hider: "Cy", by: "Ana", at: 2 }
            ],
            hidden: { Ana: 61_500, Cy: 120_000, Dee: 300_000 }
        });
        expect(Object.fromEntries(hs.scoresOf(state, names))).toEqual({
            Ana: 61 + hs.FIND_POINTS,
            Ben: hs.FIND_POINTS,
            Cy: 120,
            Dee: 300
        });
        expect(hs.seeks(state, "cy")).toBe(true);
        expect(hs.seeks(state, "Dee")).toBe(false);
        expect(hs.stateOf({ design: 1 })).toBeNull();
    });

    it("hides each side's names from the other, and keeps the seekers blind and still while they wait", () => {
        const lines = hs.setupLines(["Seekers", "Hiders"]);
        expect(lines).toContain("team modify pe_hs_seek nametagVisibility hideForOtherTeams");
        expect(lines).toContain("team modify pe_hs_hide friendlyFire false");
        expect(hs.waitingLines("Ben")).toContain("effect give Ben minecraft:blindness 3 0 true");
        expect(hs.hiderLine("Ana")).toBe("effect give Ana minecraft:weakness 3 100 true");
        expect(hs.joinSide("Ana", true)).toContain(
            "execute if entity @a[name=Ana,team=pe_hs_hide] run team join pe_hs_seek Ana"
        );
    });
});

describe("what hide and seek says", () => {
    const LONG = "Maximilian_1234";
    for (const language of ["en", "es"] as const) {
        it(`fits one command in ${language}`, () => {
            const lines = [
                said.found(LONG, LONG, 11, language),
                said.hiddenBar(3599, 11, language),
                said.seekBar(11, language),
                said.waitBar(60, language),
                said.bar(11, "59:59", language),
                said.summary(11, 11, language),
                said.hideSubtitle(60, language),
                said.seekSubtitle(60, language)
            ].map((line) => commands.say(messages.tag(language) + line));
            for (const line of lines)
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            expect(said.hideTitle(language)).not.toBe(
                said.hideTitle(language === "en" ? "es" : "en")
            );
        });
    }
});
