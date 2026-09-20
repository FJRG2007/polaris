/**
 * The segmentation model the call asks for is the one the build actually stages.
 *
 * Same drift, same consequence as `noise-assets`: the loader is fetched by URL
 * from `/video`, never through the bundler, so `scripts/copy-video-assets.mjs`
 * is the only thing putting it there and a rename in the package breaks the
 * feature with nothing failing anywhere near it.
 *
 * The staging script deliberately has no list of files to compare against - it
 * copies everything the package ships, because the loader decides in the browser
 * which wasm build it wants and appends its own names to ask for the rest. What
 * is left to assert is the other half: that the one name Polaris hard-codes is
 * a file the installed package still has, and that the script's short list of
 * things it skips has not grown to include it.
 *
 * Asserted against the script and the package rather than against `public/video`
 * itself: that directory only exists after a build, and a test that reads it
 * reports the absence of a build step as a defect in the product.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const SCRIPT = join(APP, "scripts", "copy-video-assets.mjs");
const FILTER = join(APP, "src", "app", "(app)", "chat", "camera-filter.ts");
const PACKAGE = join(APP, "..", "..", "node_modules", "@mediapipe", "selfie_segmentation");

/** Every `/video/...` file the filter names for itself. */
function asked(): string[] {
    const source = readFileSync(FILTER, "utf8");
    return [...source.matchAll(/\$\{ASSETS\}\/([\w.-]+)/g)].map((match) => match[1] ?? "");
}

/** The files the staging script leaves behind, read out of the script so there
 *  is not a second copy of the list to keep in step. */
function skipped(): string[] {
    const source = readFileSync(SCRIPT, "utf8");
    const list = /notForTheBrowser = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("the background model the call asks for", () => {
    it("is not one of the files the build leaves behind", () => {
        const wanted = asked();
        const left = skipped();

        // A guard on the guard: a regex that stopped matching would make this
        // whole file pass by asserting nothing.
        expect(wanted.length).toBeGreaterThan(0);
        expect(left.length).toBeGreaterThan(0);

        for (const file of wanted) expect(left).not.toContain(file);
    });

    it("comes from a file the installed package still has", () => {
        // Skipped on a checkout that has not installed - that is a machine
        // without dependencies, not a drift in the product.
        if (!existsSync(PACKAGE)) return;

        const wanted = asked();
        expect(wanted.length).toBeGreaterThan(0);
        for (const file of wanted) {
            expect(existsSync(join(PACKAGE, file))).toBe(true);
        }
    });
});
