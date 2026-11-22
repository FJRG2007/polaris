/**
 * Bindings hold no domain logic (docs/rust-core-plan.md, 3.1): the binding
 * crates convert types and map errors, and everything else lives in
 * polaris-core where every target shares it. This check fails when a binding
 * crate grows anything that could be logic:
 *
 *   - a source file other than src/lib.rs, or a submodule;
 *   - control flow (if, match, loops), unsafe code, statics or constants;
 *   - a numeric literal wider than one digit (a domain constant);
 *   - an exported function that does not call into polaris_core (the one
 *     exception is a `*_panic` export whose whole body is a `panic!`, which the
 *     facade's failure-injection tests call);
 *   - a dependency beyond polaris-core and the binding toolkit.
 *
 *   npm run check:bindings -w @polaris/core-rs     (plain Node, no install needed)
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(packageDir, "..", "..", "..");

export const BINDING_CRATES = ["polaris-core-node", "polaris-core-wasm"];

const ALLOWED_DEPENDENCIES = new Set(["polaris-core", "napi", "napi-derive", "wasm-bindgen", "js-sys"]);
const ALLOWED_BUILD_DEPENDENCIES = new Set(["napi-build"]);

const BANNED = [
    [/\bif\b/, "an if"],
    [/\bmatch\b/, "a match"],
    [/\bwhile\b/, "a while loop"],
    [/\bloop\b/, "a loop"],
    [/\bfor\b[^{;]*\bin\b/, "a for loop"],
    [/\bunsafe\b/, "unsafe code"],
    // As items only: `&'static str` is a lifetime, not a static.
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?static\b/, "a static"],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?const\b/, "a constant"],
    [/\bmod\b/, "a submodule"],
    [/\b(?:0[xob][0-9a-fA-F_]+|\d[\d_.]+)/, "a numeric literal (a domain constant belongs in polaris-core)"]
];

/** The source with comments and string/char literals blanked, line breaks kept so line numbers hold. */
export function stripLiterals(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/\/\/[^\n]*/g, "")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])'/g, "''");
}

/** Each exported function: its name and its body, found by matching braces. */
export function exportedFunctions(code) {
    const found = [];
    const head = /#\[\s*(?:napi|wasm_bindgen)\b[^\]]*\]\s*pub\s+fn\s+(\w+)[^{]*\{/g;
    for (let m = head.exec(code); m; m = head.exec(code)) {
        let depth = 1;
        let i = head.lastIndex;
        for (; i < code.length && depth; i++) depth += code[i] === "{" ? 1 : code[i] === "}" ? -1 : 0;
        found.push({ name: m[1], body: code.slice(head.lastIndex, i - 1).trim() });
    }
    return found;
}

/** Every problem in one binding's lib.rs. */
export function checkSource(text) {
    const code = stripLiterals(text);
    const problems = [];
    code.split("\n").forEach((line, i) => {
        // An attribute's arguments are configuration, not logic (`#[napi(catch_unwind)]`).
        const bare = line.replace(/#\[[^\]]*\]/g, "");
        for (const [pattern, label] of BANNED) if (pattern.test(bare)) problems.push(`line ${i + 1}: ${label}: ${line.trim()}`);
    });
    const exports = exportedFunctions(code);
    if (!exports.length) problems.push("no exported function found");
    for (const { name, body } of exports) {
        if (/\bpolaris_core::/.test(body)) continue;
        if (name.endsWith("_panic") && /^panic!\s*\([^;]*\);?$/.test(body)) continue;
        problems.push(`export ${name} does not call into polaris_core`);
    }
    return problems;
}

/** The dependency names of one `[section]` of a Cargo.toml. */
function sectionKeys(toml, section) {
    const start = toml.search(new RegExp(`^\\[${section.replace(".", "\\.")}\\]\\s*$`, "m"));
    if (start === -1) return [];
    const rest = toml.slice(start).split("\n").slice(1);
    const end = rest.findIndex((line) => line.startsWith("["));
    return (end === -1 ? rest : rest.slice(0, end))
        .map((line) => line.match(/^([A-Za-z0-9_-]+)\s*=/)?.[1])
        .filter(Boolean);
}

/** Every problem in one binding's Cargo.toml. */
export function checkManifest(toml) {
    const problems = [];
    for (const name of sectionKeys(toml, "dependencies")) {
        if (!ALLOWED_DEPENDENCIES.has(name)) problems.push(`dependency ${name} is not part of the binding toolkit`);
    }
    for (const name of sectionKeys(toml, "build-dependencies")) {
        if (!ALLOWED_BUILD_DEPENDENCIES.has(name)) problems.push(`build dependency ${name} is not part of the binding toolkit`);
    }
    for (const [, kind, name] of toml.matchAll(/^\[(build-)?dependencies\.([A-Za-z0-9_-]+)\]/gm)) {
        const allowed = kind ? ALLOWED_BUILD_DEPENDENCIES : ALLOWED_DEPENDENCIES;
        if (!allowed.has(name)) problems.push(`${kind ? "build " : ""}dependency ${name} is not part of the binding toolkit`);
    }
    if (/^\[target\./m.test(toml)) problems.push("platform-specific dependencies are not allowed in a binding");
    return problems;
}

/** Every problem in one binding crate directory. */
export function checkCrate(dir) {
    const problems = [];
    const files = readdirSync(join(dir, "src"), { recursive: true });
    for (const file of files) if (String(file).replace(/\\/g, "/") !== "lib.rs") problems.push(`src/${file}: only src/lib.rs is allowed`);
    problems.push(...checkSource(readFileSync(join(dir, "src", "lib.rs"), "utf8")));
    problems.push(...checkManifest(readFileSync(join(dir, "Cargo.toml"), "utf8")));
    return problems;
}

function main() {
    let total = 0;
    for (const name of BINDING_CRATES) {
        for (const problem of checkCrate(join(repoRoot, "crates", name))) {
            total++;
            process.stdout.write(`crates/${name}: ${problem}\n`);
        }
    }
    process.stdout.write(`[binding-check] ${BINDING_CRATES.length} binding crates, ${total} problems\n`);
    process.exit(total ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
