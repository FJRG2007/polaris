/**
 * Files an earlier release left as `http: {}`.
 *
 * Traefik refuses an empty section as "a standalone element", and one refused file
 * stops it applying anything in the directory - on 3.7 it loads none of it. The boot
 * pass rewrites those files to `NO_ROUTES_FILE`, and must leave every real one alone.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { NO_ROUTES_FILE } from "@polaris/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { refusedEmptyFile, repairEmptySections } from "@/lib/traefik-dynamic";

let dynamic = "";

beforeAll(async () => {
    dynamic = await mkdtemp(join(tmpdir(), "polaris-dynamic-"));
    process.env.POLARIS_TRAEFIK_DYNAMIC_DIR = dynamic;
});

afterAll(async () => {
    delete process.env.POLARIS_TRAEFIK_DYNAMIC_DIR;
    await rm(dynamic, { recursive: true, force: true });
});

describe("refusedEmptyFile", () => {
    it("matches only files made of empty sections", () => {
        expect(refusedEmptyFile("http: {}\n")).toBe(true);
        expect(refusedEmptyFile("# none\nhttp: {}\ntcp: { }\n")).toBe(true);
        expect(refusedEmptyFile(NO_ROUTES_FILE)).toBe(false);
        expect(refusedEmptyFile("")).toBe(false);
        expect(refusedEmptyFile("http:\n  routers:\n    a:\n      tls: {}\n")).toBe(false);
        expect(refusedEmptyFile("tls:\n  certificates: []\n")).toBe(false);
    });
});

describe("repairEmptySections", () => {
    it("rewrites the refused files and leaves the rest as they were", async () => {
        const routed =
            "http:\n  routers:\n    a:\n      rule: Host(`a.test`)\n      service: s\n      tls: {}\n";
        await writeFile(join(dynamic, "polaris-tailscale.yml"), "http: {}\n");
        await writeFile(join(dynamic, "polaris-app-status-pages.yaml"), "http: {}\n");
        await writeFile(join(dynamic, "polaris-apps.yml"), routed);
        await writeFile(join(dynamic, "polaris-local.crt"), "http: {}\n");

        expect((await repairEmptySections()).sort()).toEqual([
            "polaris-app-status-pages.yaml",
            "polaris-tailscale.yml"
        ]);
        expect(await readFile(join(dynamic, "polaris-tailscale.yml"), "utf8")).toBe(NO_ROUTES_FILE);
        expect(await readFile(join(dynamic, "polaris-app-status-pages.yaml"), "utf8")).toBe(
            NO_ROUTES_FILE
        );
        expect(await readFile(join(dynamic, "polaris-apps.yml"), "utf8")).toBe(routed);
        expect(await readFile(join(dynamic, "polaris-local.crt"), "utf8")).toBe("http: {}\n");
        expect(await repairEmptySections()).toEqual([]);
    });
});
