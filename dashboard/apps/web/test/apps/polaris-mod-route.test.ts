/**
 * How a Minecraft server's image downloads the login mod.
 *
 * The image asks HEAD for the name and date, then GET with `If-Modified-Since`,
 * on every boot, and anything but a success ends that boot. So the three answers
 * pinned here are the ones a server's start depends on: the jar with its date, a
 * 304 once it has it, and a 404 for anything that is not one of the builds.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-mods-"));
const JAR = "polaris-neoforge-1.21.4.jar";
const WHEN = new Date("2026-09-01T10:00:00Z");
writeFileSync(join(dir, JAR), "jar-bytes");
utimesSync(join(dir, JAR), WHEN, WHEN);
process.env.POLARIS_MINECRAFT_MODS_DIR = dir;

const route = await import("../../src/app/api/minecraft/mod/[file]/route");
const params = (file: string) => ({ params: Promise.resolve({ file }) });
const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`https://polaris.example/api/minecraft/mod/${JAR}`, { method, headers });

describe("downloading the mod", () => {
    it("names and dates it on HEAD, with no body", async () => {
        const response = await route.HEAD(request("HEAD"), params(JAR));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-disposition")).toContain(JAR);
        expect(response.headers.get("last-modified")).toBe(WHEN.toUTCString());
        expect(response.headers.get("content-length")).toBe("9");
        expect(response.body).toBeNull();
    });

    it("serves the jar on GET", async () => {
        const response = await route.GET(request("GET"), params(JAR));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("jar-bytes");
    });

    it("answers 304 to a server that already has this build", async () => {
        const same = await route.GET(
            request("GET", { "if-modified-since": WHEN.toUTCString() }),
            params(JAR)
        );
        expect(same.status).toBe(304);
        const older = await route.GET(
            request("GET", { "if-modified-since": new Date("2026-08-01T00:00:00Z").toUTCString() }),
            params(JAR)
        );
        expect(older.status).toBe(200);
    });

    it("serves nothing that is not a build, by any name", async () => {
        for (const file of ["polaris-neoforge-1.21.1.jar", "../secrets.jar", "x.jar"]) {
            expect((await route.GET(request("GET"), params(file))).status, file).toBe(404);
            expect((await route.HEAD(request("HEAD"), params(file))).status, file).toBe(404);
        }
    });
});
