#!/usr/bin/env node
/**
 * Print every repository file the browser extension's build turns into what it
 * ships, one per line, sorted (docs/release-scope.md).
 *
 *   node .github/scripts/extension-closure.mjs [<repository root>]
 *
 * extension-version-check.yml asks for a version bump only when a file in this
 * list changed. It used to ask whenever anything under `packages/core/src`
 * changed, and core is where every app keeps its schemas and permissions - so
 * a line added for the hospitality app moved the extension to a new version,
 * and every browser that has it was offered an update that changed nothing.
 *
 * The list is the extension's real module graph, the way Nx's and Turborepo's
 * "affected" graph or an esbuild metafile see a project rather than a folder:
 *
 * - The extension's own folder, all of it but its tests and docs. Cheap to
 *   over-count, and nothing in it is shared with anybody else.
 * - The workspace modules its entrypoints bundle. Rollup - the bundler WXT's
 *   Vite builds with, at the lockfile's version - bundles the entrypoints WXT
 *   builds (`src/entrypoints/*.ts(x)` and the scripts each `<name>/index.html`
 *   loads), with every `@polaris/*` import resolved to its source and
 *   TypeScript stripped by esbuild, as Vite does. Each chunk says how much of
 *   every module it rendered (`renderedLength`). A module rendered to nothing -
 *   imported for its types, or re-exported by `@polaris/core`'s barrel and
 *   shaken out - is not shipped.
 *   Third-party packages are left external: they are pinned by the lockfile,
 *   and the extension's package.json is in the first group.
 * - What the build reads besides imports: the stylesheet of the launcher on the
 *   page (scripts/search-styles.mjs reads @polaris/ui's sources and tokens) and
 *   the WebAssembly binding's staging (packages/core-rs/scripts/wasm-assets.mjs).
 * - The Rust crates that binding is compiled from, as `crates/<name>/`
 *   prefixes, their tests left out. Cargo.lock is decided by the workflow,
 *   through lock-reaches.py, since one line of the shared lock reaches it only
 *   when it is one of those crates' dependencies.
 *
 * A module whose top level calls something Rollup cannot prove pure (a zod
 * schema, say) is kept, here as in the real build: no workspace package
 * declares `sideEffects`, and `@polaris/core`'s barrel re-exports everything.
 * That is why the extension and @polaris/vault-crypto import core by subpath
 * (`@polaris/core/vault`, `@polaris/core/host-list`, ...): through the barrel,
 * every module with such a call - permissions.ts, say - lands in the bundle and
 * a change to it ships with the extension. Leaving packages external
 * makes their calls unknowable too, so the list errs toward a bump.
 */

import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"];

/** The WebAssembly crates the extension stages (packages/core-rs/scripts/build-rust.mjs WASM_CRATES, the one wasmAssets() copies). */
export const WASM_CRATES = ["polaris-core-wasm"];

/** Whether a file in the extension's own folder is part of what it ships. Tests and docs are not. */
export function ownShipped(path) {
    const rest = path.slice("dashboard/apps/extension/".length);
    return !/^test\//.test(rest) && rest !== "vitest.config.ts" && !/\.md$/i.test(rest);
}

/** Forward slashes, relative to the repository. */
function repoPath(root, file) {
    return relative(root, file).split(sep).join("/");
}

/** The first existing source file for a module path given without, or with a compiled, extension. */
function sourceFile(base) {
    if (existsSync(base) && statSync(base).isFile()) return base;
    const stem = base.replace(/\.(js|mjs|d\.ts)$/, "");
    for (const ext of SOURCE_EXTENSIONS) if (existsSync(stem + ext)) return stem + ext;
    for (const ext of SOURCE_EXTENSIONS) if (existsSync(join(stem, `index${ext}`))) return join(stem, `index${ext}`);
    return null;
}

/** The export target of `subpath` ("." or "./x") in a package's `exports`, wildcards included. */
export function exportTarget(exports, subpath) {
    if (!exports) return null;
    const pick = (entry) => (typeof entry === "string" ? entry : (entry?.import ?? entry?.default ?? entry?.types ?? null));
    if (typeof exports === "string") return subpath === "." ? exports : null;
    if (exports[subpath] !== undefined) return pick(exports[subpath]);
    for (const [key, entry] of Object.entries(exports)) {
        const star = key.indexOf("*");
        if (star < 0) continue;
        const [head, tail] = [key.slice(0, star), key.slice(star + 1)];
        if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length >= head.length + tail.length) {
            const target = pick(entry);
            return target ? target.replace("*", subpath.slice(head.length, subpath.length - tail.length)) : null;
        }
    }
    return null;
}

