/**
 * How the main process and the preloads are bundled (build/bundle.mjs), kept in
 * a module of its own so the Rust core check (build/core-rs-smoke.mjs) bundles
 * the facade exactly the way the app would.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export const node = {
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    // node-pty is a native module: it ships as itself in node_modules (see
    // forge.config.js) and is loaded at run time by the runner.
    external: ["electron", "node-pty"],
    // Shared modules under dashboard/packages import zod and @noble/hashes, and
    // CI installs only this folder's packages, so resolve them from here as
    // tsconfig does.
    alias: { zod: join(ROOT, "node_modules/zod"), "@noble/hashes": join(ROOT, "node_modules/@noble/hashes") },
    logLevel: "info",
    legalComments: "none"
};

/**
 * The main process only: CommonJS has no `import.meta`, and the Rust core's
 * facade finds and loads its binding through `import.meta.url`
 * (dashboard/packages/core-rs/src/native.ts). It gets the bundle's own file URL
 * instead of the empty object esbuild leaves, under which every load would fail
 * and fall back to TypeScript. Not the preloads: a sandboxed preload has no
 * `require("node:url")`, and nothing there loads a binding.
 */
export const mainNode = {
    ...node,
    // Injected rather than a banner: a banner lands above "use strict" and
    // takes the whole bundle out of strict mode.
    define: { "import.meta.url": "import_meta_url" },
    inject: [join(ROOT, "build/import-meta-url.js")]
};

/**
 * The Rust core's Node bindings, built into dashboard/packages/core-rs/native by
 * its build:rust script (desktop.yml builds the one for each target). The ones
 * for this platform are copied to dist/native, which forge.config.js keeps
 * outside the archive, since a `.node` cannot be loaded from inside one.
 */
export const CORE_RS_NATIVE = join(ROOT, "..", "dashboard", "packages", "core-rs", "native");
