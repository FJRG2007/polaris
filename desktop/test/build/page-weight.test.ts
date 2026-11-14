/**
 * What the app puts in front of a page stays light.
 *
 * The dashboard's preload runs before every load of the dashboard, and the
 * app's own windows' preload and small pages before each of theirs; the full
 * build of zod alone was ~970 KB of each, parsed every time. These bundle each
 * entry the way `build/bundle.mjs` does and pin a ceiling far below that, so a
 * module that pulls the full zod back in fails here rather than on somebody's
 * screen. And no page waits on the main process: nothing calls `sendSync`.
 */

import { build } from "esbuild";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

async function bundledSize(entry: string, platform: "node" | "browser"): Promise<number> {
    const result = await build({
        entryPoints: [join(ROOT, entry)],
        bundle: true,
        platform,
        format: platform === "node" ? "cjs" : "iife",
        external: ["electron"],
        minify: platform === "browser",
        write: false,
        logLevel: "silent",
        alias: { "@": join(ROOT, "src") }
    });
    return result.outputFiles.reduce((total, file) => total + file.contents.byteLength, 0);
}

const CEILING = 150 * 1024;

describe("what loads before a page", () => {
    it.each([
        ["src/preload/app.ts", "node"],
        ["src/preload/local.ts", "node"],
        ["src/renderer/overlay.ts", "browser"],
        ["src/renderer/voice-widget.ts", "browser"]
    ] as const)("%s stays under the ceiling", async (entry, platform) => {
        expect(await bundledSize(entry, platform)).toBeLessThan(CEILING);
    });
});

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.ts$/.test(entry.name) ? [path] : [];
    });
}

describe("no page waits on the main process", () => {
    it("never calls sendSync", () => {
        const offenders = sources(join(ROOT, "src")).filter((file) => /\bsendSync\s*\(/.test(readFileSync(file, "utf8")));
        expect(offenders).toEqual([]);
    });
});
