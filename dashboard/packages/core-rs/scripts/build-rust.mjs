/**
 * Build the Rust core's bindings into this package:
 *
 *   native/polaris-core.<platform>.node   the Node binding (napi-rs), profile release-node
 *   wasm/polaris_core_wasm.js + _bg.wasm  the WebAssembly binding (wasm-bindgen --target web), wasm-opt -Oz
 *
 *   npm run build:rust -w @polaris/core-rs [-- --node-target <rust triple>] [-- --only node|wasm]
 *
 * Needs cargo, wasm-bindgen-cli (the same version as the wasm-bindgen crate)
 * and wasm-opt on PATH. Both outputs are build artifacts and are not committed;
 * without them the facades answer with TypeScript.
 */

import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
export const packageDir = join(here, "..");
export const repoRoot = join(packageDir, "..", "..", "..");

/** Rust target triple -> the platform part of the `.node` name the loader looks for (src/native.ts). */
export const NODE_TARGETS = {
    "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", musl: false, file: "polaris_core_node.dll" },
    "aarch64-pc-windows-msvc": { platform: "win32", arch: "arm64", musl: false, file: "polaris_core_node.dll" },
    "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", musl: false, file: "libpolaris_core_node.so" },
    "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", musl: false, file: "libpolaris_core_node.so" },
    "x86_64-unknown-linux-musl": { platform: "linux", arch: "x64", musl: true, file: "libpolaris_core_node.so" },
    "aarch64-unknown-linux-musl": { platform: "linux", arch: "arm64", musl: true, file: "libpolaris_core_node.so" },
    "x86_64-apple-darwin": { platform: "darwin", arch: "x64", musl: false, file: "libpolaris_core_node.dylib" },
    "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", musl: false, file: "libpolaris_core_node.dylib" }
};

/** Same naming as nativeFileName in src/native.ts; a unit test keeps the two in step. */
export function nodeFileName({ platform, arch, musl }) {
    if (platform === "win32") return `polaris-core.win32-${arch}-msvc.node`;
    if (platform === "linux") return `polaris-core.linux-${arch}-${musl ? "musl" : "gnu"}.node`;
    return `polaris-core.${platform}-${arch}.node`;
}

function hostTarget() {
    const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
    const found = Object.entries(NODE_TARGETS).find(
        ([, t]) => t.platform === process.platform && t.arch === process.arch && t.musl === musl
    );
    if (!found) throw new Error(`no Node binding target for ${process.platform}-${process.arch}`);
    return found[0];
}

function run(command, args, env = process.env) {
    process.stdout.write(`[build-rust] ${command} ${args.join(" ")}\n`);
    const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit", env });
    if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

/**
 * Rust's musl targets link the C runtime statically by default, and a static
 * C runtime cannot produce a shared library: rustc drops the `cdylib` and no
 * `.so` is written. A `.node` is loaded into a musl Node process that already
 * has its own libc, so it links the C runtime dynamically. Set per target here,
 * not in `.cargo/config.toml`, where it would also make the static musl builds
 * of the on-device daemons dynamic.
 */
function nodeBuildEnv(target, spec) {
    if (!spec.musl) return process.env;
    const key = `CARGO_TARGET_${target.toUpperCase().replaceAll("-", "_")}_RUSTFLAGS`;
    const flags = [process.env[key], "-C target-feature=-crt-static"].filter(Boolean).join(" ");
    return { ...process.env, [key]: flags };
}

function buildNode(target) {
    const spec = NODE_TARGETS[target];
    if (!spec) throw new Error(`unknown --node-target ${target}; known: ${Object.keys(NODE_TARGETS).join(", ")}`);
    run("cargo", ["build", "--locked", "-p", "polaris-core-node", "--profile", "release-node", "--target", target], nodeBuildEnv(target, spec));
    const outDir = join(packageDir, "native");
    mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, nodeFileName(spec));
    copyFileSync(join(repoRoot, "target", target, "release-node", spec.file), dest);
    process.stdout.write(`[build-rust] wrote ${dest}\n`);
}

function buildWasm() {
    run("cargo", ["build", "--locked", "-p", "polaris-core-wasm", "--target", "wasm32-unknown-unknown", "--profile", "release-wasm"]);
    const outDir = join(packageDir, "wasm");
    rmSync(outDir, { recursive: true, force: true });
    const built = join(repoRoot, "target", "wasm32-unknown-unknown", "release-wasm", "polaris_core_wasm.wasm");
    run("wasm-bindgen", ["--target", "web", "--out-dir", outDir, "--out-name", "polaris_core_wasm", built]);
    const wasm = join(outDir, "polaris_core_wasm_bg.wasm");
    // rustc's wasm32-unknown-unknown enables these features by default and does
    // not declare them in the module, so wasm-opt has to be told.
    const features = [
        "--enable-bulk-memory",
        "--enable-bulk-memory-opt",
        "--enable-nontrapping-float-to-int",
        "--enable-sign-ext",
        "--enable-mutable-globals",
        "--enable-reference-types",
        "--enable-multivalue"
    ];
    run("wasm-opt", ["-Oz", ...features, wasm, "-o", wasm]);
    process.stdout.write(`[build-rust] wrote ${outDir}\n`);
}

function main(argv) {
    const flag = (name) => {
        const i = argv.indexOf(name);
        return i === -1 ? undefined : argv[i + 1];
    };
    const only = flag("--only");
    if (only && only !== "node" && only !== "wasm") throw new Error("--only takes node or wasm");
    if (only !== "wasm") buildNode(flag("--node-target") ?? hostTarget());
    if (only !== "node") buildWasm();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`[build-rust] ${error.message}\n`);
        process.exit(1);
    }
}
