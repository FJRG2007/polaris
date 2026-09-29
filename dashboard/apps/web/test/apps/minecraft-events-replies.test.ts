/**
 * Everybody's answer to one read, as real servers write it: run together with
 * nothing between (vanilla, Fabric, Paper), one per line (NeoForge), with a
 * team's prefix and suffix around the name, with a Bedrock player's `.`, and cut
 * at RCON's 4096 characters.
 */

import { describe, expect, it } from "vitest";
import * as levels from "@polaris-app/game-servers/src/lib/minecraft/player-events";
import * as replies from "@polaris-app/game-servers/src/lib/minecraft/events/replies";
import * as commands from "@polaris-app/game-servers/src/lib/minecraft/events/commands";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";

const read = (output: string, roster: string[] | null = null) =>
    replies.canonicalReplies(output, roster);

describe("an answer run together", () => {
    it("splits positions, which close themselves", () => {
        // Vanilla 1.21.4, as the e2e harness recorded it.
        const said =
            "Alba has the following entity data: [1.5d, 64.0d, -2.25d]Bruno has the following entity data: [3.0d, 70.0d, 4.0d]";
        const out = read(said);
        expect(out.needsRoster).toBe(false);
        expect(commands.readWhere(out.text).map((one) => one.name)).toEqual(["Alba", "Bruno"]);
    });

    it("asks for the names online where a number meets the next name", () => {
        const said =
            "Alba has the following entity data: 0Bruno has the following entity data: 0";
        expect(read(said).needsRoster).toBe(true);
        expect([...arena.readGamemodes(read(said, ["Alba", "Bruno"]).text)]).toEqual([
            ["Alba", "survival"],
            ["Bruno", "survival"]
        ]);
    });

    it("reads a name that starts with a digit as that name, not as part of the number", () => {
        const said =
            "Ana has the following entity data: 002Fast has the following entity data: 2";
        // Read as it came, the 0 and the 2 run together and 02Fast is "Fast".
        expect([...arena.readGamemodes(said)].map(([name]) => name)).not.toContain("02Fast");
        const modes = arena.readGamemodes(read(said, ["Ana", "02Fast", "Fast"]).text);
        expect([...modes]).toEqual([
            ["Ana", "survival"],
            ["02Fast", "adventure"]
        ]);
    });

    it("reads homes glued the same way", () => {
        const x = read("Ana has the following entity data: -120Bo has the following entity data: 7", [
            "Ana",
            "Bo"
        ]).text;
        const z = read("Ana has the following entity data: 5Bo has the following entity data: -9", [
            "Ana",
            "Bo"
        ]).text;
        expect(commands.readHomes(x, z, "")).toEqual([
            { x: -120, z: 5 },
            { x: 7, z: -9 }
        ]);
    });

    it("reads Paper 1.21.4's answers as it gave them", () => {
        const roster = replies.rosterNames(
            "There are 3 of a max of 10 players online: PapB (5ddc5577-f4d7-340d-b4b5-ea79c06190f4), PapA (abdf418d-ca22-32dd-8732-0514a1fbc14d), PapC (fe14ef64-7ff4-3895-ac8b-112767542523)"
        );
        const modes =
            "PapB has the following entity data: 0PapA has the following entity data: 0PapC has the following entity data: 0";
        expect([...arena.readGamemodes(read(modes, roster).text).keys()]).toEqual([
            "PapB",
            "PapA",
            "PapC"
        ]);
        const where =
            "PapB has the following entity data: [66.36869252625067d, 100.0d, 3.3044707011748953d]PapA has the following entity data: [62.7d, 95.0d, 1.654048529252645d]PapC has the following entity data: [67.5d, 100.0d, -0.3722538577023003d]";
        expect(commands.readWhere(read(where).text)).toEqual([
            { name: "PapB", x: 66.36869252625067, y: 100, z: 3.3044707011748953 },
            { name: "PapA", x: 62.7, y: 95, z: 1.654048529252645 },
            { name: "PapC", x: 67.5, y: 100, z: -0.3722538577023003 }
        ]);
    });

    it("takes NeoForge's answer a line each as it is", () => {
        const said =
            "Ana has the following entity data: 0\nBen has the following entity data: 1\n";
        const out = read(said);
        expect(out.needsRoster).toBe(false);
        expect([...arena.readGamemodes(out.text)]).toEqual([
            ["Ana", "survival"],
            ["Ben", "creative"]
        ]);
    });
});

