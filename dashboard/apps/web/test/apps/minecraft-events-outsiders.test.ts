/**
 * Players not in an event cannot change it from the tick: near its space they
 * are held in adventure mode, inside it they are set down beside it, and their
 * own game mode is given back once they are further off, at the end, or when
 * they are next seen - never to an entrant, never twice.
 */

import { describe, expect, it } from "vitest";
import {
    runSchema,
    withOwedLines,
    OWED_LINES_MAX
} from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as stage from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/stage";
import * as outsiders from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/outsiders";

const notes = { held: "held", movedOut: "out" };
const volume = { x1: 100, y1: 150, z1: 100, x2: 119, y2: 169, z2: 119 };

describe("the space an event guards", () => {
    it("is an arena's box, or a stage's proved volume, or what the stage built", () => {
        const flipped = { x1: 119, y1: 169, z1: 119, x2: 100, y2: 150, z2: 100 };
        expect(outsiders.guardedVolume(flipped, null)).toEqual(volume);
        expect(outsiders.guardedVolume(null, { proved: volume, boxes: [], built: false })).toEqual(
            volume
        );
        const boxes = [
            { x1: 100, y1: 150, z1: 100, x2: 110, y2: 150, z2: 110, block: stage.ARENA_BLOCKS[0] },
            { x1: 105, y1: 155, z1: 105, x2: 119, y2: 160, z2: 112, block: stage.ARENA_BLOCKS[0] }
        ];
        expect(outsiders.guardedVolume(null, { proved: null, boxes, built: true })).toEqual({
            x1: 100,
            y1: 150,
            z1: 100,
            x2: 119,
            // The stage's own headroom over what it built (`stage.boundsOf`).
            y2: 163,
            z2: 112
        });
        expect(outsiders.guardedVolume(null, { proved: null, boxes, built: false })).toBeNull();
        expect(outsiders.guardedVolume(null, null)).toBeNull();
    });

    it("reads everybody within the margin who carries no event tag and is not a spectator", () => {
        const m = outsiders.MARGIN + outsiders.LET_GO;
        expect(outsiders.nearRead(volume)).toBe(
            `execute in minecraft:overworld as @a[x=${100 - m},y=${150 - m},z=${100 - m},dx=${19 + 2 * m},dy=${19 + 2 * m},dz=${19 + 2 * m},tag=!pe_arena,tag=!pe_in,gamemode=!spectator] run data get entity @s Pos`
        );
    });

    it("counts a body touching the volume as in it, and one a step past its edge as out", () => {
        expect(outsiders.bodyIn(volume, { x: 110.5, y: 155, z: 110.5 })).toBe(true);
        expect(outsiders.bodyIn(volume, { x: 120.2, y: 155, z: 110.5 })).toBe(true);
        expect(outsiders.bodyIn(volume, { x: 120.31, y: 155, z: 110.5 })).toBe(false);
        expect(outsiders.bodyIn(volume, { x: 110.5, y: 170, z: 110.5 })).toBe(false);
        expect(outsiders.bodyIn(volume, { x: 110.5, y: 148.3, z: 110.5 })).toBe(true);
    });
});

