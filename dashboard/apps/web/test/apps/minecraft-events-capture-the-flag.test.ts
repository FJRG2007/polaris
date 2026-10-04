/**
 * Capture the flag's map and commands, pure: the cover drawn from the run's id
 * and checked against its rules over thousands of seeds, the arena it is built
 * into, the stands and the marks the quick look leaves, and what players read.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as ctf from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/capture-the-flag";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/capture-the-flag-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const SEEDS = 3000;
const box = ctf.arenaBox({ x: 100, z: -40 }, 100);

describe("capture the flag's field", () => {
    it("keeps every rule over thousands of seeds, with cover on every one", () => {
        const counts: number[] = [];
        for (let seed = 0; seed < SEEDS; seed += 1) {
            const cover = ctf.coverFor(`run-${seed}`);
            expect(ctf.layoutProblems(cover)).toEqual([]);
            counts.push(cover.length);
        }
        // Five to eight pieces a half, never a bare field.
        expect(Math.min(...counts)).toBeGreaterThanOrEqual(10);
        expect(Math.max(...counts)).toBeLessThanOrEqual(16);
        const mean = counts.reduce((sum, one) => sum + one, 0) / counts.length;
        expect(mean).toBeGreaterThan(12);
    });

    it("is the same field for the same run, and another for another", () => {
        expect(ctf.coverFor("abc")).toEqual(ctf.coverFor("abc"));
        expect(ctf.coverFor("abc")).not.toEqual(ctf.coverFor("abd"));
    });

    it("is the same seen from either base: every piece has its twin turned half a circle", () => {
        const cover = ctf.coverFor("run-7");
        const keys = new Set(cover.map((one) => JSON.stringify(one)));
        for (const piece of cover) expect(keys.has(JSON.stringify(ctf.mirrored(piece)))).toBe(true);
    });

    it("finds what breaks the rules: a sealed corner, touching pieces, a piece on a base", () => {
        const wall = (x: number, z: number, w: number, d: number): ctf.Piece => ({
            kind: "wall",
            x,
            z,
            w,
            d,
            h: 2
        });
        const pair = (piece: ctf.Piece) => [piece, ctf.mirrored(piece)];
        expect(
            ctf.layoutProblems([...pair(wall(-3, -10, 1, 1)), ...pair(wall(-2, -10, 1, 1))])
        ).toContain("pieces 0 and 2 touch");
        expect(ctf.layoutProblems(pair(wall(0, -ctf.HALF_Z + 1, 1, 1)))).toContain(
            "piece 0 is on or next to a base"
        );
        expect(ctf.layoutProblems([wall(-3, -10, 1, 1)])).toContain(
            "a piece at -3,-10 has no twin on the other half"
        );
        // A ring of wall round one block: that block cannot be walked to.
        const ring = [
            wall(-5, -12, 3, 1),
            wall(-5, -10, 3, 1),
            wall(-5, -11, 1, 1),
            wall(-3, -11, 1, 1)
        ];
        expect(ctf.layoutProblems(ring.flatMap(pair)).join(" ")).toContain("cannot be walked to");
    });
});

describe("capture the flag's arena", () => {
    const fills = ctf.arenaFills(box, ctf.coverFor("run-1"));

    it("is built only into air, its blue flag last as the proof it stayed", () => {
        for (const one of fills) {
            expect(arena.fillKeep(one.box, one.block)).toMatch(/ keep$/);
            expect(one.box.x1).toBeGreaterThanOrEqual(box.x1);
            expect(one.box.x2).toBeLessThanOrEqual(box.x2);
            expect(one.box.y1).toBeGreaterThanOrEqual(box.y1);
            expect(one.box.y2).toBeLessThanOrEqual(box.y2);
            expect(one.box.z1).toBeGreaterThanOrEqual(box.z1);
            expect(one.box.z2).toBeLessThanOrEqual(box.z2);
        }
        expect(fills.at(-1)?.block).toBe("minecraft:blue_banner[rotation=8]");
        const stand = ctf.standAt(box, 1);
        expect(fills.at(-1)?.box).toEqual({
            x1: stand.x,
            y1: stand.y,
            z1: stand.z,
            x2: stand.x,
            y2: stand.y,
            z2: stand.z
        });
    });

    it("comes down whole: every block it is built of is in its list, the banners before their floor", () => {
        for (const one of fills) expect(ctf.ARENA_BLOCKS).toContain(one.block.replace(/\[.*$/, ""));
        const lines = arena.teardown({ box, blocks: [...ctf.ARENA_BLOCKS] });
        const banner = lines.findIndex((line) => line.endsWith("replace minecraft:blue_banner"));
        const floor = lines.findIndex((line) => line.endsWith("replace minecraft:blue_concrete"));
        expect(banner).toBeLessThan(floor);
    });

    it("stands each flag on a light at its own end, the teams starting in front of their own", () => {
        const red = ctf.standAt(box, 0);
        const blue = ctf.standAt(box, 1);
        expect(red.z).toBeLessThan(-40);
        expect(blue.z).toBeGreaterThan(-40);
        expect(fills).toContainEqual({
            box: { x1: red.x, y1: red.y - 1, z1: red.z, x2: red.x, y2: red.y - 1, z2: red.z },
            block: "minecraft:sea_lantern"
        });
        for (let index = 0; index < 8; index += 1) {
            const own = ctf.startSpot(box, 0, index);
            const theirs = ctf.startSpot(box, 1, index);
            expect(own.z).toBeGreaterThan(red.z);
            expect(Math.abs(own.z - red.z)).toBeLessThan(ctf.HOME + 1);
            expect(theirs.z).toBeLessThan(blue.z);
            expect(own.yaw).toBe(0);
            expect(theirs.yaw).toBe(180);
            expect(own.x).toBeGreaterThan(box.x1);
            expect(own.x).toBeLessThan(box.x2);
        }
    });

    it("puts a flag back only into air, and takes it off only where it is ours", () => {
        const at = ctf.standAt(box, 0);
        expect(ctf.standLines(box, 0, true)).toEqual([
            `execute in minecraft:overworld run setblock ${at.x} ${at.y} ${at.z} minecraft:red_banner[rotation=0] keep`
        ]);
        expect(ctf.standLines(box, 0, false)).toEqual([
            `execute in minecraft:overworld if block ${at.x} ${at.y} ${at.z} minecraft:red_banner run setblock ${at.x} ${at.y} ${at.z} minecraft:air`
        ]);
    });

    it("marks a touch only while the flag is home, and only by the other team", () => {
        const [redTouch, redHome] = ctf.touchLines(box);
        expect(redTouch).toContain(" if block ");
        expect(redTouch).toContain(
            "minecraft:red_banner run tag @a[tag=pe_ctf_s1,distance=..1.8] add pe_ctf_t0"
        );
        expect(redHome).toContain("tag @a[tag=pe_ctf_s0,distance=..3] add pe_ctf_h0");
    });

    it("puts the flag on a head only where nothing is worn, the way each version writes it", () => {
        expect(arena.wearMarked("Ana", "minecraft:blue_banner", "components", true)).toBe(
            "execute unless data entity Ana Inventory[{Slot:103b}] run item replace entity Ana armor.head with minecraft:blue_banner[minecraft:custom_data={polaris_event:1b}] 1"
        );
        expect(arena.wearMarked("Ana", "minecraft:blue_banner", "tag", false)).toBe(
            "execute unless data entity Ana Inventory[{Slot:103b}] run replaceitem entity Ana armor.head minecraft:blue_banner{polaris_event:1b} 1"
        );
    });

    it("breaks a tie on captures by eliminations", () => {
        const state = ctf.stateOf({ kills: { Ana: 3, Ben: 1 } });
        expect(ctf.tiebreakOf(state, ["Ana", "Ben", "Cy"])).toEqual({ Ana: -3, Ben: -1, Cy: -0 });
        expect(ctf.stateOf(null).flags).toEqual([{ carrier: null }, { carrier: null }]);
        expect(ctf.stateOf({ flags: "nonsense" }).flags).toEqual([
            { carrier: null },
            { carrier: null }
        ]);
    });
});

describe("what capture the flag says", () => {
    const LONG = "Maximilian_1234";
    for (const language of ["en", "es"] as const) {
        it(`fits one command in ${language}`, () => {
            const lines = [
                said.took(LONG, 0, language),
                said.dropped(LONG, 1, language),
                said.returned(0, language),
                said.captured(LONG, 1, 10, 9, language),
                said.carryingBar(true, language),
                said.carryingBar(false, language),
                said.statusBar(1, 10, language),
                said.enterSubtitle(10, language),
                said.capturedTitle(0, language)
            ].map((line) => commands.say(messages.tag(language) + line));
            for (const line of lines)
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
        });
    }

    it("is said in both languages, differently", () => {
        expect(said.took("Ana", 0, "en")).not.toBe(said.took("Ana", 0, "es"));
        expect(said.took("Ana", 1, "en")).toContain("Blue");
        expect(said.took("Ana", 1, "es")).toContain("Azul");
    });
});
