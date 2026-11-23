/**
 * Prove the packaged app carries a Rust core binding that loads in Electron
 * (docs/rust-core-plan.md, F6). Finds every `app.asar.unpacked/dist/native`
 * under out/ (electron-forge's packages), bundles the facade's check
 * (dashboard/packages/core-rs/src/smoke.ts) with the main process's own build
 * options, and runs it in this project's Electron as Node: the binding must
 * load and answer exactly as TypeScript on every input.
 *
 *   node build/core-rs-smoke.mjs [out] [--arch x64|arm64]
 *
 * `--arch` is the packaged app's architecture. A package for another
 * architecture than this machine's (macOS x64, made on an arm64 runner) cannot
 * be loaded here, so for it only the file is checked, and the output says so.
 *
 * With POLARIS_CORE_RS_REQUIRED=1 (desktop.yml) a package without the binding
 * fails; otherwise it is reported and passes, since the facades fall back to
 * TypeScript.
 */

import { build } from "esbuild";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { mainNode } from "./node-build.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = process.env.POLARIS_CORE_RS_REQUIRED === "1";
const smokeSource = join(ROOT, "..", "dashboard", "packages", "core-rs", "src", "smoke.ts");

function fail(message) {
    process.stderr.write(`[core-rs smoke] ${message}\n`);
    process.exit(1);
}

/** Every packaged app's unpacked native folder under `dir`. */
function nativeDirs(dir, found = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (entry.name === "app.asar.unpacked") {
            if (existsSync(join(path, "dist", "native"))) found.push(join(path, "dist", "native"));
        } else if (!entry.name.endsWith(".asar")) nativeDirs(path, found);
    }
    return found;
}

const args = process.argv.slice(2);
const archAt = args.indexOf("--arch");
const arch = archAt === -1 ? process.arch : args[archAt + 1];
if (archAt !== -1) args.splice(archAt, 2);
const out = resolve(args[0] ?? join(ROOT, "out"));
// The name dashboard/packages/core-rs/src/native.ts looks for; Electron is glibc on Linux.
const expected =
    process.platform === "win32" ? `polaris-core.win32-${arch}-msvc.node` : process.platform === "linux" ? `polaris-core.linux-${arch}-gnu.node` : `polaris-core.${process.platform}-${arch}.node`;
if (!existsSync(out)) fail(`${out} does not exist: package the app first (electron-forge package or make)`);
const dirs = nativeDirs(out);
if (!dirs.length) {
    if (required) fail(`no packaged app under ${out} carries the Rust core binding (app.asar.unpacked/dist/native)`);
    process.stdout.write(`[core-rs smoke] no packaged app under ${out} carries the Rust core binding; skipped (TypeScript answers)\n`);
    process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "polaris-core-rs-smoke-"));
try {
    const entry = join(scratch, "smoke.cjs");
    await build({
        ...mainNode,
        logLevel: "warning",
        stdin: {
            contents: `import { smoke } from ${JSON.stringify(smokeSource.replaceAll("\\", "/"))};
smoke({ kind: "napi", directory: process.argv[2] }).then((report) => {
    process.stdout.write(JSON.stringify(report) + "\\n");
}, (error) => { process.stderr.write(String(error && error.stack || error) + "\\n"); process.exit(1); });`,
            resolveDir: ROOT,
            loader: "ts"
        },
        outfile: entry
    });
    const electron = createRequire(import.meta.url)("electron");
    let failed = false;
    for (const dir of dirs) {
        if (arch !== process.arch) {
            if (!existsSync(join(dir, expected))) {
                process.stderr.write(`[core-rs smoke] ${dir}: ${expected} is missing\n`);
                failed = true;
            } else process.stdout.write(`[core-rs smoke] ${dir}: ${expected} is packaged; not loaded, this machine is ${process.arch}\n`);
            continue;
        }
        const run = spawnSync(electron, [entry, dir], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" });
        const line = (run.stdout ?? "").trim().split("\n").pop() ?? "";
        let report;
        try {
            report = JSON.parse(line);
        } catch {
            process.stderr.write(`[core-rs smoke] ${dir}: Electron exited with ${run.status}\n${run.stderr ?? ""}${run.stdout ?? ""}\n`);
            failed = true;
            continue;
        }
        if (report.binding === "missing" && !required) {
            process.stdout.write(`[core-rs smoke] ${dir}: no binding for ${process.platform}-${process.arch}; skipped (TypeScript answers)\n`);
            continue;
        }
        if (report.problems.length) {
            process.stderr.write(`[core-rs smoke] ${dir}:\n  ${report.problems.join("\n  ")}\n`);
            failed = true;
            continue;
        }
        process.stdout.write(`[core-rs smoke] ${dir}: loaded in Electron, ${report.checked} inputs answered by Rust exactly as TypeScript\n`);
    }
    if (failed) process.exit(1);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
