/**
 * How a Minecraft server's image downloads the login mod.
 *
 * The image asks HEAD, then GET, on every boot, and anything but a success ends
 * that boot. It also keeps a jar it already has whenever it is told a date older
 * than its own copy - and its copy is dated when it was downloaded. So the answers
 * pinned here are the jar, never a date or a 304 that would let a server keep an
 * older build, and a 404 for anything that is not one of the builds.
 *
 * The jar is megabytes, so the address a server is given carries the instance's
 * key, and every download is counted per address: a wrong key is a 404, and too
 * many downloads is a 429 instead of the file.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-mods-"));
const JAR = "polaris-neoforge-1.21.4.jar";
writeFileSync(join(dir, JAR), "jar-bytes");
writeFileSync(join(dir, `${JAR}.version`), "0.1.0+abc123\n");
process.env.POLARIS_MINECRAFT_MODS_DIR = dir;

/** Downloads counted so far, by bucket - the rate limiter, kept in memory. */
const counted = new Map<string, number>();
let address = "203.0.113.7";

vi.mock("@polaris-app/game-servers/src/lib/minecraft/mod-token", () => ({
    modToken: () => "key",
    modTokenMatches: (token: string) => token === "key"
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        requestContext: { clientIp: async () => address },
        rateLimitService: {
            rateLimit: async (bucket: string, limit: number) => {
                const count = (counted.get(bucket) ?? 0) + 1;
                counted.set(bucket, count);
                return { ok: count <= limit, retryAfterMs: 0 };
            }
        }
    }
}));

beforeEach(() => {
    counted.clear();
    address = "203.0.113.7";
});

const route = await import(
    "@polaris-app/game-servers/src/routes/api/minecraft/mod/[token]/[file]/route"
);
const legacy = await import("@polaris-app/game-servers/src/routes/api/minecraft/mod/[file]/route");
const files = await import("@polaris-app/game-servers/src/lib/minecraft/polaris-mod-files");
const params = (file: string, token = "key") => ({ params: Promise.resolve({ token, file }) });
const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`https://polaris.example/api/minecraft/mod/key/${JAR}`, { method, headers });

describe("downloading the mod", () => {
    it("names it on HEAD, with no body and no date", async () => {
        const response = await route.HEAD(request("HEAD"), params(JAR));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toContain(JAR);
        expect(response.headers.get("content-length")).toBe("9");
        expect(response.headers.get("last-modified")).toBeNull();
        expect(response.body).toBeNull();
    });

    it("serves the jar on GET", async () => {
        const response = await route.GET(request("GET"), params(JAR));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("jar-bytes");
    });

    it("serves it again to a server that downloaded one later than this build", async () => {
        // The server's copy is dated when it was fetched, so a date says nothing
        // about which build it is.
        const response = await route.GET(
            request("GET", { "if-modified-since": new Date("2099-01-01T00:00:00Z").toUTCString() }),
            params(JAR)
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("last-modified")).toBeNull();
        expect(await response.text()).toBe("jar-bytes");
    });

    it("serves nothing that is not a build, by any name", async () => {
        for (const file of [
            "polaris-neoforge-1.21.1.jar",
            "../secrets.jar",
            "x.jar",
            `${JAR}.version`
        ]) {
            expect((await route.GET(request("GET"), params(file))).status, file).toBe(404);
            expect((await route.HEAD(request("HEAD"), params(file))).status, file).toBe(404);
        }
    });
});

describe("who may download it", () => {
    it("is nobody without the key, as if there were no such file", async () => {
        for (const token of ["", "nope", "KEY", "key/.."]) {
            expect((await route.GET(request("GET"), params(JAR, token))).status, token).toBe(404);
            expect((await route.HEAD(request("HEAD"), params(JAR, token))).status, token).toBe(404);
        }
    });

    it("stops one address that keeps downloading, and leaves the others", async () => {
        for (let download = 0; download < 30; download += 1) {
            expect((await route.GET(request("GET"), params(JAR))).status).toBe(200);
        }
        expect((await route.GET(request("GET"), params(JAR))).status).toBe(429);
        address = "198.51.100.4";
        expect((await route.GET(request("GET"), params(JAR))).status).toBe(200);
    });

    it("stops everybody together, however many addresses they come from", async () => {
        for (let download = 0; download < 60; download += 1) {
            address = `198.51.100.${download}`;
            expect((await route.GET(request("GET"), params(JAR))).status).toBe(200);
        }
        address = "192.0.2.1";
        expect((await route.GET(request("GET"), params(JAR))).status).toBe(429);
    });

    it("does not count a HEAD, which sends no file", async () => {
        for (let ask = 0; ask < 100; ask += 1) {
            expect((await route.HEAD(request("HEAD"), params(JAR))).status).toBe(200);
        }
        expect((await route.GET(request("GET"), params(JAR))).status).toBe(200);
    });

    it("lets only a handful through the old address with no key", async () => {
        const old = { params: Promise.resolve({ file: JAR }) };
        for (let download = 0; download < 4; download += 1) {
            expect((await legacy.GET(request("GET"), old)).status).toBe(200);
        }
        expect((await legacy.GET(request("GET"), old)).status).toBe(429);
    });
});

describe("the version a build reports", () => {
    it("is read from beside the jar", async () => {
        expect(await files.bundledModVersion(JAR)).toBe("0.1.0+abc123");
    });

    it("is unknown for a name that is not a build", async () => {
        expect(await files.bundledModVersion("x.jar")).toBeNull();
    });
});
