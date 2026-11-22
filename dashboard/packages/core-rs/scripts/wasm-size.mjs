/**
 * Fail when the built WebAssembly module is over its brotli budget
 * (docs/rust-core-plan.md, 4.7). The budget lives in wasm-budget.json and is
 * quoted in the ledger row of the unit that owns it; raising it is a reviewed
 * change to both.
 *
 *   npm run check:size -w @polaris/core-rs     (after npm run build:rust)
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const budgets = JSON.parse(readFileSync(join(packageDir, "wasm-budget.json"), "utf8"));
let failed = false;
for (const [file, budget] of Object.entries(budgets)) {
    const path = join(packageDir, "wasm", file);
    if (!existsSync(path)) {
        process.stderr.write(`[wasm-size] ${path} is missing: run npm run build:rust first\n`);
        failed = true;
        continue;
    }
    const raw = readFileSync(path);
    const brotli = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    const over = brotli > budget.brotliBytes;
    failed ||= over;
    process.stdout.write(`[wasm-size] ${file}: ${raw.length} B raw, ${brotli} B brotli, budget ${budget.brotliBytes} B ${over ? "- OVER BUDGET" : "- ok"}\n`);
}
process.exit(failed ? 1 : 0);
