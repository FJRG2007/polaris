/**
 * The installer the Windows updater falls back on when Squirrel fails: only the
 * release's own `Polaris-Setup.exe`, only once it matches `SHA256SUMS`, and
 * Squirrel tried again on a widening wait.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { downloadSetup, retryDelay, setupAsset, SETUP_EXE } from "@/main/setup-install";

const SETUP = Buffer.alloc(50_000, 3);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const FOLDER = "https://github.com/owner/repo/releases/download/desktop-v0.2.0";
const serve = (bytes: Buffer) => async () => new Response(new Blob([new Uint8Array(bytes)]).stream());

describe("setupAsset", () => {
    it("takes the release's installer and nothing named like it", () => {
        expect(setupAsset([{ name: "Polaris-Setup.exe.blockmap", size: 9 }, { name: SETUP_EXE, size: 10 }])).toEqual({ name: SETUP_EXE, size: 10 });
        expect(setupAsset([{ name: SETUP_EXE, size: 0 }])).toBeNull();
        expect(setupAsset([])).toBeNull();
    });
});

describe("retryDelay", () => {
    it("starts at half an hour, doubles and stops at a day", () => {
        expect(retryDelay(1)).toBe(30 * 60_000);
        expect(retryDelay(2)).toBe(60 * 60_000);
        expect(retryDelay(4)).toBe(4 * 60 * 60_000);
        expect(retryDelay(50)).toBe(24 * 60 * 60_000);
    });
});

describe("downloadSetup", () => {
    const made: string[] = [];
    afterEach(() => {
        for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
    });
    const temp = () => {
        const directory = mkdtempSync(join(tmpdir(), "setup-"));
        made.push(directory);
        return directory;
    };
    const assets = [{ name: SETUP_EXE, size: SETUP.length }];

    it("hands back the installer once it matches the release's checksum", async () => {
        const sums = `${digest(SETUP)}  ${SETUP_EXE}\n`;
        const path = await downloadSetup({ folder: FOLDER, assets, temp: temp(), fetchText: async () => sums, fetch: serve(SETUP) });
        expect(readFileSync(path).equals(SETUP)).toBe(true);
        expect(path.endsWith(SETUP_EXE)).toBe(true);
    });

    it("refuses one that does not match and leaves nothing behind", async () => {
        const directory = temp();
        const sums = `${"0".repeat(64)}  ${SETUP_EXE}\n`;
        await expect(downloadSetup({ folder: FOLDER, assets, temp: directory, fetchText: async () => sums, fetch: serve(SETUP) })).rejects.toThrow(
            /checksum/
        );
        expect(readdirSync(directory)).toEqual([]);
    });

    it("refuses when the checksums do not list it", async () => {
        await expect(downloadSetup({ folder: FOLDER, assets, temp: temp(), fetchText: async () => "", fetch: serve(SETUP) })).rejects.toThrow(
            /does not list/
        );
    });
});
