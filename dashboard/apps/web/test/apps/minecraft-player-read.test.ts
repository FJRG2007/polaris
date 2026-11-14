/**
 * Coordinates and the rest of what the game knows about a player, as variables.
 *
 * Pinned:
 * - the game's answers are read in its own notation and rounded down to the
 *   block, negatives included, and anything else reads as nothing;
 * - a command asks once per player and field, in one batch, asks again on its
 *   own an answer that did not arrive whole, and never asks about a name the
 *   game would not take;
 * - a command writes the values in per player and takes the fallback where the
 *   game had no answer;
 * - a text draws the position from scores refreshed each time it is sent, and
 *   refuses the dimension, which a score cannot hold;
 * - the last death's place is read off that player and is nothing while they
 *   are away.
 */

import { english } from "../setup/game-english";
import { describe, expect, it, vi } from "vitest";

const read = await import("@polaris-app/game-servers/src/lib/minecraft/player-read");
const vars = await import("@polaris-app/game-servers/src/lib/minecraft/text-vars");
const consoleVars = await import("@polaris-app/game-servers/src/lib/console-vars");

const answer = (name: string, value: string) => `${name} has the following entity data: ${value}`;

/** A server that answers `data get entity` from a table, and records what it was asked. */
function server(
    table: Record<string, string>,
    options: { batch?: boolean; drop?: number[] } = {}
) {
    const asked: string[] = [];
    const reply = (argv: readonly string[]) => {
        const [, , , name, field] = argv;
        const value = table[`${name}.${field}`];
        return value === undefined ? "No entity was found" : answer(name as string, value);
    };
    const say = vi.fn(async (argv: readonly string[]) => {
        asked.push(`say ${argv.join(" ")}`);
        return reply(argv);
    });
    const sayEach =
        options.batch === false
            ? undefined
            : vi.fn(async (commands: readonly (readonly string[])[]) => {
                  asked.push(`batch ${commands.length}`);
                  return commands.map((argv, index) =>
                      options.drop?.includes(index) ? null : reply(argv)
                  );
              });
    return { server: { say, sayEach }, asked };
}

describe("reading the game's answers", () => {
    it("takes the value after the game's preamble, and nothing else", () => {
        expect(read.entityData(answer("Steve", "[1.0d, 2.0d, 3.0d]"))).toBe("[1.0d, 2.0d, 3.0d]");
        expect(read.entityData("§eSteve has the following entity data: 20.0f")).toBe("20.0f");
        expect(read.entityData("No entity was found")).toBeNull();
        expect(read.entityData(answer("Steve", ""))).toBeNull();
    });

    it("rounds a position down to the block, negatives included", () => {
        expect(read.readPosition("[12.5d, 64.0d, -30.2d]")).toEqual([12, 64, -31]);
        expect(read.readPosition("[ -0.5d , 70.99d , 0.0d ]")).toEqual([-1, 70, 0]);
        expect(read.readPosition("[1.0E7d, 2d, 3d]")).toEqual([10_000_000, 2, 3]);
        expect(read.readPosition("[1.0d, 2.0d]")).toBeNull();
        expect(read.readPosition("[a, b, c]")).toBeNull();
        expect(read.readPosition("{x: 1}")).toBeNull();
    });

    it("reads a level and a health as a whole number, as a score shows them", () => {
        expect(read.readWhole("12")).toBe(12);
        expect(read.readWhole("19.5f")).toBe(19);
        expect(read.readWhole("0.0f")).toBe(0);
        expect(read.readWhole("\"12\"")).toBeNull();
        expect(read.readWhole("12 levels")).toBeNull();
    });

    it("reads a dimension id and refuses anything that could break a command", () => {
        expect(read.readDimension('"minecraft:the_nether"')).toBe("minecraft:the_nether");
        expect(read.readDimension("'mymod:sky'")).toBe("mymod:sky");
        expect(read.readDimension('"overworld"')).toBeNull();
        expect(read.readDimension('"minecraft:x run op Eve"')).toBeNull();
        expect(read.readDimension("minecraft:overworld")).toBeNull();
    });

    it("reads where somebody last died", () => {
        expect(
            read.readDeathPlace('{dimension: "minecraft:the_end", pos: [I; 10, 64, -20]}')
        ).toEqual({ dimension: "minecraft:the_end", x: 10, y: 64, z: -20 });
        expect(read.readDeathPlace('{dimension: "minecraft:the_end"}')).toBeNull();
        expect(read.readDeathPlace("{pos: [I; 1, 2, 3]}")).toBeNull();
    });
});

