/**
 * Time the TypeScript twin and the Node binding over every golden vector file
 * (src/bench.ts) and print median and p95 per op. Reports only: it never fails
 * on a number, only when it cannot run.
 *
 *   npm run bench -w @polaris/core-rs [-- --budget <ms>]     (build the package and `build:rust --only node` first)
 *
 * With POLARIS_CORE_RS_REQUIRED=1 (CI) a missing Node binding fails; otherwise
 * only the TypeScript side is timed.
 */

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindingRequired } from "./wasm-assets.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const vectorsDir = join(packageDir, "..", "..", "..", "crates", "polaris-core-vectors");
const dist = join(packageDir, "dist", "bench.js");

function fail(message) {
    process.stderr.write(`[core-rs bench] ${message}\n`);
    process.exit(1);
}

function vectorFiles() {
    const files = [];
    for (const entry of readdirSync(vectorsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "src" || entry.name === "tests") continue;
        for (const name of readdirSync(join(vectorsDir, entry.name)).sort())
            if (name.endsWith(".json")) files.push(JSON.parse(readFileSync(join(vectorsDir, entry.name, name), "utf8")));
    }
    return files;
}

async function main(argv) {
    const at = argv.indexOf("--budget");
    const budget = at >= 0 ? Number(argv[at + 1]) : 1000;
    if (!Number.isFinite(budget) || budget <= 0) fail("--budget takes a positive number of milliseconds");
    if (!existsSync(dist)) fail(`${dist} is missing: build @polaris/core-rs first`);
    const { bench, loadNative } = await import(pathToFileURL(dist).href);
    const { binding, reason } = loadNative();
    if (!binding) {
        if (bindingRequired()) fail(`no Node binding: ${reason}`);
        process.stdout.write(`[core-rs bench] no Node binding (${reason}); timing TypeScript only\n`);
    }
    const results = bench(vectorFiles(), binding, budget);
    const us = (n) => `${n.toFixed(2)} us`.padStart(12);
    process.stdout.write(`[core-rs bench] node ${process.version} ${process.platform}-${process.arch}, one sample = one pass over the op's vector file\n`);
    process.stdout.write(`${"op".padEnd(18)}${"impl".padEnd(6)}${"median".padStart(12)}${"p95".padStart(12)}${"samples".padStart(9)}  vs ts (median)\n`);
    for (const r of results) {
        const ts = results.find((o) => o.op === r.op && o.impl === "ts");
        const ratio = r.impl === "ts" ? "" : `${(ts.median / r.median).toFixed(2)}x ${r.median < ts.median ? "faster" : "slower"}`;
        process.stdout.write(`${r.op.padEnd(18)}${r.impl.padEnd(6)}${us(r.median)}${us(r.p95)}${String(r.samples).padStart(9)}  ${ratio}\n`);
    }
}

main(process.argv.slice(2)).catch((error) => fail(error?.stack ?? String(error)));
