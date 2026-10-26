/**
 * The route the create and reset forms poll while a map's world arrives.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const bundled = mkdtempSync(join(tmpdir(), "polaris-map-route-"));
process.env.POLARIS_MINECRAFT_WORLDS_DIR = bundled;
process.env.POLARIS_MINECRAFT_MAP_CACHE_DIR = join(bundled, "cache");

const asked: string[] = [];
vi.mock("@polaris/app-host", () => ({
    host: { session: { requirePermission: async (name: string) => void asked.push(name) } }
}));

const { WORLD_MAPS } = await import("@polaris-app/game-servers/src/lib/minecraft/maps");
const route =
    await import("@polaris-app/game-servers/src/routes/api/apps/games/maps/[mapId]/route");

const ask = (mapId: string) =>
    route.POST(new Request("https://polaris.example/x", { method: "POST" }), {
        params: Promise.resolve({ mapId })
    });

describe("the map route", () => {
    it("answers ready for a world already on disk, behind games.read", async () => {
        const map = WORLD_MAPS[0]!;
        writeFileSync(join(bundled, map.archive), Buffer.alloc(map.bytes));
        const response = await ask(map.id);
        expect(await response.json()).toEqual({ state: "ready" });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(asked).toContain("games.read");
    });

    it("refuses a map the catalog does not name", async () => {
        for (const id of ["nope", "", "x".repeat(65)]) {
            expect(await (await ask(id)).json()).toEqual({ state: "failed", reason: "failed" });
        }
    });
});
