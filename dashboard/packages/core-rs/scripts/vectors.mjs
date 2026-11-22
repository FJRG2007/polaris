/**
 * Regenerate the golden vectors in crates/polaris-core-vectors from the current
 * TypeScript implementations (docs/rust-core-plan.md, 4.1). The same test that
 * fails on drift writes the files when UPDATE_VECTORS=1; review the diff.
 *
 *   npm run vectors -w @polaris/core-rs
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
// The CLI entry is not in vitest's exports map; find it next to its manifest.
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "test/unit/vectors.test.ts"], {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env, UPDATE_VECTORS: "1" }
});
process.exit(result.status ?? 1);
