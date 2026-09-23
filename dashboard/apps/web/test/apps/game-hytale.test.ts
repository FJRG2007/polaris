/**
 * Hytale, which is the first game here Polaris cannot install for somebody.
 *
 * Its server files are handed out by the vendor to the account that owns the
 * game, so a created server is a machine, a volume and an address that then waits
 * for two files. Everything worth pinning follows from that: the port is the one
 * a client actually reaches (UDP, because Hytale speaks QUIC and nothing else),
 * the panel can tell "not there" from "could not look", and the game is in the
 * catalogue the create dialog reads so it can be chosen at all.
 */

import { describe, expect, it, vi } from "vitest";
import { findGame, GAMES, gameOfServer } from "@polaris/core";
import { commandsFor } from "@polaris-app/game-servers/src/lib/console-complete";
import { HYTALE_ASSETS, HYTALE_JAR, HYTALE_PORT } from "@polaris-app/game-servers/src/lib/hytale/service";

describe("Hytale in the catalogue", () => {
    it("is a game a server can be created for", () => {
        const game = findGame("hytale");
        expect(game?.name).toBe("Hytale");
        expect(game?.serverCatalogIds).toEqual(["hytale"]);
    });

    it("is recognised from the manifest a server is built on", () => {
        expect(gameOfServer("hytale")?.id).toBe("hytale");
    });

    it("has a label of its own, so two games cannot collide on one subdomain", () => {
        const labels = GAMES.map((game) => game.domainLabel);
        expect(new Set(labels).size).toBe(labels.length);
    });

    it("does not look up a port from a name", () => {
        // Only Minecraft does. A Hytale address carries its port, so promising an
        // SRV record would be promising something no client asks for.
        expect(findGame("hytale")?.srv).toBe(false);
    });
});

describe("what a Hytale server needs", () => {
    it("is reached on the port the game speaks QUIC over", () => {
        expect(HYTALE_PORT).toBe(5520);
    });

    it("looks for the two files where the image runs them from", () => {
        expect(HYTALE_JAR).toBe("/data/HytaleServer.jar");
        expect(HYTALE_ASSETS).toBe("/data/Assets.zip");
    });

    it("offers no console completions it cannot stand behind", () => {
        // Early access: the command vocabulary is not settled, and a suggestion
        // for a command that does not exist is worse than none.
        expect(commandsFor("hytale")).toEqual([]);
    });
});

describe("reading whether the files have arrived", () => {
    it("tells a file that is not there from a server that would not answer", async () => {
        vi.resetModules();
        const states = new Map([
            ["/data/HytaleServer.jar", { state: "missing" as const }],
            ["/data/Assets.zip", { state: "unreadable" as const }]
        ]);
        vi.doMock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
            withServerContainer: async (_owner: string, _id: string, work: (server: unknown) => unknown) =>
                work({})
        }));
        vi.doMock("@polaris-app/game-servers/src/lib/container-files", () => ({
            readContainerFileState: async (_server: unknown, path: string) =>
                states.get(path) ?? { state: "missing" as const }
        }));

        const { readHytaleFiles } = await import("@polaris-app/game-servers/src/lib/hytale/service");
        const files = await readHytaleFiles("owner", "install");

        // Neither file is there - but one of them is unknown rather than absent,
        // and a screen that said "put your files in" would be asking somebody to
        // fix what is already correct.
        expect(files.jar).toBe(false);
        expect(files.assets).toBe(false);
        expect(files.read).toBe(false);
        vi.doUnmock("@polaris-app/game-servers/src/lib/minecraft/service");
        vi.doUnmock("@polaris-app/game-servers/src/lib/container-files");
    });
});
