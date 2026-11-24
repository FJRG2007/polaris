/**
 * The macOS update feed the release job writes: the format Squirrel.Mac reads
 * from a `json` server, naming the release's zip.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

const SCRIPT = join(__dirname, "../../build/mac-feed.cjs");
const { macFeed } = createRequire(import.meta.url)(SCRIPT) as {
    macFeed: (version: string, url: string, published: Date) => unknown;
};
const ZIP = "https://github.com/owner/repo/releases/download/desktop-v0.2.0/Polaris-darwin-arm64-0.2.0.zip";

describe("macFeed", () => {
    it("lists the release as the current one and the one to update to", () => {
        expect(macFeed("0.2.0", ZIP, new Date("2026-10-29T10:00:00Z"))).toEqual({
            currentRelease: "0.2.0",
            releases: [
                {
                    version: "0.2.0",
                    updateTo: { version: "0.2.0", name: "0.2.0", notes: "", pub_date: "2026-10-29T10:00:00.000Z", url: ZIP }
                }
            ]
        });
    });

    it("refuses a version or an address that would not work", () => {
        expect(() => macFeed("v0.2.0", ZIP, new Date())).toThrow();
        expect(() => macFeed("0.2.0", ZIP.replace("https:", "http:"), new Date())).toThrow();
        expect(() => macFeed("0.2.0", ZIP.replace(".zip", ".dmg"), new Date())).toThrow();
    });
});

describe("mac-feed.cjs", () => {
    const made: string[] = [];
    afterEach(() => {
        for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    it("writes the architecture's feed into the directory", () => {
        const directory = mkdtempSync(join(tmpdir(), "mac-feed-"));
        made.push(directory);
        execFileSync(process.execPath, [SCRIPT, "arm64", "0.2.0", ZIP, directory], { windowsHide: true });
        const feed = JSON.parse(readFileSync(join(directory, "RELEASES-darwin-arm64.json"), "utf8")) as { currentRelease: string; };
        expect(feed.currentRelease).toBe("0.2.0");
        expect(() => execFileSync(process.execPath, [SCRIPT, "ia32", "0.2.0", ZIP, directory], { windowsHide: true, stdio: "ignore" })).toThrow();
    });
});
