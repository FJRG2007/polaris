/**
 * Spawn protection off on servers made while Polaris wrote the game's 16, and
 * an owner's own radius never undone.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/app-host", () => ({ host: { envVarService: { setEnvVars: vi.fn() } } }));

const { spawnProtectionWrites } = await import("@polaris-app/game-servers/src/lib/minecraft/spawn-protection");
const { findApp } = await import("@/lib/apps/catalog");

const env = (entries: [string, string][]) => new Map(entries);
const off = new Map([
    ["SPAWN_PROTECTION", "0"],
    ["POLARIS_SPAWN_PROTECTION", "off"]
]);

describe("spawn protection on servers made before", () => {
    it("turns off the 16 Polaris used to write, and an unset radius", () => {
        expect(spawnProtectionWrites(env([["SPAWN_PROTECTION", "16"]]))).toEqual(off);
        expect(spawnProtectionWrites(env([]))).toEqual(off);
    });

    it("leaves a radius the owner chose", () => {
        expect(spawnProtectionWrites(env([["SPAWN_PROTECTION", "4"]]))).toBeNull();
        expect(spawnProtectionWrites(env([["SPAWN_PROTECTION", "0"]]))).toBeNull();
    });

    it("never undoes an owner who set it back after Polaris turned it off", () => {
        expect(
            spawnProtectionWrites(env([["SPAWN_PROTECTION", "16"], ["POLARIS_SPAWN_PROTECTION", "off"]]))
        ).toBeNull();
    });
});

describe("spawn protection on new servers", () => {
    it("starts at 0", () => {
        const json = JSON.stringify(findApp("minecraft"));
        expect(json).toMatch(/"key":"SPAWN_PROTECTION"[^}]*"default":"0"/);
    });
});
