/**
 * The noise models the call asks for are the ones the build actually stages.
 *
 * The suppressor's weights and its worklet are not imported - they are fetched
 * at runtime from `/audio`, because a worklet is loaded by URL and a wasm binary
 * is fetched, and neither goes through the bundler. So they are copied out of
 * the installed package by `scripts/copy-audio-assets.mjs` on prebuild, which
 * means there are two lists of the same files in two languages, and nothing
 * connecting them.
 *
 * What that drift looks like is the reason this file exists. Rename a file in
 * the package and the copy silently stops happening; change a URL in the filter
 * and it asks for something nobody staged. Either way the model fails to
 * instantiate, the filter falls back, and a call goes out unfiltered - or, until
 * recently, silent, with nothing anywhere saying why.
 *
 * Asserted against the script and the package rather than against `public/audio`
 * itself, deliberately: that directory only exists after a build, and a test
 * that reads it passes on a developer's machine and fails in a checkout that has
 * only installed - which is a test reporting the absence of a build step as a
 * defect in the product.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/** This file's own directory, so nothing here depends on where it was run from -
 *  `vitest --root` and the workspace script disagree about that. */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const SCRIPT = join(APP, "scripts", "copy-audio-assets.mjs");
const FILTER = join(APP, "src", "app", "(app)", "chat", "mic-filter.ts");
const PACKAGE = join(APP, "..", "..", "node_modules", "@sapphi-red", "web-noise-suppressor");

/** The `["from", "to"]` pairs the staging script copies, read out of the script
 *  rather than repeated here - a third copy of the list would be a third thing
 *  to keep in step. */
function staged(): { from: string; to: string }[] {
    const source = readFileSync(SCRIPT, "utf8");
    return [...source.matchAll(/\["(dist\/[^"]+)",\s*"([^"]+)"\]/g)].map((match) => ({
        from: match[1] ?? "",
        to: match[2] ?? ""
    }));
}

/** Every `/audio/...` file the filter fetches or loads as a worklet. */
function asked(): string[] {
    const source = readFileSync(FILTER, "utf8");
    return [...source.matchAll(/\$\{ASSETS\}\/([\w.-]+)/g)].map((match) => match[1] ?? "");
}

describe("the noise models the call asks for", () => {
    it("are all staged by the build", () => {
        const produced = new Set(staged().map((entry) => entry.to));
        const wanted = asked();

        // A guard on the guard: a regex that stopped matching would make this
        // whole file pass by asserting nothing.
        expect(wanted.length).toBeGreaterThan(0);
        expect(produced.size).toBeGreaterThan(0);

        for (const file of wanted) expect(produced).toContain(file);
    });

    it("come from files the installed package still has", () => {
        // Skipped on a checkout that has not installed - that is a machine
        // without dependencies, not a drift in the product.
        if (!existsSync(PACKAGE)) return;

        const pairs = staged();
        expect(pairs.length).toBeGreaterThan(0);
        for (const { from } of pairs) {
            expect(existsSync(join(PACKAGE, from))).toBe(true);
        }
    });
});
