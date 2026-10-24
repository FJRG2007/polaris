import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLES, GAMES_CAPABILITIES, PERMISSIONS, PERMISSION_META } from "@polaris/core";
// @ts-expect-error - plain browser module without types
import { decodeGeo, encodeGeo } from "../../../arcade/game/new-york/engine/geo-codec.js";
import { GAMES, findGame, gameFrameSrc } from "../../../arcade/src/games/registry";
import enUS from "../../../arcade/messages/en-US/games.json";
import esES from "../../../arcade/messages/es-ES/games.json";

describe("games registry", () => {
    it("has unique ids, each with a name in both languages", () => {
        const ids = GAMES.map((game) => game.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect((enUS.games as Record<string, { name: string }>)[id]?.name).toBeTruthy();
            expect((esES.games as Record<string, { name: string }>)[id]?.name).toBeTruthy();
        }
    });

    it("finds a game by id and serves it from the app bundle", () => {
        const game = findGame("new-york");
        expect(game?.multiplayer).toBe(true);
        expect(findGame("nope")).toBeNull();
        expect(gameFrameSrc(game!)).toBe(
            "/api/app-bundles/arcade/current/assets/new-york/index.html"
        );
    });
});

describe("games permissions", () => {
    it("are real permissions with labels", () => {
        for (const permission of GAMES_CAPABILITIES) {
            expect(PERMISSIONS).toContain(permission);
            expect(PERMISSION_META[permission].area).toBe("Games");
        }
    });

    it("are granted to members and viewers, never to guests", () => {
        for (const permission of GAMES_CAPABILITIES) {
            expect(DEFAULT_ROLES.member).toContain(permission);
            expect(DEFAULT_ROLES.viewer).toContain(permission);
            expect(DEFAULT_ROLES.guest).not.toContain(permission);
        }
    });
});

describe("geo codec", () => {
    it("round-trips every kind of value exactly", () => {
        const tree = {
            version: 1,
            name: "x",
            empty: [],
            mixed: [1, "a", null, true],
            short: [1.5, -2],
            long: Array.from({ length: 200 }, (_, i) => (i % 7) * 13.37 - 500.1),
            wide: Array.from({ length: 50 }, (_, i) => i * Math.PI),
            big: Array.from({ length: 40 }, (_, i) => i * 1e12 + 0.5),
            nested: { rings: [Array.from({ length: 64 }, (_, i) => i * 0.001)] }
        };
        expect(decodeGeo(encodeGeo(tree))).toEqual(tree);
    });

    it("decodes the shipped city and writes the same bytes back", () => {
        const file = fileURLToPath(
            new URL("../../../arcade/game/new-york/data/geo.bin", import.meta.url)
        );
        const bytes = new Uint8Array(readFileSync(file));
        const geo = decodeGeo(bytes);
        expect(geo.version).toBe(1);
        expect(Buffer.from(encodeGeo(geo)).equals(Buffer.from(bytes))).toBe(true);
    });

    it("refuses bytes that are not city data", () => {
        expect(() => decodeGeo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
    });
});
