/**
 * Stage the Bergamot translation runtime under public/bergamot so Translate's
 * local engine starts its worker same-origin: the worker script, the Emscripten
 * glue it imports and the wasm it loads beside itself. The files must match the
 * installed @browsermt/bergamot-translator exactly, so they are copied at build
 * time instead of being committed. Runs from the web app's predev/prebuild hooks.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("@browsermt/bergamot-translator/package.json"));
const target = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "bergamot");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of [
    "translator-worker.js",
    "bergamot-translator-worker.js",
    "bergamot-translator-worker.wasm"
]) {
    cpSync(join(root, "worker", file), join(target, file));
}

console.log(`Copied the Bergamot runtime to ${target}`);