describe("somebody not in the event, near it", () => {
    const near = [
        { name: "Mallory", x: 95.5, y: 160, z: 110.5 },
        { name: "Ana", x: 96.5, y: 160, z: 110.5 }
    ];

    it("leaves out whoever takes part, by name, and reads only those not held yet", () => {
        const out = outsiders.outsidersOf(near, new Set(["ana"]));
        expect(out.map((one) => one.name)).toEqual(["Mallory"]);
        expect(outsiders.toRead(out, [])).toEqual(["Mallory"]);
        expect(
            outsiders.toRead(out, [{ name: "Mallory", mode: "survival", holding: true }])
        ).toEqual([]);
        expect(outsiders.outsidersOf([{ name: "bad name;", x: 0, y: 0, z: 0 }], new Set())).toEqual(
            []
        );
    });

    it("is held in adventure mode from the mode read, and that mode written down", () => {
        const out = outsiders.outsidersOf(near, new Set(["ana"]));
        const result = outsiders.step({
            volume,
            outsiders: out,
            modes: new Map([["Mallory", "creative"]]),
            held: [],
            notes
        });
        expect(result.changed).toBe(true);
        expect(result.held).toEqual([{ name: "Mallory", mode: "creative", holding: true }]);
        expect(result.lines).toContain("tag @a[name=Mallory,gamemode=creative] add pe_held");
        expect(result.lines).toContain(
            "gamemode adventure @a[name=Mallory,tag=pe_held,gamemode=creative]"
        );
        // Creative flight goes with it: they float down.
        expect(result.lines).toContain("effect give Mallory minecraft:slow_falling 10 0 true");
        // Outside the space itself: not moved.
        expect(result.lines.some((line) => line.includes("spreadplayers"))).toBe(false);
        expect(result.lines.some((line) => line.includes("Ana"))).toBe(false);
    });

    it("is not held again while held, and nothing is sent for them", () => {
        const result = outsiders.step({
            volume,
            outsiders: [near[0]!],
            modes: new Map(),
            held: [{ name: "Mallory", mode: "survival", holding: true }],
            notes
        });
        expect(result.changed).toBe(false);
        expect(result.lines).toEqual([]);
    });

    it("is held only within the margin, and let go only past it by `LET_GO`", () => {
        const edge = { name: "Mallory", x: 100 - outsiders.MARGIN - 1.5, y: 160, z: 110.5 };
        const fresh = outsiders.step({
            volume,
            outsiders: [edge],
            modes: new Map([["Mallory", "survival"]]),
            held: [],
            notes
        });
        expect(fresh.held).toEqual([]);
        expect(fresh.lines).toEqual([]);
        const kept = outsiders.step({
            volume,
            outsiders: [edge],
            modes: new Map(),
            held: [{ name: "Mallory", mode: "survival", holding: true }],
            notes
        });
        expect(kept.changed).toBe(false);
        expect(kept.lines).toEqual([]);
    });

    it("out of creative is kept floating for as long as they are held", () => {
        const result = outsiders.step({
            volume,
            outsiders: [near[0]!],
            modes: new Map(),
            held: [{ name: "Mallory", mode: "creative", holding: true }],
            notes
        });
        expect(result.changed).toBe(false);
        expect(result.lines).toEqual(["effect give Mallory minecraft:slow_falling 10 0 true"]);
    });

    it("is let go of when the space is gone", () => {
        const result = outsiders.step({
            volume: null,
            outsiders: [],
            modes: new Map(),
            held: [{ name: "Mallory", mode: "survival", holding: true }],
            notes
        });
        expect(result.held).toEqual([{ name: "Mallory", mode: "survival", holding: false }]);
        expect(result.lines).toEqual(outsiders.releaseLines(result.held[0]!));
    });

    it("whose mode could not be read is not held", () => {
        const result = outsiders.step({
            volume,
            outsiders: [near[0]!],
            modes: new Map(),
            held: [],
            notes
        });
        expect(result.held).toEqual([]);
        expect(result.lines).toEqual([]);
    });

    it("gets their own mode back once further off - only while still held, in adventure and in no event", () => {
        const result = outsiders.step({
            volume,
            outsiders: [],
            modes: new Map(),
            held: [{ name: "Mallory", mode: "survival", holding: true }],
            notes
        });
        expect(result.held).toEqual([{ name: "Mallory", mode: "survival", holding: false }]);
        expect(result.lines).toEqual([
            "gamemode survival @a[name=Mallory,tag=pe_held,tag=!pe_arena,tag=!pe_in,gamemode=adventure]",
            "tag Mallory remove pe_held"
        ]);
    });

    it("back near after being let go while off keeps the mode they had before", () => {
        const result = outsiders.step({
            volume,
            outsiders: [near[0]!],
            modes: new Map([["Mallory", "adventure"]]),
            held: [{ name: "Mallory", mode: "creative", holding: false }],
            notes
        });
        expect(result.held).toEqual([{ name: "Mallory", mode: "creative", holding: true }]);
    });
});

