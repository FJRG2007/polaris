/**
 * The default skin a player with no skin of their own is drawn in, picked from
 * their UUID the way the client picks it.
 *
 * Every expected value below was produced by running the JDK's own
 * `java.util.UUID` (Temurin 21): `Math.floorMod(UUID.fromString(id).hashCode(), 18)`
 * for the indexes, and `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name)
 * .getBytes(UTF_8))` for the offline identities. The order of the eighteen is the
 * one `DefaultPlayerSkin.<clinit>` writes in the 26.3 client jar.
 */

import { describe, expect, it } from "vitest";
import * as skin from "@polaris-app/game-servers/src/lib/minecraft/default-skin";
import { offlineUuid } from "@polaris-app/game-servers/src/lib/minecraft/offline-identity";

const BASE = "/api/app-bundles/game-servers/current/assets/default-skins";

/** `DEFAULT_SKINS` as the client fills it: slim first, then wide. */
const ORDER = [
    "slim/alex",
    "slim/ari",
    "slim/efe",
    "slim/kai",
    "slim/makena",
    "slim/noor",
    "slim/steve",
    "slim/sunny",
    "slim/zuri",
    "wide/alex",
    "wide/ari",
    "wide/efe",
    "wide/kai",
    "wide/makena",
    "wide/noor",
    "wide/steve",
    "wide/sunny",
    "wide/zuri"
];

/** One fixture UUID per index, each checked in Java. */
const ONE_PER_INDEX: Record<number, string> = {
    0: "81af1551-73f2-3d65-eddd-920fa523a03f",
    1: "28b7bd76-6a05-068b-93a3-1967d2c87e91",
    2: "08d12e6b-76c8-4d11-e312-d91b05cff303",
    3: "78dde6e5-fd29-f054-0aca-b8f49f53ad3c",
    4: "b54cda58-fbbe-e87e-9030-156eeefd83da",
    5: "c6ef372f-e94f-82a0-5655-c7a4fa9d69e0",
    6: "1715609f-7c74-6c69-cd7d-6731c728988b",
    7: "98c475f0-f066-a9ce-bb5a-f9416c4c38ca",
    8: "6a99b4b1-f77d-d0fc-2060-2addddfb07b4",
    9: "daa66d2c-7ddf-743f-4818-0ab7777ec1ed",
    10: "3c6ef372-fe94-f82a-8565-5c7a4fa9d69e",
    11: "be1e08c4-7287-358f-7342-ee89f4cd76dd",
    12: "36fbefaa-6fb1-25e3-7e0d-a77e94212419",
    13: "e3779b97-f4a7-c150-2b2a-e3d27d4eb4f0",
    14: "9e3779b9-7f4a-7c15-c2b2-ae3d27d4eb4f",
    15: "4bfc7724-4526-3acf-1fee-7dd3ea084a9d",
    16: "53845412-7b09-6493-52e2-c3ac16d26f29",
    17: "fa8cfc37-711c-2db9-f8a8-4b0444774d7b"
};

describe("UUID hash", () => {
    it("matches java.util.UUID.hashCode, overflow included", () => {
        expect(skin.uuidHashCode("00000000-0000-0000-0000-000000000000")).toBe(0);
        expect(skin.uuidHashCode("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(0);
        expect(skin.uuidHashCode("123e4567-e89b-12d3-a456-426614174000")).toBe(1256478162);
        expect(skin.uuidHashCode("00000000-0000-0000-0000-000000000011")).toBe(17);
        expect(skin.uuidHashCode("80000000-0000-0000-0000-000000000000")).toBe(-2147483648);
        expect(skin.uuidHashCode("00000000-8000-0000-0000-000000000000")).toBe(-2147483648);
    });

    it("reads an id without dashes or in capitals the same", () => {
        expect(skin.uuidHashCode("123E4567E89B12D3A456426614174000")).toBe(1256478162);
    });

    it("refuses what is not a UUID", () => {
        expect(skin.uuidHashCode("")).toBeNull();
        expect(skin.uuidHashCode("not-a-uuid")).toBeNull();
        expect(skin.uuidHashCode("123e4567-e89b-12d3-a456-42661417400")).toBeNull();
        expect(skin.uuidHashCode("123e4567-e89b-12d3-a456-42661417400g")).toBeNull();
    });
});

describe("default skin", () => {
    it("lands on every one of the eighteen, in the client's order", () => {
        for (const [index, uuid] of Object.entries(ONE_PER_INDEX)) {
            expect(skin.defaultSkinIndex(uuid)).toBe(Number(index));
            expect(skin.defaultSkin(uuid).path).toBe(`${BASE}/${ORDER[Number(index)]}.png`);
        }
    });

    it("takes the floor modulus, so a negative hash still lands in range", () => {
        // hash -2147483648: Math.floorMod(-2147483648, 18) is 16 in Java.
        expect(skin.defaultSkin("80000000-0000-0000-0000-000000000000")).toEqual({
            name: "sunny",
            model: "classic",
            path: `${BASE}/wide/sunny.png`
        });
        expect(skin.defaultSkinIndex("123e4567-e89b-12d3-a456-426614174000")).toBe(6);
        expect(skin.defaultSkinIndex("00000000-0000-0000-0000-000000000012")).toBe(0);
    });

    it("names the arm model the way the skin tools do", () => {
        expect(skin.defaultSkin(ONE_PER_INDEX[0]!)).toEqual({
            name: "alex",
            model: "slim",
            path: `${BASE}/slim/alex.png`
        });
        expect(skin.defaultSkin(ONE_PER_INDEX[15]!)).toEqual({
            name: "steve",
            model: "classic",
            path: `${BASE}/wide/steve.png`
        });
    });

    it("falls back to the client's own default for an unreadable id", () => {
        expect(skin.defaultSkin("nope")).toEqual({
            name: "steve",
            model: "slim",
            path: `${BASE}/slim/steve.png`
        });
    });
});

describe("offline players", () => {
    // [name, UUID.nameUUIDFromBytes, index of that UUID], all from Java.
    const VECTORS: [string, string, number][] = [
        ["Player", "a01e3843-e521-3998-958a-f459800e4d11", 13],
        ["Fixture_01", "02ac80fc-29e0-35ce-9a0c-7c826c7aeb62", 6],
        ["a", "52428a0e-1e30-3cb1-976c-e728b2614047", 10],
        ["", "fc5bc365-aedf-30a8-8b89-04e462e29bde", 15],
        ["Ñandú", "e84d4d3b-134e-3567-b164-fe027678edc8", 0],
        ["Test Name", "56be7a5a-cf0b-3c8e-b9f6-ba35aeebbcc9", 8]
    ];

    it("get the identity the server invents, and the skin that goes with it", () => {
        for (const [name, uuid, index] of VECTORS) {
            expect(offlineUuid(name)).toBe(uuid);
            expect(skin.defaultSkinIndex(offlineUuid(name))).toBe(index);
        }
    });
});
