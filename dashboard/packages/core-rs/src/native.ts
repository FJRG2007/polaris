/**
 * Loading the Node binding (`crates/polaris-core-node`) on the dashboard server
 * and in Electron main. The file is `native/polaris-core.<platform>.node` next
 * to this package's `dist/`; when it is not there, or does not load, the facade
 * answers with TypeScript.
 *
 * Node built-ins are reached through `process.getBuiltinModule`, which is
 * synchronous and invisible to bundlers, so this module is safe to bundle for a
 * browser (where it simply finds no Node and returns no source).
 */

import type { BindingSource } from "./runtime";
import { BindingMissingError, pickBinding } from "./binding";

interface NodeBuiltins {
    getBuiltinModule?: (id: string) => unknown;
    platform?: string;
    arch?: string;
    report?: { getReport(): unknown };
}

/** The binding file name for a platform, matching what `scripts/build-rust.mjs` writes. */
export function nativeFileName(platform: string, arch: string, musl: boolean): string {
    if (platform === "win32") return `polaris-core.win32-${arch}-msvc.node`;
    if (platform === "linux") return `polaris-core.linux-${arch}-${musl ? "musl" : "gnu"}.node`;
    return `polaris-core.${platform}-${arch}.node`;
}

function isMusl(proc: NodeBuiltins): boolean {
    if (proc.platform !== "linux") return false;
    const report = proc.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    return !report?.header?.glibcVersionRuntime;
}

/**
 * The Node binding source, or `null` outside Node. `directory` overrides where
 * the `.node` file is looked for (tests point it at a scratch directory).
 */
export function nativeSource(directory?: string): BindingSource | null {
    const proc = globalThis.process as unknown as NodeBuiltins | undefined;
    if (typeof proc?.getBuiltinModule !== "function") return null;
    const getBuiltin = proc.getBuiltinModule.bind(proc);
    return {
        kind: "napi",
        load() {
            const fs = getBuiltin("node:fs") as typeof import("node:fs");
            const path = getBuiltin("node:path") as typeof import("node:path");
            const url = getBuiltin("node:url") as typeof import("node:url");
            const mod = getBuiltin("node:module") as typeof import("node:module");
            // Through a variable: a bundler reading `new URL("...", import.meta.url)`
            // literally treats the folder as an asset of every browser and edge
            // chunk that reaches this module, and fails the build looking for it.
            const here = import.meta.url;
            const dir = directory ?? url.fileURLToPath(new URL("../native/", here));
            const file = path.join(dir, nativeFileName(proc.platform ?? "", proc.arch ?? "", isMusl(proc)));
            if (!fs.existsSync(file)) throw new BindingMissingError(`no Node binding at ${file}`);
            return pickBinding(mod.createRequire(import.meta.url)(file));
        }
    };
}
