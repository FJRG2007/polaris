/**
 * Hot potato's platform and rounds, pure: what it is built of, the gallery
 * nobody climbs out of, the holder drawn from the run's id, the hit read off
 * the game's counts, the order players went out in, and what players read.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as messages from "@polaris-app/game-servers/src/lib/minecraft/events/messages";
import * as potato from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hot-potato";
import * as said from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/hot-potato-messages";
import {
    COMMAND_BYTES_MAX,
    commandBytes
} from "@polaris-app/game-servers/src/lib/minecraft/command-size";

const within = (
    outer: arena.Spot | { x: number; y: number; z: number },
    box: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
) =>
    outer.x >= box.x1 &&
    outer.x <= box.x2 &&
    outer.y >= box.y1 &&
    outer.y <= box.y2 &&
    outer.z >= box.z1 &&
    outer.z <= box.z2;

describe("hot potato's platform", () => {
    for (const players of [2, 6, 7, 12]) {
        const box = potato.platformBox({ x: 100, z: -40 }, 100, players);
        const fills = potato.platformFills(box);
        const floor = potato.floorOf(box);
        const gallery = potato.galleryOf(box);

        it(`for ${players}: is built only into air inside its box, a stripe of floor last as the proof`, () => {
            for (const one of fills) {
                expect(arena.fillKeep(one.box, one.block)).toMatch(/ keep$/);
                expect(within({ x: one.box.x1, y: one.box.y1, z: one.box.z1 }, box)).toBe(true);
                expect(within({ x: one.box.x2, y: one.box.y2, z: one.box.z2 }, box)).toBe(true);
                expect(potato.PLATFORM_BLOCKS).toContain(one.block);
            }
            expect(fills.at(-1)).toMatchObject({
                block: "minecraft:orange_terracotta",
                box: { x1: floor.x1, z1: floor.z1, y1: floor.y1 }
            });
            expect(floor.x2 - floor.x1 + 1).toBe(players <= 6 ? 11 : 13);
            expect(potato.reachOf(players) * 2).toBeGreaterThanOrEqual(box.z2 - box.z1);
        });

        it(`for ${players}: starts everybody on the floor round its middle, and seats who is out in the gallery`, () => {
            for (let index = 0; index < players; index += 1) {
                const spot = potato.startSpot(box, index, players);
                expect(potato.onPlatform(box, spot)).toBe(true);
                expect(spot.y).toBe(floor.y1 + 1);
                const seat = potato.gallerySpot(box, index);
                expect(within(seat, { ...gallery, y1: gallery.y1 + 1, y2: gallery.y1 + 1 })).toBe(
                    true
                );
                expect(potato.onPlatform(box, seat)).toBe(false);
            }
        });

        it(`for ${players}: walls the platform three high, and roofs the gallery a step up behind glass`, () => {
            const glass = fills.filter((one) => one.block === "minecraft:glass");
            // The wall between the two, from the floor three up.
            expect(glass).toContainEqual({
                box: {
                    x1: box.x1,
                    y1: floor.y1 + 1,
                    z1: floor.z1 - 1,
                    x2: box.x2,
                    y2: floor.y1 + 3,
                    z2: floor.z1 - 1
                },
                block: "minecraft:glass"
            });
            expect(gallery.y1).toBe(floor.y1 + 1);
            expect(fills).toContainEqual({
                box: {
                    x1: box.x1,
                    y1: box.y2,
                    z1: box.z1,
                    x2: box.x2,
                    y2: box.y2,
                    z2: floor.z1 - 1
                },
                block: "minecraft:barrier"
            });
            // Two blocks of room in the gallery, under its roof.
            expect(box.y2 - (gallery.y1 + 1)).toBe(2);
        });
    }
});

describe("hot potato's rounds", () => {
    const names = ["Ana", "Ben", "Cy", "Dee"];

    it("draws the holder from the run's id and the round, among who is left, whatever their order", () => {
        const first = potato.holderFor("run-1", 1, names);
        expect(names).toContain(first);
        expect(potato.holderFor("run-1", 1, [...names].reverse())).toBe(first);
        expect(potato.holderFor("run-1", 2, ["Ben", "Cy"])).toMatch(/^(Ben|Cy)$/);
        expect(potato.holderFor("run-1", 1, [])).toBeNull();
        const drawn = new Set(
            Array.from({ length: 50 }, (_, run) => potato.holderFor(`run-${run}`, 1, names))
        );
        expect(drawn.size).toBe(4);
    });

    it("hands it to the nearest of those hurt", () => {
        expect(
            potato.hitBy({ x: 0, z: 0 }, [
                { name: "Ben", x: 3, z: 0 },
                { name: "Cy", x: 1, z: 1 }
            ])
        ).toBe("Cy");
        expect(potato.hitBy({ x: 0, z: 0 }, [])).toBeNull();
    });

    it("cannot be passed straight back", () => {
        const state = potato.stateSchema.parse({ holder: "Ana", passedAt: 10_000 });
        expect(potato.canPass(state, 10_000 + potato.PASS_COOLDOWN_MS - 1)).toBe(false);
        expect(potato.canPass(state, 10_000 + potato.PASS_COOLDOWN_MS)).toBe(true);
        expect(potato.canPass({ ...state, holder: null }, 99_999)).toBe(false);
    });

    it("ranks by the order players went out, the one left above all, the same moment the same", () => {
        const state = potato.stateSchema.parse({
            out: [
                { name: "Dee", round: 1, at: 1000 },
                { name: "Cy", round: 2, at: 5000 },
                { name: "Ben", round: 2, at: 5000 }
            ]
        });
        expect(Object.fromEntries(potato.scoresOf(state, names))).toEqual({
            Ana: 4,
            Ben: 2,
            Cy: 2,
            Dee: 1
        });
        expect(Object.fromEntries(potato.scoresOf(null, ["Ana", "Ben"]))).toEqual({
            Ana: 1,
            Ben: 1
        });
        expect(potato.stateOf(null)).toBeNull();
        expect(potato.stateOf({ round: "x" })).toBeNull();
    });

    it("goes off with particles and a sound, and nothing that breaks or hurts", () => {
        const lines = potato.boomLines({ x: 1.5, y: 101, z: 2.5 });
        expect(lines.join("\n")).not.toMatch(/summon|tnt\b|fill|setblock|damage/);
        expect(lines[0]).toContain("particle minecraft:explosion_emitter");
        expect(potato.fuseLine("Ana", 9)).toBeNull();
        expect(potato.fuseLine("Ana", 3)).toContain("entity.tnt.primed");
    });

    it("leaves only the holder able to strike, everybody unhurt", () => {
        expect(potato.weakLine("Ben")).toBe("effect give Ben minecraft:weakness 3 100 true");
        expect(potato.holderLines("Ana")).toContain("effect clear Ana minecraft:weakness");
        expect(potato.unhurtLines("Ana")).toContain(
            "effect give Ana minecraft:resistance 3 3 true"
        );
        expect(potato.setupLines()).toContain(
            "scoreboard objectives add pe_hpt minecraft.custom:minecraft.damage_taken"
        );
    });
});

describe("what hot potato says", () => {
    const LONG = "Maximilian_1234";
    for (const language of ["en", "es"] as const) {
        it(`fits one command in ${language}`, () => {
            const lines = [
                said.roundLine(99, LONG, language),
                said.passed(LONG, LONG, language),
                said.exploded(LONG, 11, language),
                said.leftGame(LONG, language),
                said.winner(LONG, language),
                said.holdingBar(40, language),
                said.awayBar(LONG, 40, language),
                said.galleryBar(language),
                said.bar(99, LONG, 40, language)
            ].map((line) => commands.say(messages.tag(language) + line));
            for (const line of lines)
                expect(commandBytes(line)).toBeLessThanOrEqual(COMMAND_BYTES_MAX);
            expect(said.goTitle(language)).not.toBe(said.goTitle(language === "en" ? "es" : "en"));
        });
    }
});
