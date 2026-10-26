/**
 * The map store: a world is downloaded the first time a server needs it, by the
 * hash its catalog entry names, written whole or not at all, and reused after.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldMap } from "@polaris-app/game-servers/src/lib/minecraft/maps";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    writeFileSync
} from "node:fs";

const bundled = mkdtempSync(join(tmpdir(), "polaris-bundled-worlds-"));
let cache = "";
process.env.POLARIS_MINECRAFT_WORLDS_DIR = bundled;
// The build's placeholders stand in for the secrets nothing here reads.
process.env.NEXT_PHASE = "phase-production-build";
process.env.POLARIS_APP_BUNDLES_DIR = join(bundled, "no-index");
process.env.POLARIS_WEB_IMAGE = "registry.example/owner/polaris-dashboard:latest";

const store = await import("@polaris-app/game-servers/src/lib/minecraft/map-store");

const BYTES = Buffer.from("a world archive, as far as this test is concerned");
const SHA = createHash("sha256").update(BYTES).digest("hex");

function fixtureMap(id = "fixture-map", bytes = BYTES): WorldMap {
    return {
        id,
        name: "Fixture",
        category: "parkour",
        summary: "",
        author: "",
        source: "https://example.invalid",
        archive: `${id}.zip`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        minecraft: { version: "1.20", policy: "from" },
        players: { min: 1, max: 2 },
        projects: []
    };
}

/** A registry that answers the token and then the blob, honouring a range. */
function registry(body: Buffer = BYTES, status?: number) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: init?.headers ?? {} });
        if (url.includes("/token?")) return Response.json({ token: "t" });
        if (status) return new Response(null, { status });
        const range = /bytes=(\d+)-/.exec(init?.headers?.range ?? "");
        if (range) return new Response(body.subarray(Number(range[1])), { status: 206 });
        return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    return { calls, fetcher };
}

beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "polaris-map-cache-"));
    process.env.POLARIS_MINECRAFT_MAP_CACHE_DIR = cache;
    store.resetMapStore();
});
afterEach(() => vi.unstubAllGlobals());

