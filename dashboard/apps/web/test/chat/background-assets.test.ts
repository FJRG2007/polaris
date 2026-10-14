/**
 * The files a camera background asks for are the files the build stages.
 *
 * Same drift, same consequence as `noise-assets`: the runtime and the model are
 * fetched by URL from `/video`, never through the bundler, so
 * `scripts/copy-video-assets.mjs` is the only thing putting them there, and a
 * rename in the package breaks the feature with nothing failing anywhere near it.
 *
 * The runtime is copied out of the installed package, minus a short list of
 * builds the filter never asks for; the model is committed under
 * `assets/video`. What is asserted is that every name the filter can ask for
 * is one of those, and that the skip list has not grown to include it.
 *
 * Asserted against the script, the package and the committed model rather than
 * against `public/video` itself: that directory only exists after a build.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { MODEL_FILE, VIDEO_ASSETS } from "@/app/(app)/chat/camera-mask";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");
const SCRIPT = join(APP, "scripts", "copy-video-assets.mjs");
const RUNTIME = join(APP, "..", "..", "node_modules", "@mediapipe", "tasks-vision", "wasm");
const MODELS = join(APP, "assets", "video");
const SCENES = join(APP, "src", "app", "(app)", "chat", "camera-background.ts");
const PUBLIC = join(APP, "public", "backgrounds");

/** The files the staging script leaves behind, read out of the script so there
 *  is not a second copy of the list to keep in step. */
function skipped(): string[] {
    const source = readFileSync(SCRIPT, "utf8");
    const list = /notForTheBrowser = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? "";
    return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** The ids of the pictures Polaris ships, read out of the module that lists
 *  them rather than repeated here. */
function scenes(): string[] {
    const source = readFileSync(SCENES, "utf8");
    const list = source.slice(source.indexOf("BACKGROUND_SCENES"));
    return [...list.matchAll(/id: "([\w-]+)", label:/g)].map((match) => match[1] ?? "");
}

describe("the pictures the picker offers", () => {
    it("are files that exist, at both sizes", () => {
        const ids = scenes();
        // A guard on the guard: a regex that stopped matching would make this
        // pass by asserting nothing.
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
            // Committed rather than staged, unlike the model: they are ours and
            // there is no package to copy them out of. A menu drawing nine
            // broken images is what a rename here costs.
            expect(existsSync(join(PUBLIC, `${id}.webp`))).toBe(true);
            expect(existsSync(join(PUBLIC, `${id}-thumb.webp`))).toBe(true);
        }
    });

    it("say where they came from", () => {
        // Somebody else's photographs, served from this origin. The terms and
        // the names travel with the files.
        expect(existsSync(join(PUBLIC, "NOTICE.txt"))).toBe(true);
    });
});

describe("the background runtime and model the call asks for", () => {
    const runtime = VIDEO_ASSETS.filter((file) => file !== MODEL_FILE);

    it("is not one of the files the build leaves behind", () => {
        const left = skipped();
        // A guard on the guard: a regex that stopped matching would make this
        // whole file pass by asserting nothing.
        expect(runtime.length).toBeGreaterThan(0);
        expect(left.length).toBeGreaterThan(0);
        for (const file of VIDEO_ASSETS) expect(left).not.toContain(file);
    });

    it("has its model committed where the build copies it from", () => {
        expect(existsSync(join(MODELS, MODEL_FILE))).toBe(true);
        // A TFLite flatbuffer, not a pointer file or an HTML error page.
        expect(readFileSync(join(MODELS, MODEL_FILE)).subarray(4, 8).toString("latin1")).toBe("TFL3");
    });

    it("comes from files the installed package still has", () => {
        // Skipped on a checkout that has not installed - that is a machine
        // without dependencies, not a drift in the product.
        if (!existsSync(RUNTIME)) return;
        for (const file of runtime) expect(existsSync(join(RUNTIME, file))).toBe(true);
    });
});
