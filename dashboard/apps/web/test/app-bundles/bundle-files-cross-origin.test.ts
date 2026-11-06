/**
 * A game's page runs in a sandboxed frame, whose origin is opaque: its module,
 * its data and its fonts are then cross-origin reads, and without a header
 * that allows them the game never starts. Every bundle file is public and read
 * without credentials, so any origin may read it.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "bundle-files-"));
mkdirSync(join(dir, "assets", "new-york"), { recursive: true });
writeFileSync(join(dir, "assets", "new-york", "index.html"), "<!doctype html>");
writeFileSync(join(dir, "assets", "new-york", "game-0123456789abcdef.js"), "export {};");

vi.mock("@/lib/app-bundles/loader", () => ({
    loadedBundle: () => ({ version: "v1", dir, previous: null })
}));

const { GET } = await import("@/app/api/app-bundles/[app]/[version]/[...file]/route");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fetchFile = (...file: string[]) =>
    GET({} as never, {
        params: Promise.resolve({ app: "arcade", version: "v1", file: ["assets", ...file] })
    });

describe("a bundle's files, read from a sandboxed page", () => {
    it("lets any origin read the game's module", async () => {
        const response = await fetchFile("new-york", "game-0123456789abcdef.js");
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("keeps the page itself to files from here", async () => {
        const response = await fetchFile("new-york", "index.html");
        expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });
});
