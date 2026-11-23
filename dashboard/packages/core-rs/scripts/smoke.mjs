/**
 * Prove a packaged binding loads and answers like TypeScript (src/smoke.ts).
 *
 *   node scripts/smoke.mjs --native [dir]          the `.node` for this platform in dir (default: native/)
 *   node scripts/smoke.mjs --wasm <dir>            a staged WebAssembly binding (dir/manifest.json, wasm-assets.mjs)
 *   node scripts/smoke.mjs --manifest <file>       an extension manifest lets WebAssembly compile
 *
 * With POLARIS_CORE_RS_REQUIRED=1 (CI) a binding that is not there fails;
 * otherwise it is reported and skipped, since the facades fall back to
 * TypeScript. A binding that is there and does not load always fails.
 */

import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindingRequired } from "./wasm-assets.mjs";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

function fail(message) {
    process.stderr.write(`[core-rs smoke] ${message}\n`);
    process.exit(1);
}

function checkManifest(file) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    // Manifest v3 refuses WebAssembly unless the page policy allows it; v2's
    // default policy allows it, so v2 only fails when it declares one without.
    const policy = manifest.manifest_version === 3 ? manifest.content_security_policy?.extension_pages : manifest.content_security_policy;
    if (manifest.manifest_version === 3 || policy !== undefined) {
        if (typeof policy !== "string" || !/script-src[^;]*'wasm-unsafe-eval'/.test(policy))
            fail(`${file}: the extension pages' policy does not allow WebAssembly ('wasm-unsafe-eval'): ${policy}`);
    }
    process.stdout.write(`[core-rs smoke] ${file}: manifest v${manifest.manifest_version} lets WebAssembly compile\n`);
}

async function main(argv) {
    const [mode, arg] = argv;
    if (mode === "--manifest" && arg) return checkManifest(resolve(arg));
    let target;
    let where;
    if (mode === "--native") {
        where = arg ? resolve(arg) : "native/";
        target = { kind: "napi", directory: arg ? resolve(arg) : undefined };
    } else if (mode === "--wasm" && arg) {
        where = resolve(arg);
        const manifestFile = join(where, "manifest.json");
        if (!existsSync(manifestFile)) {
            if (bindingRequired()) fail(`no WebAssembly binding staged in ${where}`);
            process.stdout.write(`[core-rs smoke] no WebAssembly binding staged in ${where}; skipped (TypeScript answers)\n`);
            return;
        }
        const { glue, wasm } = JSON.parse(readFileSync(manifestFile, "utf8"));
        target = { kind: "wasm", glueUrl: pathToFileURL(join(where, glue)).href, wasm: readFileSync(join(where, wasm)) };
    } else fail("usage: smoke.mjs --native [dir] | --wasm <dir> | --manifest <file>");
    if (!existsSync(join(dist, "smoke.js"))) fail(`${dist}smoke.js is missing: build @polaris/core-rs first`);
    const { smoke } = await import(pathToFileURL(join(dist, "smoke.js")).href);
    const report = await smoke(target);
    if (report.binding === "missing" && !bindingRequired()) {
        process.stdout.write(`[core-rs smoke] no ${target.kind} binding for ${process.platform}-${process.arch} in ${where}; skipped (TypeScript answers)\n`);
        return;
    }
    if (report.problems.length) fail(`${where}:\n  ${report.problems.join("\n  ")}`);
    process.stdout.write(`[core-rs smoke] ${where}: ${report.source} binding loaded on ${process.platform}-${process.arch}, ${report.checked} inputs answered by Rust exactly as TypeScript\n`);
}

main(process.argv.slice(2)).catch((error) => fail(error?.stack ?? String(error)));