describe("downloading a map", () => {
    it("fetches the blob by the catalog's hash, from the image's registry, and keeps it", async () => {
        const { calls } = registry();
        const map = fixtureMap();
        const location = await store.ensureMap(map);
        expect(location).toBe(store.cachedPath(map));
        expect(readFileSync(location)).toEqual(BYTES);
        const blob = calls.find((call) => call.url.includes("/blobs/"));
        expect(blob?.url).toBe(
            `https://registry.example/v2/owner/polaris-dashboard/blobs/sha256:${SHA}`
        );
        expect(blob?.headers.authorization).toBe("Bearer t");
        // Written whole: no part file is left beside it.
        expect(readdirSync(cache)).toEqual([`fixture-map-${SHA}.zip`]);
    });

    it("reuses what it kept without asking again", async () => {
        const map = fixtureMap();
        registry();
        await store.ensureMap(map);
        const { fetcher } = registry();
        expect(await store.ensureMap(map)).toBe(store.cachedPath(map));
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("downloads once however many ask at the same time", async () => {
        const { calls } = registry();
        const map = fixtureMap();
        const all = await Promise.all([
            store.ensureMap(map),
            store.ensureMap(map),
            store.ensureMap(map)
        ]);
        expect(new Set(all).size).toBe(1);
        expect(calls.filter((call) => call.url.includes("/blobs/"))).toHaveLength(1);
    });

    it("refuses bytes that do not hash to the catalog's, and keeps nothing", async () => {
        registry(Buffer.from("x".repeat(BYTES.length)));
        await expect(store.ensureMap(fixtureMap())).rejects.toMatchObject({ reason: "corrupt" });
        expect(readdirSync(cache)).toEqual([]);
    });

    it("refuses an answer longer than the archive", async () => {
        registry(Buffer.concat([BYTES, Buffer.from("more")]));
        await expect(store.ensureMap(fixtureMap())).rejects.toMatchObject({ reason: "corrupt" });
        expect(existsSync(store.cachedPath(fixtureMap()))).toBe(false);
    });

    it("says a world that is not published is not, without retrying", async () => {
        const { calls } = registry(BYTES, 404);
        await expect(store.ensureMap(fixtureMap())).rejects.toMatchObject({
            reason: "notPublished"
        });
        expect(calls.filter((call) => call.url.includes("/blobs/"))).toHaveLength(1);
    });

    it("resumes a download that was cut off, with a range", async () => {
        const map = fixtureMap();
        mkdirSync(cache, { recursive: true });
        writeFileSync(`${store.cachedPath(map)}.part`, BYTES.subarray(0, 10));
        const { calls } = registry();
        expect(readFileSync(await store.ensureMap(map))).toEqual(BYTES);
        expect(calls.find((call) => call.url.includes("/blobs/"))?.headers.range).toBe("bytes=10-");
        expect(existsSync(`${store.cachedPath(map)}.part`)).toBe(false);
    });

    it("drops the copy of a reissued map once the new one is here", async () => {
        const map = fixtureMap();
        const old = join(cache, `fixture-map-${"0".repeat(64)}.zip`);
        const other = join(cache, `fixture-map-2-${"0".repeat(64)}.zip`);
        writeFileSync(old, "old");
        writeFileSync(other, "another map's");
        registry();
        await store.ensureMap(map);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(other)).toBe(true);
    });

    it("uses the copy an older bundle still carries, by its size", async () => {
        const map = fixtureMap("bundled-map");
        writeFileSync(join(bundled, map.archive), BYTES);
        const { fetcher } = registry();
        expect(await store.ensureMap(map)).toBe(join(bundled, map.archive));
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe("what a form is told while it waits", () => {
    it("is downloading, then ready", async () => {
        registry();
        const map = fixtureMap();
        expect((await store.prepareMap(map)).state).toBe("downloading");
        await store.ensureMap(map);
        expect(await store.prepareMap(map)).toEqual({ state: "ready" });
    });

    it("reports a failure once, and asking again is a retry", async () => {
        registry(BYTES, 404);
        const map = fixtureMap();
        await store.prepareMap(map);
        await store.ensureMap(map).catch(() => undefined);
        expect(await store.prepareMap(map)).toEqual({ state: "failed", reason: "notPublished" });
        registry();
        expect((await store.prepareMap(map)).state).toBe("downloading");
        await store.ensureMap(map);
        expect(await store.prepareMap(map)).toEqual({ state: "ready" });
    });

    it("tries again rather than reporting a failure nobody was waiting for", async () => {
        registry(BYTES, 404);
        const map = fixtureMap();
        await store.ensureMap(map).catch(() => undefined);
        const now = Date.now();
        vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
        try {
            registry();
            expect((await store.prepareMap(map)).state).toBe("downloading");
            await store.ensureMap(map);
            expect(await store.prepareMap(map)).toEqual({ state: "ready" });
        } finally {
            vi.restoreAllMocks();
        }
    });
});

describe("where maps are downloaded from", () => {
    it("is where the app bundles come from, by the same rule", async () => {
        const { registryOf } = await import("@/lib/app-bundles/store");
        const dir = mkdtempSync(join(tmpdir(), "polaris-bundle-index-"));
        const previous = process.env.POLARIS_APP_BUNDLES_DIR;
        process.env.POLARIS_APP_BUNDLES_DIR = dir;
        try {
            const index = { format: 1, build: "x", apps: {} };
            expect(store.mapRegistry()).toEqual(registryOf(index));
            const published = { ...index, registry: "ghcr.example/team/polaris-dashboard:tag" };
            writeFileSync(join(dir, "index.json"), JSON.stringify(published));
            expect(store.mapRegistry()).toEqual(registryOf(published));
            expect(store.mapRegistry()).toEqual({
                host: "ghcr.example",
                repository: "team/polaris-dashboard"
            });
        } finally {
            process.env.POLARIS_APP_BUNDLES_DIR = previous;
        }
    });
});