/** Every workspace package by its name: dashboard/packages/* and dashboard/apps/*. */
function workspacePackages(root) {
    const out = new Map();
    for (const group of ["packages", "apps"]) {
        const dir = join(root, "dashboard", group);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
            const manifest = join(dir, name, "package.json");
            if (!existsSync(manifest)) continue;
            const json = JSON.parse(readFileSync(manifest, "utf8"));
            if (json.name) out.set(json.name, { dir: join(dir, name), json });
        }
    }
    return out;
}

/**
 * A workspace import resolved to its source: the `exports` target, read from
 * `src/` where it names `dist/` (each package's build compiles one into the
 * other), or null when the package has no such export.
 */
export function resolveWorkspace(packages, specifier) {
    const match = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
    const pkg = match && packages.get(match[1]);
    if (!pkg) return null;
    const subpath = match[2] ? `.${match[2]}` : ".";
    const target = exportTarget(pkg.json.exports, subpath) ?? (subpath === "." ? (pkg.json.main ?? null) : null);
    if (!target) throw new Error(`${specifier}: ${match[1]} has no export "${subpath}"`);
    const file = sourceFile(join(pkg.dir, target)) ?? sourceFile(join(pkg.dir, target.replace(/^\.\/dist\//, "./src/")));
    if (!file) throw new Error(`${specifier}: no source for ${target} in ${repoPath(dirname(dirname(pkg.dir)), pkg.dir)}`);
    return { file, dir: pkg.dir };
}

/** The scripts WXT builds: each file directly in src/entrypoints, and the scripts each folder's index.html loads. */
export function entrypoints(extensionDir) {
    const dir = join(extensionDir, "src", "entrypoints");
    const out = [];
    for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isFile()) {
            if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
            continue;
        }
        const html = join(full, "index.html");
        if (existsSync(html)) {
            for (const [, src] of readFileSync(html, "utf8").matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
                const file = sourceFile(resolve(full, src));
                if (file) out.push(file);
            }
        }
        for (const ext of [".ts", ".tsx"]) if (existsSync(join(full, `index${ext}`))) out.push(join(full, `index${ext}`));
    }
    return out;
}

/** The workspace path dependencies of a crate, followed to the end, as crate directory names. */
export function crateClosure(root, crates) {
    const seen = new Set();
    const queue = [...crates];
    while (queue.length > 0) {
        const name = queue.shift();
        if (seen.has(name)) continue;
        const manifest = join(root, "crates", name, "Cargo.toml");
        if (!existsSync(manifest)) continue;
        seen.add(name);
        for (const [, path] of readFileSync(manifest, "utf8").matchAll(/\bpath\s*=\s*"\.\.\/([^"/]+)"/g)) queue.push(path);
    }
    return [...seen].sort();
}

/** A package from the directory CI installs the closure's tools into (`CLOSURE_TOOLS`), or from wherever node finds it. */
async function tool(name) {
    const dir = process.env.CLOSURE_TOOLS;
    const loaded = await import(dir ? pathToFileURL(createRequire(join(dir, "x.js")).resolve(name)).href : name);
    return loaded.default && !loaded.rollup && !loaded.transform ? loaded.default : loaded;
}

const RAW = "\0raw:";
const ASSET = /\.(css|svg|png|webp|woff2?|wasm)$/;

/**
 * Bundle the entrypoints the way WXT does - Rollup, TypeScript stripped by
 * esbuild - and return the workspace files that put code in the output, read
 * from each chunk's `renderedLength`. A stylesheet or picture ships once it is
 * imported at all, so those count by being reached.
 */
async function bundledFiles(root, extensionDir, packages) {
    const { rollup } = await tool("rollup");
    const { transform } = await tool("esbuild");
    const used = new Set();
    const reached = new Set();
    const relativeTo = (importer, path) => sourceFile(resolve(importer ? dirname(importer) : extensionDir, path));
    const plugin = {
        name: "polaris-closure",
        resolveId(source, importer) {
            if (source.startsWith("\0")) return null;
            // A query (`?raw`, `?url`, `?inline`) is Vite's; the file it names ships either way.
            if (source.includes("?")) {
                const bare = source.replace(/\?.*$/, "");
                const file = /^[@~]\//.test(bare) ? sourceFile(join(extensionDir, "src", bare.slice(2))) : relativeTo(importer, bare);
                return file ? RAW + file : { id: source, external: true };
            }
            if (/^[@~]\//.test(source)) {
                const file = sourceFile(join(extensionDir, "src", source.slice(2)));
                if (!file) throw new Error(`${source}: not found under the extension's src/`);
                return file;
            }
            const workspace = resolveWorkspace(packages, source);
            if (workspace) {
                used.add(workspace.dir);
                return workspace.file;
            }
            if (source.startsWith(".") || isAbsolute(source)) {
                const file = relativeTo(importer, source);
                if (!file) throw new Error(`${source}: not found from ${importer}`);
                return file;
            }
            // A third-party package, a Node builtin or WXT's own `#imports`.
            return { id: source, external: true };
        },
        load(id) {
            if (id.startsWith(RAW)) {
                reached.add(id.slice(RAW.length));
                return `export default ${JSON.stringify(readFileSync(id.slice(RAW.length), "utf8"))};`;
            }
            if (ASSET.test(id)) {
                reached.add(id);
                return "export default '';";
            }
            if (id.endsWith(".json")) {
                const json = JSON.parse(readFileSync(id, "utf8"));
                const named = json && typeof json === "object" && !Array.isArray(json)
                    ? Object.keys(json).filter((key) => /^[A-Za-z_$][\w$]*$/.test(key)).map((key) => `export const ${key} = data[${JSON.stringify(key)}];`)
                    : [];
                return `const data = ${JSON.stringify(json)};\nexport default data;\n${named.join("\n")}`;
            }
            return null;
        },
        async transform(code, id) {
            const loader = /\.(tsx|jsx)$/.test(id) ? "tsx" : /\.(ts|mts)$/.test(id) ? "ts" : null;
            if (!loader) return null;
            const out = await transform(code, { loader, jsx: "automatic", format: "esm", target: "esnext", sourcefile: id });
            return { code: out.code, map: null };
        }
    };
    const bundle = await rollup({ input: entrypoints(extensionDir), plugins: [plugin], onwarn: () => undefined });
    const { output } = await bundle.generate({ format: "es" });
    await bundle.close();
    const files = new Set();
    const keep = (file) => {
        const path = repoPath(root, file);
        if (path.startsWith("dashboard/") && !path.startsWith("dashboard/apps/extension/")) files.add(path);
    };
    for (const chunk of output) {
        if (chunk.type !== "chunk") continue;
        for (const [id, { renderedLength }] of Object.entries(chunk.modules)) if (renderedLength > 0 && !id.startsWith("\0")) keep(id);
    }
    for (const file of reached) keep(file);
    return { files, packages: used };
}

/** The build's other inputs: the launcher's stylesheet sources and the binding's staging. */
async function buildInputs(root) {
    const ui = join(root, "dashboard", "packages", "ui", "src");
    const out = [
        join(root, "dashboard", "packages", "core-rs", "scripts", "wasm-assets.mjs"),
        join(ui, "search", "search-styles.mjs"),
        join(ui, "styles", "tokens.css")
    ];
    const preset = sourceFile(join(ui, "tailwind-preset"));
    if (preset) out.push(preset);
    const { searchSources } = await import(pathToFileURL(join(ui, "search", "search-styles.mjs")).href);
    out.push(...searchSources(ui));
    return out.map((file) => repoPath(root, file));
}

/** Every git-tracked file in the extension's folder that ships. */
function ownFiles(root) {
    return execFileSync("git", ["ls-files", "dashboard/apps/extension"], { cwd: root, encoding: "utf8", windowsHide: true })
        .split("\n")
        .filter(Boolean)
        .filter(ownShipped);
}

export async function closure(root) {
    const extensionDir = join(root, "dashboard", "apps", "extension");
    const packages = workspacePackages(root);
    const bundled = await bundledFiles(root, extensionDir, packages);
    const manifests = [...bundled.packages].map((dir) => `${repoPath(root, dir)}/package.json`);
    const crates = crateClosure(root, WASM_CRATES).map((name) => `crates/${name}/`);
    return [...new Set([...ownFiles(root), ...bundled.files, ...manifests, ...(await buildInputs(root)), ...crates])].sort();
}

/** Whether a changed path is in a closure: listed as a file, or under a listed `crates/<name>/` (its tests aside). */
export function inClosure(list, path) {
    for (const entry of list) {
        if (entry.endsWith("/")) {
            if (path.startsWith(entry) && !/^(tests|benches|examples)\//.test(path.slice(entry.length)) && !/\.md$/i.test(path)) return true;
        } else if (entry === path) return true;
    }
    return false;
}

/**
 * The changed paths that ship: in the closure before the change or after it.
 * Both, because a change can take a module out of the bundle (it was in the
 * one before) or bring a new one in (it is only in the one after).
 */
export function shippedChanges(changed, before, after) {
    return changed.filter((path) => inClosure(before, path) || inClosure(after, path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [command, ...args] = process.argv.slice(2);
    if (command === "shipped") {
        // shipped <checkout before> <checkout after>, the changed paths on stdin.
        const changed = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
        const [before, after] = await Promise.all(args.slice(0, 2).map((root) => closure(resolve(root))));
        const out = shippedChanges(changed, before, after);
        if (out.length > 0) process.stdout.write(`${out.join("\n")}\n`);
    } else {
        const list = await closure(resolve(command ?? "."));
        process.stdout.write(`${list.join("\n")}\n`);
    }
}