describe("the side panel's levels", () => {
    it("are read per player out of an answer run together", () => {
        const said =
            "Ada has the following entity data: 30Grace has the following entity data: 712Monkeys has the following entity data: 4";
        // As it came: one line, the levels against the next names.
        expect(levels.readLevels(said).length).toBeLessThan(3);
        const out = read(said, ["Ada", "Grace", "12Monkeys"]);
        expect(levels.readLevels(out.text)).toEqual([
            { name: "Ada", level: 30 },
            { name: "Grace", level: 7 },
            { name: "12Monkeys", level: 4 }
        ]);
    });
});

describe("a name with a team's prefix and suffix", () => {
    it("is the player's own name, from the names online", () => {
        const said =
            "[VIP] Ana [AFK] has the following entity data: [1.0d, 64.0d, 1.0d]VIPBen has the following entity data: [2.0d, 64.0d, 2.0d]";
        expect(read(said).needsRoster).toBe(true);
        expect(commands.readWhere(read(said, ["Ana", "Ben"]).text).map((one) => one.name)).toEqual(
            ["Ana", "Ben"]
        );
    });

    it("is read out of a score too, which shows it from 1.20.3", () => {
        const said = "[VIP] Ana has 12 [Luna de sangre]Ben [AFK] has 3 [Luna de sangre]";
        const scores = commands.readScores(read(said, ["Ana", "Ben"]).text);
        expect([...scores]).toEqual([
            ["Ana", 12],
            ["Ben", 3]
        ]);
    });
});

describe("a Bedrock player through Floodgate", () => {
    it("is `.Name`, never the Java player called `Name`", () => {
        const said =
            ".Bob has the following entity data: [1.0d, 64.0d, 1.0d]Bob has the following entity data: [9.0d, 64.0d, 9.0d]";
        const where = commands.readWhere(read(said).text);
        expect(where.map((one) => [one.name, one.x])).toEqual([
            [".Bob", 1],
            ["Bob", 9]
        ]);
        expect(commands.readScores(".Bob has 4 [Rush]")).toEqual(new Map([[".Bob", 4]]));
    });
});

describe("the names online", () => {
    it("come plain out of `list uuids`", () => {
        // Paper 1.21.4, as it answered.
        expect(
            replies.rosterNames(
                "There are 3 of a max of 10 players online: PapB (5ddc5577-f4d7-340d-b4b5-ea79c06190f4), .Bed (fe14ef64-7ff4-3895-ac8b-112767542523), PapA (abdf418d-ca22-32dd-8732-0514a1fbc14d)"
            )
        ).toEqual(["PapB", ".Bed", "PapA"]);
        expect(replies.rosterNames("There are 0 of a max of 10 players online: ")).toEqual([]);
    });
});

describe("an answer too long for one packet", () => {
    it("is known by its length, or by the console tool giving up on it", () => {
        expect(replies.cutShort("x".repeat(4096))).toBe(true);
        expect(replies.cutShort("Failed to read command: rcon: response too long")).toBe(true);
        expect(replies.cutShort("Ana has 1 [pe_score]")).toBe(false);
    });

    it("is asked again twenty at a time, in the same place, by pe_ tags only", () => {
        const pages = replies.pagedRead(
            "execute in minecraft:overworld as @a[distance=0..] run data get entity @s Pos"
        )!;
        expect(pages.tagPage).toBe(
            "execute in minecraft:overworld as @a[distance=0..,tag=!pe_seen,limit=20] run tag @s add pe_page"
        );
        expect(pages.readPage).toBe(
            "execute in minecraft:overworld as @a[distance=0..,tag=pe_page] run data get entity @s Pos"
        );
        expect(replies.pagedRead("execute as @a run scoreboard players get @s pe_score")!.readPage).toBe(
            "execute as @a[tag=pe_page] run scoreboard players get @s pe_score"
        );
        for (const line of [...pages.start, ...pages.next, ...pages.end])
            expect(line).toMatch(/^tag @a(\[tag=pe_page\])? (add|remove) pe_(seen|page)$/);
    });

    it("is only ever a read of every player", () => {
        expect(replies.isPlayerRead(commands.WHERE)).toBe(true);
        expect(replies.isPlayerRead(commands.READ_SCORES)).toBe(true);
        expect(replies.isPlayerRead(commands.IN_OVERWORLD)).toBe(true);
        expect(replies.isPlayerRead("minecraft:execute as @a run minecraft:data get entity @s Pos")).toBe(
            true
        );
        expect(replies.isPlayerRead(commands.READ_MARK)).toBe(false);
        expect(replies.isPlayerRead(commands.BOSS_WHERE)).toBe(false);
    });
});
