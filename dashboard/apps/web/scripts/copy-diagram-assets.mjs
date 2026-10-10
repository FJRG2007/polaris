/**
 * Stage the diagram editor's fonts under public/diagram-assets.
 *
 * The canvas draws text in its own faces - the hand-drawn one every diagram
 * starts with, a code face, a CJK face split into a couple of hundred files -
 * and asks for each one only when a drawing actually uses it. They are served
 * from this origin rather than any CDN: a diagram opened here must not reach
 * another server, and a face that fails to load is text measured in one font and
 * drawn in another.
 *
 * The package build emits them under `packages/diagrams/dist/editor/fonts`, and
 * the canvas asks for `<base>/editor/fonts/...` - the same relative layout, so
 * the whole tree is copied as it is. Copied at build time rather than committed,
 * like the pdf.js and office font assets: they must match the built package.
 */

import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** The path the browser asks for. The canvas defaults to the same one
 *  (`setAssetPath` in the package); a test holds the two to each other. */
export const base = "/diagram-assets";

export const target = join(here, "..", "public", base.replace(/^\//, ""));

/** The built package, resolved the way the app resolves it. */
export const packageRoot = dirname(
    createRequire(import.meta.url).resolve("@polaris/diagrams/package.json")
);

/**
 * Fill `into` with the built fonts, and throw when there are
 * none: staging nothing is not a visible failure anywhere downstream - the
 * canvas falls back to a system face and every diagram is laid out wrong.
 */
export function stageDiagramAssets(into = target) {
    const fonts = join(packageRoot, "dist", "editor", "fonts");
    if (!existsSync(fonts) || readdirSync(fonts).length === 0)
        throw new Error(`No built diagram fonts under ${fonts} - run the package build first`);
    rmSync(into, { recursive: true, force: true });
    mkdirSync(into, { recursive: true });
    cpSync(fonts, join(into, "editor", "fonts"), { recursive: true });
    return into;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(`Staged diagram fonts in ${stageDiagramAssets()}`);
}
