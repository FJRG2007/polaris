/**
 * The Windows install script as written: Expand-Archive draws a progress bar for
 * every file whatever the script's own preference says, which made the
 * one-press install take seconds longer than its download.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(join(__dirname, "..", "scripts", "install.ps1"), "utf8");

describe("install.ps1 as written", () => {
    it("draws no progress bars and unpacks without Expand-Archive", () => {
        expect(text).toContain('$ProgressPreference = "SilentlyContinue"');
        expect(text).not.toMatch(/^\s*Expand-Archive\b/m);
    });

    it("lists releases a short page at a time", () => {
        expect(text).not.toContain("per_page=100");
        expect(text).toContain("per_page=25&page=$page");
    });
});
