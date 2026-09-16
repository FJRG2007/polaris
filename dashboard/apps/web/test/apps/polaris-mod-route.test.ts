/**
 * How a Minecraft server's image downloads the login mod.
 *
 * The image asks HEAD, then GET, on every boot, and anything but a success ends
 * that boot. It also keeps a jar it already has whenever it is told a date older
 * than its own copy - and its copy is dated when it was downloaded. So the answers
 * pinned here are the jar, never a date or a 304 that would let a server keep an
 * older build, and a 404 for anything that is not one of the builds.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";

const dir = mkdtempSync(join(tmpdir(), "polaris-mods-"));
const JAR = "polaris-neoforge-1.21.4.jar";
writeFileSync(join(dir, JAR), "jar-bytes");
writeFileSync(join(dir, `${JAR}.version`), "0.1.0+abc123\n");
process.env.POLARIS_MINECRAFT_MODS_DIR = dir;

const route = await import("../../src/app/api/minecraft/mod/[file]/route");
const files = await import("../../src/lib/apps/minecraft/polaris-mod-files");
const params = (file: string) => ({ params: Promise.resolve({ file }) });
const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`https://polaris.example/api/minecraft/mod/${JAR}`, { method, headers });

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

describe("the version a build reports", () => {
    it("is read from beside the jar", async () => {
        expect(await files.bundledModVersion(JAR)).toBe("0.1.0+abc123");
    });

    it("is unknown for a name that is not a build", async () => {
        expect(await files.bundledModVersion("x.jar")).toBeNull();
    });
});
