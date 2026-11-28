/**
 * The extension's build graph (extension-closure.mjs), which decides whether a
 * change needs an extension version. Run by extension-version-check.yml:
 *
 *   node --test .github/scripts/extension-closure.test.mjs
 *
 * The bundling tests need Rollup and esbuild (`CLOSURE_TOOLS`, which the
 * workflow installs) and are skipped without them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { closure, crateClosure, exportTarget, inClosure, ownShipped, shippedChanges } from "./extension-closure.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const tools = process.env.CLOSURE_TOOLS ? {} : { skip: "CLOSURE_TOOLS is not set" };

test("the extension's tests and docs are not what it ships", () => {
    assert.equal(ownShipped("dashboard/apps/extension/src/entrypoints/background.ts"), true);
    assert.equal(ownShipped("dashboard/apps/extension/package.json"), true);
    assert.equal(ownShipped("dashboard/apps/extension/public/_locales/en/messages.json"), true);
    assert.equal(ownShipped("dashboard/apps/extension/test/matching.test.ts"), false);
    assert.equal(ownShipped("dashboard/apps/extension/vitest.config.ts"), false);
    assert.equal(ownShipped("dashboard/apps/extension/README.md"), false);
});

test("an export is resolved by name, by condition and by wildcard", () => {
    const exports = {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./vault": { import: "./dist/vault.js" },
        "./icons/*": "./src/icons/*.tsx"
    };
    assert.equal(exportTarget(exports, "."), "./dist/index.js");
    assert.equal(exportTarget(exports, "./vault"), "./dist/vault.js");
    assert.equal(exportTarget(exports, "./icons/lock"), "./src/icons/lock.tsx");
    assert.equal(exportTarget(exports, "./missing"), null);
    assert.equal(exportTarget("./main.js", "."), "./main.js");
});

test("a crate prefix covers its sources and leaves out what cargo never compiles", () => {
    const list = ["crates/polaris-core/", "dashboard/packages/core/src/vault.ts"];
    assert.equal(inClosure(list, "crates/polaris-core/src/lib.rs"), true);
    assert.equal(inClosure(list, "crates/polaris-core/Cargo.toml"), true);
    assert.equal(inClosure(list, "crates/polaris-core/tests/vectors.rs"), false);
    assert.equal(inClosure(list, "crates/polaris-core/README.md"), false);
    assert.equal(inClosure(list, "crates/polaris-core-node/src/lib.rs"), false);
    assert.equal(inClosure(list, "dashboard/packages/core/src/vault.ts"), true);
    assert.equal(inClosure(list, "dashboard/packages/core/src/vault-items.ts"), false);
});

test("a change ships when its file is in the graph before it or after it", () => {
    const before = ["a.ts", "b.ts"];
    const after = ["b.ts", "c.ts"];
    assert.deepEqual(shippedChanges(["a.ts", "c.ts", "d.ts"], before, after), ["a.ts", "c.ts"]);
    assert.deepEqual(shippedChanges(["d.ts"], before, after), []);
});

test("the WebAssembly binding's crates are followed through their path dependencies", () => {
    const crates = crateClosure(ROOT, ["polaris-core-wasm"]);
    assert.ok(crates.includes("polaris-core-wasm"));
    assert.ok(crates.includes("polaris-core"));
    assert.ok(!crates.includes("polaris-hostd"));
});

test("the real graph holds what the extension bundles and not the rest of core", tools, async () => {
    const list = await closure(ROOT);
    // Bundled: its own sources and the vault's crypto, which it imports.
    assert.ok(list.includes("dashboard/apps/extension/src/entrypoints/background.ts"));
    assert.ok(list.includes("dashboard/packages/vault-crypto/src/index.ts"));
    assert.ok(list.includes("dashboard/packages/core/package.json"));
    // Read by the build besides imports: the launcher's stylesheet tokens.
    assert.ok(list.includes("dashboard/packages/ui/src/styles/tokens.css"));
    assert.ok(list.includes("crates/polaris-core-wasm/"));
    // Not bundled: the update list's commit parser, a server concern re-exported by the barrel.
    assert.ok(!list.includes("dashboard/packages/core/src/changelog.ts"));
    assert.ok(!list.some((file) => file.startsWith("dashboard/apps/extension/test/")));
    assert.ok(!list.some((file) => file.startsWith("dashboard/apps/web/")));
});

test("a checkout without the extension fails instead of passing", tools, async () => {
    await assert.rejects(closure(join(ROOT, "does-not-exist")));
});
