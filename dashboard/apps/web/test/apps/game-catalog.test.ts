/**
 * The games Polaris offers, against the manifests they are actually made of.
 *
 * The registry and the catalog are two lists that have to agree, and nothing at
 * runtime forces them to: a game naming a manifest that does not exist is a create
 * that fails at the last step, and a game server whose manifest forgot to declare
 * itself one is a server that never appears on the page that manages it. Both are
 * cheap to check and impossible to notice by reading.
 *
 * The rest is the posture an ARK server is created in. Its image ships a join
 * password and an admin password that are published in its own documentation, so
 * "the manifest carries no default for either" is not a style rule - it is the
 * difference between a private server and a public one.
 */

import { describe, expect, it } from "vitest";
import { appHasCapability, findApp, isInstallable, tunableEnvVars } from "@/lib/apps/catalog";
import { GAMES, findGame, gameForCatalogId, gameOfServer, isGameManagerApp } from "@/lib/apps/games-catalog";

describe("every game", () => {
    it("names a manager the marketplace can actually install", () => {
        for (const game of GAMES) {
            const manifest = findApp(game.managerCatalogId);
            expect(manifest, `${game.id} manager`).toBeDefined();
            expect(appHasCapability(manifest!, "game-manager")).toBe(true);
            expect(isInstallable(manifest!)).toBe(true);
        }
    });

    it("names server manifests that declare themselves game servers", () => {
        for (const game of GAMES) {
            expect(game.serverCatalogIds.length).toBeGreaterThan(0);
            for (const id of game.serverCatalogIds) {
                const manifest = findApp(id);
                expect(manifest, `${id} manifest`).toBeDefined();
                expect(appHasCapability(manifest!, "game-server")).toBe(true);
                // Created by the manager, never installed from the marketplace.
                expect(manifest!.internal).toBe(true);
            }
        }
    });

    it("keeps its servers on a subdomain of its own", () => {
        const labels = GAMES.map((game) => game.domainLabel);
        expect(new Set(labels).size).toBe(labels.length);
    });

    it("is found from any of its catalog ids, and nothing else is", () => {
        expect(gameForCatalogId("minecraft-bedrock")?.id).toBe("minecraft");
        expect(gameForCatalogId("ark-manager")?.id).toBe("ark");
        expect(gameForCatalogId("messaging-bridge")).toBeUndefined();
        // A manager is not a server: dispatching a live read onto one would ask a
        // container that does not exist.
        expect(gameOfServer("ark-manager")).toBeNull();
        expect(gameOfServer("ark")?.id).toBe("ark");
        expect(isGameManagerApp("minecraft-manager")).toBe(true);
        expect(isGameManagerApp("minecraft")).toBe(false);
    });

    it("is looked up by id", () => {
        expect(findGame("ark")?.name).toBe("ARK: Survival Evolved");
        expect(findGame("halo")).toBeUndefined();
    });
});

describe("the ARK server manifest", () => {
    const ark = findApp("ark")!;
    const env = ark.template?.env ?? [];
    const field = (key: string) => env.find((entry) => entry.key === key);

    it("carries no default for either password", () => {
        // Both of the image's own defaults are in its README. A default here would
        // be a server anybody who read it can get into.
        expect(field("SERVER_PASSWORD")?.default).toBeUndefined();
        expect(field("ADMIN_PASSWORD")?.default).toBeUndefined();
    });

    it("does not mint the admin password the generic way", () => {
        // The generic path produces 48 hex characters, which ARK refuses at its own
        // enablecheats prompt - so the server's admin could not get in. The create
        // flow mints this one to the shape the game takes.
        expect(field("ADMIN_PASSWORD")?.generated).toBeFalsy();
        expect(field("ADMIN_PASSWORD")?.required).toBe(true);
        expect(field("ADMIN_PASSWORD")?.secret).toBe(true);
    });

    it("refuses an empty join password rather than falling back to the image's", () => {
        expect(field("SERVER_PASSWORD")?.required).toBe(true);
        expect(field("SERVER_PASSWORD")?.secret).toBe(true);
    });

    it("never offers a password as an editable setting", () => {
        // The settings form reads secrets back masked, so a tunable secret would be
        // saved as a blank over the real one.
        for (const setting of tunableEnvVars(ark)) {
            expect(setting.secret ?? false, setting.key).toBe(false);
        }
    });

    it("leaves the launch options to the screen that owns them", () => {
        // They hold the flag that closes the server; a free-text edit that dropped
        // that one word would reopen it silently.
        expect(field("ARK_EXTRA_OPTS")?.tunable).toBeFalsy();
    });

    it("starts with the anticheat on and Epic clients out", () => {
        expect(field("DISABLE_BATTLEYE")?.default).toBe("false");
        expect(field("ENABLE_CROSSPLAY")?.default).toBe("false");
    });

    it("publishes the three ports the game speaks, and not RCON", () => {
        const ports = ark.template?.ports ?? [];
        expect(ports.map((port) => port.container)).toEqual([7777, 7778, 27015]);
        expect(ports.every((port) => port.protocol === "udp")).toBe(true);
        // 27020 is RCON. Commands are run inside the container, so nothing is
        // exposed on the network for the console to work.
        expect(ports.some((port) => port.container === 27020)).toBe(false);
    });
});
