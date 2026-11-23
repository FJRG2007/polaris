/**
 * Build and run the links harness (`main.ts`, `page.ts`) in a real Electron:
 * hidden window, audio muted, no browser started (see `main.ts`). Exits with
 * Electron's code, so a failed case fails the command.
 *
 * Needs a display: run it on a desktop, or under xvfb-run on Linux.
 */

import { build } from "esbuild";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { mainNode } from "../../../build/node-build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, "../../..");
const WEB = join(DESKTOP, "../dashboard/apps/web/src");
const out = mkdtempSync(join(tmpdir(), "polaris-links-harness-"));

try {
    await build({ ...mainNode, entryPoints: [join(HERE, "main.ts")], outfile: join(out, "main.js"), logLevel: "warning", alias: { ...mainNode.alias, "@": join(DESKTOP, "src") } });
    await build({ bundle: true, platform: "browser", format: "iife", entryPoints: [join(HERE, "page.ts")], outfile: join(out, "page.js"), logLevel: "warning", alias: { "@": WEB } });
    const electron = createRequire(import.meta.url)("electron");
    const code = await new Promise((resolve) => {
        const child = spawn(electron, [join(out, "main.js"), "--mute-audio"], { stdio: "inherit", windowsHide: true });
        child.on("exit", (exit) => resolve(exit ?? 1));
        child.on("error", () => resolve(1));
    });
    process.exitCode = Number(code);
} finally {
    rmSync(out, { recursive: true, force: true });
}
