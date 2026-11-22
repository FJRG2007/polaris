import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VectorFile } from "../../src/vectors";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export const packageDir = fileURLToPath(new URL("../../", import.meta.url));
export const repoRoot = join(packageDir, "..", "..", "..");
export const vectorsDir = join(repoRoot, "crates", "polaris-core-vectors");

export function vectorPath(domain: string, op: string): string {
    return join(vectorsDir, domain, `${op}.json`);
}

export function loadVectors(domain: string, op: string): VectorFile {
    return JSON.parse(readFileSync(vectorPath(domain, op), "utf8")) as VectorFile;
}

/** Every committed vector file, as [domain, op]. */
export function allVectorFiles(): [string, string][] {
    const out: [string, string][] = [];
    for (const entry of readdirSync(vectorsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === "src" || entry.name === "tests") continue;
        for (const file of readdirSync(join(vectorsDir, entry.name)))
            if (file.endsWith(".json")) out.push([entry.name, file.slice(0, -".json".length)]);
    }
    return out.sort();
}

/** Fail loudly when a suite that needs built bindings runs without them. */
export function requireBuilt(path: string): string {
    if (!existsSync(path)) throw new Error(`${path} is missing: run \`npm run build:rust -w @polaris/core-rs\` first`);
    return path;
}
