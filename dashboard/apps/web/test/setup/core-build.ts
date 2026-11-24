/**
 * The app imports `@polaris/core` from its build (`dist`), not its source, so a
 * checkout whose build predates a change in core tests the old core: the search
 * panel's calculator failed on a clean `main` this way, against a build made
 * before the calculator moved into core. Before any test file loads, the build
 * is made again when it is missing or older than any source file.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";

const core = fileURLToPath(new URL("../../../../packages/core", import.meta.url));

/** The newest modification time under `dir`, in milliseconds. */
function newest(dir: string): number {
    let latest = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        latest = Math.max(latest, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
    }
    return latest;
}

function builtAt(): number {
    try {
        return statSync(join(core, "dist", "index.js")).mtimeMs;
    } catch {
        return 0;
    }
}

export default function setup(): void {
    if (builtAt() >= newest(join(core, "src"))) return;
    // npm sets this when it runs the tests (`npm test`, `npx vitest`); it is
    // npm's own script, run by this node with an argument array and no shell.
    const npm = process.env.npm_execpath;
    const built = npm
        ? spawnSync(process.execPath, [npm, "run", "build"], { cwd: core, stdio: "inherit" })
        : null;
    if (built?.status !== 0) {
        throw new Error("@polaris/core's build is older than its source. Run `npm run build -w @polaris/core` in dashboard/, then the tests again.");
    }
}
