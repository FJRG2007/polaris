/**
 * Build every workspace package, in parallel where the dependency graph allows it.
 *
 * This replaced a chain of eleven `npm run build -w ...` calls that ran one after
 * another because two of them could not have. Most of them can: only five packages
 * depend on another @polaris package at all, so the chain spent most of its time
 * waiting on builds that had nothing to do with each other. The order is derived
 * from each package's own manifest rather than written down here, so adding a
 * package needs no edit to this file - and cannot be put in the wrong place.
 *
 * The app is not built here (see `npm run build`), and a package with no build
 * script is skipped: @polaris/ui ships TypeScript source and is transpiled by Next.
 *
 *   npm run build:packages
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
// Package names reach a shell command line (see build below), so they are checked
// rather than trusted, even coming from manifests in this repository.
const WORKSPACE_NAME = /^@polaris\/[a-z0-9-]+$/;

function log(message) {
    process.stdout.write(`[build-packages] ${message}\n`);
}

/** Every buildable workspace package, with the @polaris packages it depends on. */
function readPackages() {
    const found = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(packagesDir, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (!manifest.scripts?.build) continue;
        if (!WORKSPACE_NAME.test(manifest.name))
            throw new Error(`unexpected package name: ${manifest.name}`);
        const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
        found.push({
            name: manifest.name,
            needs: Object.keys(dependencies).filter((d) => d.startsWith("@polaris/"))
        });
    }
    return found;
}

/**
 * Group the packages into waves: everything in a wave can build at the same time,
 * and every wave depends only on the ones before it.
 */
function planWaves(packages) {
    const remaining = new Map(packages.map((p) => [p.name, p]));
    const built = new Set();
    const waves = [];
    while (remaining.size > 0) {
        const wave = [...remaining.values()].filter((p) =>
            p.needs.every((need) => built.has(need) || !remaining.has(need))
        );
        // Only reachable through a dependency cycle between packages, which npm
        // installs happily and nothing else would report until a build hung.
        if (wave.length === 0)
            throw new Error(`circular dependency between ${[...remaining.keys()].join(", ")}`);
        for (const p of wave) remaining.delete(p.name);
        for (const p of wave) built.add(p.name);
        waves.push(wave.map((p) => p.name));
    }
    return waves;
}

/**
 * Build one package. Its output is buffered and printed when it ends rather than
 * streamed: several of these run at once, and interleaved compiler output is worse
 * than late output.
 *
 * Through a shell on every platform. Windows leaves no choice - node refuses to
 * spawn npm's .cmd shim directly (EINVAL) since it stopped treating batch files as
 * executables - and one code path that behaves the same everywhere beats two.
 */
function build(name) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(`npm run build -w ${name}`, {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"],
            shell: true,
            windowsHide: true
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", (error) =>
            resolve({ name, ok: false, output: String(error), seconds: 0 })
        );
        child.on("close", (code) =>
            resolve({
                name,
                ok: code === 0,
                output,
                seconds: ((Date.now() - started) / 1000).toFixed(1)
            })
        );
    });
}

const started = Date.now();
const waves = planWaves(readPackages());
let broke = false;

for (const [index, wave] of waves.entries()) {
    log(`wave ${index + 1}/${waves.length}: ${wave.join(", ")}`);
    const results = await Promise.all(wave.map(build));
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
        for (const failure of failed) {
            process.stderr.write(`\n[build-packages] ${failure.name} failed\n${failure.output}\n`);
        }
        // Not process.exit: stderr is a pipe under CI and under `npm run`, so those
        // writes are asynchronous and exiting discards whatever is still queued -
        // which is exactly the long compiler dump they were buffered to keep intact.
        process.exitCode = 1;
        broke = true;
        break;
    }
    log(results.map((r) => `${r.name} ${r.seconds}s`).join(", "));
}

if (!broke) log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