describe("asking the game about players", () => {
    const table = {
        "Steve.Pos": "[12.5d, 64.0d, -30.2d]",
        "Steve.Dimension": '"minecraft:the_nether"',
        "Alex.Pos": "[-0.5d, 70.0d, 3.9d]"
    };

    it("asks each field once per player, in one batch", async () => {
        const { server: game, asked } = server(table);
        const values = await read.readPlayerValues(game, ["Steve", "Alex"], [
            "player.x",
            "player.y",
            "player.z",
            "player.dimension"
        ]);
        expect(asked).toEqual(["batch 4"]);
        expect(values.get("steve")).toEqual({
            "player.x": "12",
            "player.y": "64",
            "player.z": "-31",
            "player.dimension": "minecraft:the_nether"
        });
        expect(values.get("alex")).toMatchObject({ "player.x": "-1", "player.dimension": null });
    });

    it("asks again on its own an answer that did not arrive whole", async () => {
        const { server: game, asked } = server(table, { drop: [1] });
        const values = await read.readPlayerValues(game, ["Steve", "Alex"], ["player.x"]);
        expect(asked).toEqual(["batch 2", "say data get entity Alex Pos"]);
        expect(values.get("alex")?.["player.x"]).toBe("-1");
    });

    it("works with a server that cannot batch", async () => {
        const { server: game, asked } = server(table, { batch: false });
        const values = await read.readPlayerValues(game, ["Steve"], ["player.y"]);
        expect(asked).toEqual(["say data get entity Steve Pos"]);
        expect(values.get("steve")?.["player.y"]).toBe("64");
    });

    it("never asks about a name the game would not take, and asks nothing it does not need", async () => {
        const { server: game, asked } = server(table);
        const values = await read.readPlayerValues(game, ["bad;name", "Steve Two"], ["player.x"]);
        expect(asked).toEqual([]);
        expect(values.size).toBe(0);
        expect(await read.readPlayerValues(game, ["Steve"], ["server.name"])).toEqual(new Map());
        expect(asked).toEqual([]);
    });

    it("reads somebody who is away as nothing", async () => {
        const { server: game } = server({});
        const values = await read.readPlayerValues(game, ["Steve"], ["player.x", "player.level"]);
        expect(values.get("steve")).toEqual({ "player.x": null, "player.level": null });
    });

    it("reads where the last death was off that player, and nothing while they are away", async () => {
        const { server: game } = server({
            "Steve.LastDeathLocation": '{dimension: "minecraft:overworld", pos: [I; 131, 12, -240]}'
        });
        expect(await read.readDeathValues(game, "Steve")).toEqual({
            "death.x": "131",
            "death.y": "12",
            "death.z": "-240",
            "death.dimension": "minecraft:overworld"
        });
        const away = await read.readDeathValues(game, "Alex");
        expect(Object.values(away).every((value) => value === null)).toBe(true);
        const nobody = await read.readDeathValues(game, null);
        expect(Object.keys(nobody).sort()).toEqual([...vars.DEATH_PLACE_VARIABLES].sort());
    });
});

describe("a console command with coordinates", () => {
    const fill = {
        edition: "java" as const,
        custom: [],
        values: {},
        server: { "death.x": "131", "death.y": "12", "death.z": "-240" }
    };

    it("writes each player's own position into their line", () => {
        const lines = consoleVars.commandLines("tp {player} {player.x} {player.y} {player.z}", fill, [
            { name: "Steve", values: { "player.x": "12", "player.y": "64", "player.z": "-31" } },
            { name: "Alex", values: { "player.x": "-1", "player.y": "70", "player.z": "3" } }
        ]);
        expect(lines).toEqual(["tp Steve 12 64 -31", "tp Alex -1 70 3"]);
    });

    it("takes the fallback where the game had no answer", () => {
        const lines = consoleVars.commandLines(
            'say {player} is in {player.dimension | "somewhere"}',
            fill,
            [{ name: "Steve", values: { "player.dimension": null } }]
        );
        expect(lines).toEqual(["say Steve is in somewhere"]);
    });

    it("sends players to where the last death was", () => {
        expect(
            consoleVars.commandLines("tp {player} {death.x} {death.y} {death.z}", fill, [
                { name: "Steve", values: {} }
            ])
        ).toEqual(["tp Steve 131 12 -240"]);
    });

    it("asks the game only for the per-player values it uses", () => {
        expect(
            consoleVars.playerReadsIn("tp {player} {player.x} {player.y} {player.x}", "java")
        ).toEqual(["player.x", "player.y"]);
        expect(consoleVars.playerReadsIn("say {server.name}", "java")).toEqual([]);
        expect(consoleVars.playerReadsIn("tp {player} {player.x}", "bedrock")).toEqual([]);
    });
});

describe("a text with coordinates", () => {
    it("draws the position from scores the game refreshes as the text is sent", () => {
        const objectives = vars.objectivesIn("{player.x} {player.y} {player.z}");
        expect(objectives.map((one) => [one.name, one.criterion])).toEqual([
            ["polaris_x", "dummy"],
            ["polaris_y", "dummy"],
            ["polaris_z", "dummy"]
        ]);
        expect(objectives[2]?.seed).toBe(
            "execute as @a store result score @s polaris_z run data get entity @s Pos[2]"
        );
        expect(vars.gamePieces(vars.fillValues("At {player.x}, {player.z}", {}))).toEqual([
            { text: "At " },
            { component: { score: { name: "@s", objective: "polaris_x" } } },
            { text: ", " },
            { component: { score: { name: "@s", objective: "polaris_z" } } }
        ]);
    });

    it("still draws the variables the game drew before", () => {
        expect(vars.gamePieces("{player} {player.level} {player.health}")).toEqual([
            { component: { selector: "@s" } },
            { text: " " },
            { component: { score: { name: "@s", objective: "polaris_level" } } },
            { text: " " },
            { component: { score: { name: "@s", objective: "polaris_health" } } }
        ]);
    });

    it("refuses the dimension, which a score cannot hold, and never offers it", () => {
        expect(english(vars.variableProblem("{player.dimension}", "java")!)).toBe(
            "{player.dimension} only works in console commands"
        );
        const offered = vars.textVariables("java").map((spec) => spec.name);
        expect(offered).toContain("player.x");
        expect(offered).toContain("death.dimension");
        expect(offered).not.toContain("player.dimension");
        expect(vars.textVariables("bedrock").map((spec) => spec.name)).not.toContain("player.x");
        expect(vars.textVariables("java", "server").map((spec) => spec.name)).not.toContain(
            "player.x"
        );
    });

    it("reads the server for the last death's place", () => {
        expect(vars.readsServer("{death.x}")).toBe(true);
        expect(vars.readsServer("{player.x}")).toBe(false);
    });
});
