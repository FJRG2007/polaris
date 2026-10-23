/**
 * Writes every app logo in `src/shell/app-logo.tsx` to its own file,
 * `assets/app-logos/<id>.svg`, and removes the file of a logo that is gone.
 * `LOGOS` stays the one place a logo is drawn; these files are its output, for
 * the surfaces that cannot render the React component.
 *
 *   npm run logos -w @polaris/ui
 *
 * `test/app-logo-files.test.ts` fails when the committed files differ from
 * what this writes.
 */

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ui = join(dirname(fileURLToPath(import.meta.url)), "..");
const folder = join(ui, "assets", "app-logos");
// Beside the workspace's own dependencies, so the bundle resolves its React.
const out = join(ui, "..", "..", "node_modules", ".cache", "polaris-ui", "app-logo-file.mjs");

mkdirSync(dirname(out), { recursive: true });
await build({
    entryPoints: [join(ui, "src", "shell", "app-logo-file.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    jsx: "automatic",
    external: ["react", "react-dom"],
    logLevel: "error"
});
const { APP_LOGO_IDS, appLogoFileText } = await import(pathToFileURL(out).href);

mkdirSync(folder, { recursive: true });
const wanted = new Set();
let written = 0;
for (const id of APP_LOGO_IDS) {
    const name = `${id}.svg`;
    const path = join(folder, name);
    const text = appLogoFileText(id);
    wanted.add(name);
    let current = null;
    try {
        current = readFileSync(path, "utf8");
    } catch {}
    if (current !== text) {
        writeFileSync(path, text);
        written += 1;
    }
}
let removed = 0;
for (const name of readdirSync(folder)) {
    if (wanted.has(name)) continue;
    rmSync(join(folder, name));
    removed += 1;
}
console.log(`app logos: ${wanted.size} files, ${written} written, ${removed} removed`);
