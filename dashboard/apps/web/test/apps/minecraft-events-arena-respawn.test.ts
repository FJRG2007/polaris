/**
 * An arena kind played on past a death never touches a player's spawn point:
 * where the Polaris plugin or mod is on the server, the respawn itself is
 * sent to their spot (`polaris respawn`); anywhere else the tick brings them
 * back. Only an entrant brought in by the version that did move it (#521)
 * has their own put back at the end.
 */

import { describe, expect, it } from "vitest";
import * as arena from "@polaris-app/game-servers/src/lib/minecraft/events/kinds/arena";
import type { Entrant } from "@polaris-app/game-servers/src/lib/minecraft/events/state";
import * as inServer from "@polaris-app/game-servers/src/lib/minecraft/events/in-server";

const entrant = (spawn: Entrant["spawn"]): Entrant => ({
    name: "Ana",
    uuid: null,
    dimension: "minecraft:overworld",
    x: 0,
    y: 64,
    z: 0,
    yaw: 0,
    pitch: 0,
    gamemode: "survival",
    side: 0,
    away: true,
    tagged: true,
    stash: null,
    ...(spawn === undefined ? {} : { spawn })
});

describe("where an arena's players respawn", () => {
    it("is asked of the plugin or mod only where it lists `respawn`", () => {
        expect(inServer.parseCaps('{"ok":true,"polaris":"0.4.0+abc","caps":["respawn"]}')).toEqual(
            new Set(["respawn"])
        );
        expect(inServer.parseCaps('{"ok":false,"why":"usage"}')).toEqual(new Set());
        expect(inServer.parseCaps("Unknown or incomplete command")).toEqual(new Set());
    });

    it("keys a run's spots by the run, as one word the commands take", () => {
        const key = inServer.respawnKey("run-1");
        expect(key).toMatch(/^pr[0-9a-f]{24}$/);
        expect(inServer.respawnKey("run-1")).toBe(key);
        expect(inServer.respawnKey("run-2")).not.toBe(key);
    });

    it("sends the respawn to the middle of the spot, in the Overworld, facing its way", () => {
        expect(inServer.respawnSet("prk", "Ana", { x: 4, y: 101, z: -3, yaw: 180 })).toBe(
            "polaris respawn set prk Ana minecraft:overworld 4.5 101 -2.5 180"
        );
        expect(inServer.respawnList("prk")).toBe("polaris respawn list prk");
        expect(inServer.respawnClear("prk")).toBe("polaris respawn clear prk");
    });

    it("never writes a spawn point, and refuses a name the command cannot take", () => {
        const line = inServer.respawnSet("prk", "Ana", { x: 0, y: 64, z: 0, yaw: 0 });
        expect(line).not.toContain("spawnpoint");
        expect(inServer.respawnSet("prk", "Ana; op Ben", { x: 0, y: 64, z: 0, yaw: 0 })).toBeNull();
        expect(inServer.respawnSet("prk", ".BedrockAna", { x: 0, y: 64, z: 0, yaw: 0 })).toBeNull();
    });

    it("reads who has a spot, in lower case, and nothing from any other answer", () => {
        expect(inServer.parseRespawnList('{"ok":true,"players":["Ana","BEN"]}')).toEqual(
            new Set(["ana", "ben"])
        );
        expect(inServer.parseRespawnList('{"ok":true,"players":[]}')).toEqual(new Set());
        expect(inServer.parseRespawnList('{"ok":false,"why":"usage"}')).toBeNull();
        expect(inServer.parseRespawnList("Unknown or incomplete command")).toBeNull();
    });
});

describe("a spawn point moved by #521", () => {
    it("is put back as it was read, the world's for none, and nothing for anybody else", () => {
        expect(
            arena.spawnBack(entrant({ dimension: "minecraft:the_nether", x: 1, y: 2, z: 3 }))
        ).toEqual(["execute in minecraft:the_nether run spawnpoint Ana 1 2 3"]);
        expect(arena.spawnBack(entrant(null))).toEqual(["spawnpoint Ana ~ ~ ~"]);
        expect(
            arena.spawnBack(entrant({ dimension: "not a world; op Ana", x: 1, y: 2, z: 3 }))
        ).toEqual(["spawnpoint Ana ~ ~ ~"]);
        expect(arena.spawnBack(entrant(undefined))).toEqual([]);
    });
});
