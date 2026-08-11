/**
 * What an ARK server is created as, and what it says back.
 *
 * Three things worth holding still. The ports, because ARK's raw socket has to be
 * exactly one above its game port on the player's side of the mapping - so they
 * are allocated as a run and the container is told to bind those exact numbers,
 * and an off-by-one here is a server nobody can reach.
 *
 * The environment, because both of the image's own password defaults are printed
 * in its documentation. A server created without a password of its own is not a
 * server with a weak password, it is a server with a published one.
 *
 * And the player list, because "nobody is playing" and "the server has not
 * finished starting" arrive as different silences and must not be read as the same
 * answer - a new ARK server spends a long while installing, and reporting that as
 * an empty server is how somebody concludes it is broken.
 */

import { describe, expect, it } from "vitest";
import type { CreateArkServerInput } from "@/lib/apps/games-schema";
import { EXCLUSIVE_JOIN, GAME_LOG, hasLaunchFlag, isJoinPassword } from "@/lib/apps/ark/access";
import { parseArkPlayers, isRconRefusal } from "@/lib/apps/ark/parse";
import { arkPortsFrom, arkServerEnv, expectedArkMemoryMb, normalizeModIds } from "@/lib/apps/ark/config";

/** The admin password the install mints. Short enough that ARK takes it at the
 *  enablecheats prompt, which is the whole reason it is not the 48-hex value the
 *  generic generated-secret path produces. */
const ADMIN = "Nb7QkPr2Vt9Zc4Hm";

function input(overrides: Partial<CreateArkServerInput> = {}): CreateArkServerInput {
    return {
        game: "ark",
        name: "Island",
        serverId: "local",
        maxPlayers: 20,
        concurrentPlayers: 8,
        map: "TheIsland",
        sessionName: "Island",
        joinPassword: "Correct9Horse",
        ownerSteamId: "76561198000000001",
        exclusiveJoin: true,
        ...overrides
    };
}

describe("the ports a server binds", () => {
    it("puts the raw socket exactly one above the game port", () => {
        const ports = arkPortsFrom(19140);
        expect(ports).toEqual({ game: 19140, raw: 19141, query: 19142 });
    });

    it("hands the server the same numbers it was published on", () => {
        const env = arkServerEnv(input(), arkPortsFrom(19140), ADMIN);
        expect(env.GAME_CLIENT_PORT).toBe("19140");
        expect(env.UDP_SOCKET_PORT).toBe("19141");
        expect(env.SERVER_LIST_PORT).toBe("19142");
    });
});

describe("the environment a server is created with", () => {
    it("never leaves the image's own join password in place", () => {
        const env = arkServerEnv(input(), arkPortsFrom(7777), ADMIN);
        expect(env.SERVER_PASSWORD).toBe("Correct9Horse");
        // The image's documented default, which is the one thing this must never be.
        expect(env.SERVER_PASSWORD).not.toBe("YouShallNotPass");
    });

    it("closes the server to everyone who was not added", () => {
        const options = arkServerEnv(input(), arkPortsFrom(7777), ADMIN).ARK_EXTRA_OPTS ?? "";
        expect(hasLaunchFlag(options, EXCLUSIVE_JOIN)).toBe(true);
    });

    it("leaves it open when the operator deliberately said so", () => {
        const options = arkServerEnv(input({ exclusiveJoin: false }), arkPortsFrom(7777), ADMIN).ARK_EXTRA_OPTS ?? "";
        expect(hasLaunchFlag(options, EXCLUSIVE_JOIN)).toBe(false);
    });

    it("records what happens in the game from the first start", () => {
        // ARK keeps no log of chat or admin commands unless it is asked to, and
        // the moment that is wanted is always after something went unrecorded.
        const options = arkServerEnv(input(), arkPortsFrom(7777), ADMIN).ARK_EXTRA_OPTS ?? "";
        expect(hasLaunchFlag(options, GAME_LOG)).toBe(true);
    });

    it("carries the admin password it was handed, and never one of its own", () => {
        // Naming one here would put it in the source. It is minted per install and
        // passed in, which is also what keeps it short enough for ARK to take.
        expect(arkServerEnv(input(), arkPortsFrom(7777), ADMIN).ADMIN_PASSWORD).toBe(ADMIN);
        expect(isJoinPassword(ADMIN)).toBe(true);
    });

    it("carries the map and the size the operator chose", () => {
        const env = arkServerEnv(input({ map: "Aberration_P", maxPlayers: 40 }), arkPortsFrom(7777), ADMIN);
        expect(env.SERVER_MAP).toBe("Aberration_P");
        expect(env.MAX_PLAYERS).toBe("40");
    });

    it("passes mods only when there are any, and without the spacing somebody typed", () => {
        expect(arkServerEnv(input(), arkPortsFrom(7777), ADMIN).GAME_MOD_IDS).toBeUndefined();
        expect(arkServerEnv(input({ mods: "111, 222 ,333" }), arkPortsFrom(7777), ADMIN).GAME_MOD_IDS).toBe("111,222,333");
    });
});

describe("what a server is expected to use", () => {
    it("starts well above a Minecraft server, because ARK does", () => {
        expect(expectedArkMemoryMb(1)).toBeGreaterThanOrEqual(6144);
    });

    it("grows with the players and stops somewhere sane", () => {
        expect(expectedArkMemoryMb(20)).toBeGreaterThan(expectedArkMemoryMb(4));
        expect(expectedArkMemoryMb(1000)).toBeLessThanOrEqual(32768);
    });
});

describe("normalizing workshop ids", () => {
    it("keeps the numbers and drops the rest of what was typed", () => {
        expect(normalizeModIds(" 731604991 ,  893735676 , ")).toBe("731604991,893735676");
    });
});

describe("reading who is on", () => {
    it("reads the server's list, whatever arkmanager printed above it", () => {
        const output = [
            "Running command 'ListPlayers' on main",
            "0. Alice, 76561198000000001",
            "1. Bob with, a comma, 76561198000000002"
        ].join("\n");
        expect(parseArkPlayers(output)).toEqual([
            { name: "Alice", steamId: "76561198000000001" },
            { name: "Bob with, a comma", steamId: "76561198000000002" }
        ]);
    });

    it("reads an empty server as empty", () => {
        expect(parseArkPlayers("No Players Connected")).toEqual([]);
    });

    it("reads a server that said nothing as unknown, not as empty", () => {
        // The state a new server sits in while it installs. An empty array here
        // would have the panel report a working, empty server.
        expect(parseArkPlayers("")).toBeNull();
        expect(parseArkPlayers("Server not running")).toBeNull();
    });

    it("knows the RCON client's own refusal from the server's answer", () => {
        expect(isRconRefusal("Error: connection refused")).toBe(true);
        expect(isRconRefusal("No Players Connected")).toBe(false);
    });
});
