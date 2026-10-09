/**
 * Bundle the README scenes: the dashboard's REAL client components, rendered in a
 * plain page with fixture data instead of a server.
 *
 * Nothing here draws a screen of its own. Each scene imports the component the
 * app ships and hands it the props a server page would have, and the parts that
 * only exist on a server are replaced at bundle time - see `bundle.mjs`.
 *
 * The stylesheet is the app's own Tailwind build (same config, same globals), so
 * the pictures change when the interface does, with no copy to keep in step.
 *
 *   node scripts/readme-media/build.mjs     (from dashboard/)
 */

import { bundle } from "./bundle.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const web = join(root, "apps", "web");
const out = join(here, "out", "site");
const require = createRequire(join(root, "package.json"));

function log(message) {
    process.stdout.write(`[readme-media] ${message}\n`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

log("bundling scenes");
const result = await bundle(join(here, "runtime", "harness.tsx"), join(out, "harness.js"));
writeFileSync(join(here, "out", "meta.json"), JSON.stringify(result.metafile));

log("building the stylesheet with the app's own Tailwind config");
// Next resolves the package import in globals.css itself; the Tailwind CLI's
// import step does not look in workspaces, so it is handed the file directly.
const globals = readFileSync(join(web, "src", "app", "globals.css"), "utf8").replace(
    '@import "@polaris/ui/styles.css";',
    `@import ${JSON.stringify(join(root, "packages", "ui", "src", "styles", "tokens.css").replace(/\\/g, "/"))};`
);
const input = join(here, "out", "globals.css");
writeFileSync(input, globals);
const tailwind = spawnSync(
    process.execPath,
    [
        require.resolve("tailwindcss/lib/cli.js"),
        "-c",
        join(web, "tailwind.config.ts"),
        "-i",
        input,
        "-o",
        join(out, "styles.css")
    ],
    { cwd: web, stdio: "inherit" }
);
if (tailwind.status !== 0) throw new Error("Tailwind failed");

for (const dir of ["fonts"]) cpSync(join(web, "src", dir), join(out, dir), { recursive: true });
cpSync(join(web, "public"), join(out, "public"), { recursive: true });
cpSync(join(here, "runtime", "index.html"), join(out, "index.html"));
log(`done: ${out}`);
