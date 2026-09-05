/**
 * The noise models Polaris serves are the ones the package ships.
 *
 * The suppressor's weights and its worklet are not imported - they are fetched
 * at runtime from `/audio`, because a worklet is loaded by URL and a wasm binary
 * is fetched, and neither goes through the bundler. So they are copied into
 * `public/audio` by hand, which means the copy can go stale the moment the
 * package is upgraded and nothing anywhere will say so.
 *
 * What that failure looks like is the reason this file exists. A worklet from
 * one version over weights from another does not warn: the model fails to
 * instantiate, the filter falls back, and a call goes out unfiltered - or, until
 * recently, silent. It is the same shape as every other drift in this codebase:
 * two copies of one thing, one of them updated.
 *
 * Compared by content rather than by version number, because the version is not
 * what is served.
 */

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/** This file's own directory, so the test does not depend on where it was run
 *  from - `vitest --root` and the workspace script disagree about that, and a
 *  relative path made the answer depend on which one somebody used. */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const SERVED = join(APP, "public", "audio");
const PACKAGE = join(APP, "..", "..", "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");

/** Every file served from `/audio` that the package is the source of, and where
 *  it comes from inside it. The mp3 encoder is not here: it is a different
 *  package and has its own copy. */
const STAGED: readonly { served: string; from: string }[] = [
    { served: "gtcrn.wasm", from: "gtcrn.wasm" },
    { served: "gtcrn-worklet.js", from: join("gtcrn", "workletProcessor.js") },
    { served: "rnnoise.wasm", from: "rnnoise.wasm" },
    { served: "rnnoise_simd.wasm", from: "rnnoise_simd.wasm" },
    { served: "rnnoise-worklet.js", from: join("rnnoise", "workletProcessor.js") }
];

function digest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("the noise models served from /audio", () => {
    for (const { served, from } of STAGED) {
        it(`${served} is the copy the package ships`, () => {
            const servedPath = join(SERVED, served);
            const packagePath = join(PACKAGE, from);
            // A missing dependency is a machine that has not installed, not a
            // drift - and failing on it here would be this test reporting
            // somebody's setup as a defect in the product.
            if (!existsSync(packagePath)) return;

            expect(existsSync(servedPath)).toBe(true);
            expect(digest(servedPath)).toBe(digest(packagePath));
        });
    }
});
