/**
 * Cross-target parity in real browsers (docs/rust-core-plan.md, 4.4): the built
 * facade and WebAssembly binding replay every golden vector in headless
 * Chromium, WebKit and Firefox, and the page proves the module is not fetched
 * before a Rust-backed call (first paint never waits on it). A domain marked
 * `"wasm": false` in src/domains.json is not in the WebAssembly build (browsers
 * answer it with TypeScript, unchanged), so its vectors are not replayed here.
 *
 *   npm run build -w @polaris/core-rs && npm run build:rust -w @polaris/core-rs
 *   npm run test:browsers -w @polaris/core-rs [-- chromium webkit firefox]
 */

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const vectorsDir = join(packageDir, "..", "..", "..", "crates", "polaris-core-vectors");
// The facade's one runtime dependency, resolved for the page through an import map.
const nobleDir = dirname(createRequire(import.meta.url).resolve("@noble/hashes/sha2.js"));
const ENGINES = { chromium, webkit, firefox };
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };

for (const need of ["dist/index.js", "dist/probe.js", "dist/vectors.js", "wasm/polaris_core_wasm.js", "wasm/polaris_core_wasm_bg.wasm"])
    if (!existsSync(join(packageDir, need))) throw new Error(`${need} is missing: run npm run build and npm run build:rust first`);

const domains = JSON.parse(readFileSync(join(packageDir, "src", "domains.json"), "utf8"));
const vectorFiles = [];
for (const entry of readdirSync(vectorsDir, { withFileTypes: true }))
    if (entry.isDirectory() && domains[entry.name] && domains[entry.name].wasm !== false)
        for (const file of readdirSync(join(vectorsDir, entry.name))) if (file.endsWith(".json")) vectorFiles.push(`${entry.name}/${file}`);

const PAGE = `<!doctype html><meta charset="utf-8"><title>core-rs parity</title><p>parity</p>
<script type="importmap">{ "imports": { "@noble/hashes/": "/noble/" } }</script>
<script type="module">
import * as core from "/pkg/dist/index.js";
import * as probe from "/pkg/dist/probe.js";
import { replay } from "/pkg/dist/vectors.js";
const OPS = { "probe/fnv1a32": (t) => probe.fnv1a32(t), "probe/decodeHex": (h) => probe.decodeHex(h) };
window.runParity = async (files) => {
    const wasmRequestsBefore = performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".wasm")).length;
    const glue = new URL("/pkg/wasm/polaris_core_wasm.js", location.href).href;
    const wasm = new URL("/pkg/wasm/polaris_core_wasm_bg.wasm", location.href);
    let loads = 0;
    core.useWasm(() => { loads++; return core.loadWasmBinding(glue, wasm); });
    core.setRecorder(null);
    core.setMode("probe", "rust");
    const loadsBeforeCall = loads;
    const firstAnswer = probe.fnv1a32("first paint");
    const state = await core.ready();
    const out = { wasmRequestsBefore, loadsBeforeCall, firstAnswer, state, results: {} };
    for (const file of files) {
        const vectors = await (await fetch("/vectors/" + file)).json();
        out.results[file] = replay(vectors, OPS[vectors.domain + "/" + vectors.op]);
    }
    out.records = core.records();
    out.source = core.status().source;
    return out;
};
</script>`;

const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let root;
    let rel;
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    if (url.pathname.startsWith("/pkg/")) [root, rel] = [packageDir, url.pathname.slice(5)];
    else if (url.pathname.startsWith("/vectors/")) [root, rel] = [vectorsDir, url.pathname.slice(9)];
    else if (url.pathname.startsWith("/noble/")) [root, rel] = [nobleDir, url.pathname.slice(7)];
    else return res.writeHead(404).end();
    const path = normalize(join(root, rel));
    if (!path.startsWith(resolve(root) + sep)) return res.writeHead(403).end();
    try {
        const body = await readFile(path);
        res.writeHead(200, { "content-type": TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream" }).end(body);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ENGINES);
let failed = false;
try {
    for (const name of wanted) {
        const engine = ENGINES[name];
        if (!engine) throw new Error(`unknown browser ${name}`);
        const browser = await engine.launch({ headless: true, args: name === "chromium" ? ["--mute-audio"] : [] });
        try {
            const page = await browser.newPage();
            const errors = [];
            page.on("pageerror", (e) => errors.push(e.message));
            page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
            page.on("response", (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
            await page.goto(origin);
            await page.waitForFunction(() => typeof window.runParity === "function", null, { timeout: 15000 }).catch(() => {
                throw new Error(`${name}: the parity page never became ready: ${errors.join("; ") || "no error reported"}`);
            });
            const result = await page.evaluate((files) => window.runParity(files), vectorFiles);
            const mismatches = Object.entries(result.results).filter(([, m]) => m.length);
            const problems = [
                ...errors.map((e) => `page error: ${e}`),
                result.wasmRequestsBefore !== 0 && "the .wasm was fetched before any Rust-backed call",
                result.loadsBeforeCall !== 0 && "the module loaded before any Rust-backed call",
                result.firstAnswer !== 4261181865 && `the first call (before the module arrived) answered ${result.firstAnswer}`,
                result.state !== "ready" && `the module did not load: ${result.state}`,
                result.source !== "wasm" && `served by ${result.source}`,
                result.records.length && `records: ${JSON.stringify(result.records)}`,
                ...mismatches.map(([file, m]) => `${file}: ${m.length} mismatches, first ${JSON.stringify(m[0])}`)
            ].filter(Boolean);
            const cases = Object.keys(result.results).length;
            if (problems.length) {
                failed = true;
                process.stdout.write(`[browser-parity] ${name} (${browser.version()}): FAIL\n  ${problems.join("\n  ")}\n`);
            } else process.stdout.write(`[browser-parity] ${name} (${browser.version()}): ${cases} vector files, all match; module fetched lazily\n`);
        } finally {
            await browser.close();
        }
    }
} finally {
    server.close();
}
process.exit(failed ? 1 : 0);