describe("somebody not in the event, inside its space", () => {
    it("is set down on the ground beyond the nearest side, past the margin", () => {
        const inside = { name: "Mallory", x: 101.5, y: 160, z: 112.5 };
        const result = outsiders.step({
            volume,
            outsiders: [inside],
            modes: new Map([["Mallory", "survival"]]),
            held: [],
            notes
        });
        const to = outsiders.outPoint(volume, inside);
        expect(to.x).toBeLessThan(100 - outsiders.MARGIN - 2);
        expect(to.z).toBe(112);
        expect(result.lines).toContain("effect give Mallory minecraft:slow_falling 10 0 true");
        expect(result.lines).toContain(
            `execute in minecraft:overworld run spreadplayers ${to.x + 0.5} ${to.z + 0.5} 0 2 false Mallory`
        );
    });

    it("is never set down where they would be read again, from whichever side is nearest", () => {
        const spread = 2;
        for (const at of [
            { x: 100.5, y: 160, z: 110 },
            { x: 119.5, y: 160, z: 110 },
            { x: 110, y: 160, z: 100.5 },
            { x: 110, y: 160, z: 119.5 },
            { x: 110, y: 160, z: 110 }
        ]) {
            const to = outsiders.outPoint(volume, at);
            const clearX =
                to.x - spread > 119 + outsiders.MARGIN + outsiders.LET_GO + 1 ||
                to.x + spread + 1 < 100 - outsiders.MARGIN - outsiders.LET_GO;
            const clearZ =
                to.z - spread > 119 + outsiders.MARGIN + outsiders.LET_GO + 1 ||
                to.z + spread + 1 < 100 - outsiders.MARGIN - outsiders.LET_GO;
            expect(clearX || clearZ).toBe(true);
        }
    });
});

describe("the end of the event", () => {
    const held = [
        { name: "Mallory", mode: "survival" as const, holding: true },
        { name: "Bob", mode: "creative" as const, holding: false }
    ];

    it("lets everybody it held go, and owes the same to whoever was not on", () => {
        expect(outsiders.releaseAll(held)).toEqual([
            ...outsiders.releaseLines(held[0]!),
            ...outsiders.releaseLines(held[1]!)
        ]);
        const owed = outsiders.owedRelease(held, 5);
        expect(owed.map((one) => [one.player, one.reason, one.until])).toEqual([
            ["Mallory", "held-out", 5],
            ["Bob", "held-out", 5]
        ]);
        // Harmless to whoever is already let go: every line needs the tag.
        for (const one of owed)
            expect(one.lines[0]).toMatch(/^gamemode \w+ @a\[name=\w+,tag=pe_held,/);
    });

    it("writes down the mode somebody held had, for the event to take them in with", () => {
        expect(outsiders.trueMode(held, "mallory")).toBe("survival");
        expect(outsiders.trueMode(held, "Bob")).toBeUndefined();
        // A stage reads modes as numbers: the held one's own, the rest as read.
        const read = new Map([
            ["Mallory", 2],
            ["Bob", 2],
            ["Ana", 0]
        ]);
        expect(outsiders.withTrueModes(read, held)).toEqual(
            new Map([
                ["Mallory", 0],
                ["Bob", 2],
                ["Ana", 0]
            ])
        );
    });
});

describe("a busy server", () => {
    it("keeps everybody still held once the list is full, dropping those let go first", () => {
        const letGo = Array.from({ length: outsiders.HELD_MAX }, (_, at) => ({
            name: `Gone${at}`,
            mode: "survival" as const,
            holding: false
        }));
        const held = [{ name: "Mallory", mode: "creative" as const, holding: true }, ...letGo];
        const result = outsiders.step({
            volume,
            outsiders: [
                { name: "Mallory", x: 95.5, y: 160, z: 110.5 },
                { name: "Newcomer", x: 96.5, y: 160, z: 110.5 }
            ],
            modes: new Map([["Newcomer", "survival"]]),
            held,
            notes
        });
        expect(result.held).toHaveLength(outsiders.HELD_MAX);
        expect(result.held[0]).toEqual({ name: "Mallory", mode: "creative", holding: true });
        expect(result.held.at(-1)).toEqual({ name: "Newcomer", mode: "survival", holding: true });
        expect(result.held.some((one) => one.name === "Gone0")).toBe(false);
    });

    it("never lets a held outsider's release push out what another event owes", () => {
        const owed = [
            { player: "Ana", reason: "things", lines: ["give Ana minecraft:stone"], until: 10 }
        ];
        const held = Array.from({ length: OWED_LINES_MAX }, (_, at) => ({
            name: `Passer${at}`,
            mode: "survival" as const,
            holding: false
        }));
        const kept = withOwedLines(owed, outsiders.owedRelease(held, 10), 0);
        expect(kept).toHaveLength(OWED_LINES_MAX);
        expect(kept[0]).toEqual(owed[0]);
        expect(kept.at(-1)?.player).toBe(`Passer${OWED_LINES_MAX - 1}`);
    });
});

describe("a run saved before outsiders were held", () => {
    it("still reads, holding nobody", () => {
        const parsed = runSchema.shape.heldOut.parse(undefined);
        expect(parsed).toEqual([]);
    });
});
