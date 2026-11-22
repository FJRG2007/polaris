/**
 * The no-simulation guard (docs/rust-core-plan.md, 2 and 4.6). Fails on the
 * markers of unfinished or faked work in crates/polaris-core* and in this
 * package: todo!, unimplemented!, #[ignore], dbg!, a "not implemented" string,
 * skipped or focused tests, and console printing from Rust library code.
 *
 *   npm run check:guard -w @polaris/core-rs        (plain Node, no install needed)
 */

import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(packageDir, "..", "..", "..");
// The guard itself and its test spell out the markers they look for.
const EXEMPT = new Set([fileURLToPath(import.meta.url), join(packageDir, "test", "unit", "checks.test.ts")]);

/** Banned everywhere in scope. */
const EVERYWHERE = [
    [/\btodo!\s*\(/, "todo!"],
    [/\bunimplemented!\s*\(/, "unimplemented!"],
    [/#\[\s*ignore\b/, "#[ignore]"],
    [/\bdbg!\s*\(/, "dbg!"],
    [/not\s+implemented/i, '"not implemented"'],
    [/\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo)\b/, "skipped, focused or todo test"],
    [/\bx(?:it|describe)\s*\(/, "skipped test"]
];
/** Banned in Rust library code (a crate's src/, not its tests or build script). */
const RUST_LIBRARY = [[/\b(?:e?println|e?print)!\s*\(/, "printing from library code"]];

/** Every violation in one file's text. */
export function scan(text, { rustLibrary = false } = {}) {
    const rules = rustLibrary ? [...EVERYWHERE, ...RUST_LIBRARY] : EVERYWHERE;
    const found = [];
    text.split("\n").forEach((line, i) => {
        for (const [pattern, label] of rules) if (pattern.test(line)) found.push({ line: i + 1, label, text: line.trim() });
    });
    return found;
}

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", "dist", "native", "wasm", "target"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(path);
        else if (/\.(rs|ts|tsx|mjs|js|toml)$/.test(entry.name)) yield path;
    }
}

export function roots() {
    const crates = join(repoRoot, "crates");
    const found = readdirSync(crates)
        .filter((name) => name.startsWith("polaris-core"))
        .map((name) => join(crates, name));
    return [...found, packageDir].filter((p) => existsSync(p) && statSync(p).isDirectory());
}

function main() {
    let violations = 0;
    let files = 0;
    for (const root of roots()) {
        for (const path of walk(root)) {
            if (EXEMPT.has(path)) continue;
            files++;
            const rel = relative(repoRoot, path).split(sep).join("/");
            const rustLibrary = /^crates\/polaris-core[^/]*\/src\/.*\.rs$/.test(rel);
            for (const v of scan(readFileSync(path, "utf8"), { rustLibrary })) {
                violations++;
                process.stdout.write(`${rel}:${v.line}: ${v.label}: ${v.text}\n`);
            }
        }
    }
    process.stdout.write(`[no-simulation-guard] ${files} files, ${violations} violations\n`);
    process.exit(violations ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
