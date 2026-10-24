/**
 * How a server's container downloads a map's world, and a player's client its
 * pack.
 *
 * A world is tens of megabytes, so its address carries the instance's key: a
 * wrong key is the same 404 as a missing file. A pack is fetched by game clients
 * that present nothing, so it is public. Both serve only the archives the map
 * catalog names, and count downloads per address.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "polaris-worlds-"));
writeFileSync(join(dir, "skyblock-2-1.zip"), "world-bytes");
writeFileSync(join(dir, "luckyblock-towers-resources.zip"), "pack-bytes");
writeFileSync(join(dir, "stray.zip"), "not-a-map");
process.env.POLARIS_MINECRAFT_WORLDS_DIR = dir;

const counted = new Map<string, number>();

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-token", () => ({
    modToken: () => "key",
    modTokenMatches: (token: string) => token === "key"
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        requestContext: { clientIp: async () => "203.0.113.7" },
        rateLimitService: {
            rateLimit: async (bucket: string, limit: number) => {
                const count = (counted.get(bucket) ?? 0) + 1;
                counted.set(bucket, count);
                return { ok: count <= limit, retryAfterMs: 0 };
            }
        }
    }
}));

beforeEach(() => counted.clear());

const world = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/world/[token]/[file]/route"
);
const pack = await import("@polaris-app/game-servers/src/routes/api/minecraft/map-pack/[file]/route");
const request = (method: string) => new Request("https://polaris.example/x", { method });
const worldParams = (file: string, token = "key") => ({ params: Promise.resolve({ token, file }) });
const packParams = (file: string) => ({ params: Promise.resolve({ file }) });

describe("a world, for a server's container", () => {
    it("serves the archive with the key", async () => {
        const head = await world.HEAD(request("HEAD"), worldParams("skyblock-2-1.zip"));
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe("11");
        const got = await world.GET(request("GET"), worldParams("skyblock-2-1.zip"));
        expect(got.status).toBe(200);
        expect(await got.text()).toBe("world-bytes");
    });

    it("answers a wrong key, a file no map names, and a pack the same: not found", async () => {
        expect((await world.GET(request("GET"), worldParams("skyblock-2-1.zip", "nope"))).status).toBe(404);
        expect((await world.GET(request("GET"), worldParams("stray.zip"))).status).toBe(404);
        expect((await world.GET(request("GET"), worldParams("../stray.zip"))).status).toBe(404);
        expect(
            (await world.GET(request("GET"), worldParams("luckyblock-towers-resources.zip"))).status
        ).toBe(404);
    });

    it("refuses past its limit", async () => {
        let last = 200;
        for (let i = 0; i < 12; i += 1)
            last = (await world.GET(request("GET"), worldParams("skyblock-2-1.zip"))).status;
        expect(last).toBe(429);
    });
});

describe("a pack, for a player's client", () => {
    it("serves a map's pack with no key", async () => {
        const got = await pack.GET(request("GET"), packParams("luckyblock-towers-resources.zip"));
        expect(got.status).toBe(200);
        expect(got.headers.get("content-type")).toBe("application/zip");
        expect(await got.text()).toBe("pack-bytes");
    });

    it("serves no world and nothing else through the public door", async () => {
        expect((await pack.GET(request("GET"), packParams("skyblock-2-1.zip"))).status).toBe(404);
        expect((await pack.HEAD(request("HEAD"), packParams("stray.zip"))).status).toBe(404);
    });
});
