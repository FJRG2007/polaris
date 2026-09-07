/**
 * The modules a browser is allowed to load, kept that way.
 *
 * Several files in Places say at the top that they are client-safe, and they mean
 * it literally: a client component imports them, so whatever they import ends up
 * in the browser bundle. The rule is invisible until it is broken, and when it
 * breaks it does not break here - it breaks in a production build, as a webpack
 * error naming neither the module that reached for the wrong thing nor the screen
 * that pulled it in. That is exactly what happened when the connection registry
 * took a provider's region list from its API client: the client signs requests,
 * signing needs node's crypto, and the whole image build failed on
 * `UnhandledSchemeError: Reading from "node:crypto"`.
 *
 * So the import graph under each of them is walked here, where a failure names
 * the file and the thing it should not have.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SOURCE = resolve(import.meta.dirname, "../../src");

/** The modules that promise a browser may load them. */
const CLIENT_SAFE = [
    "lib/home/device-kinds.ts",
    "lib/home/device-connections.ts",
    "lib/home/place-kinds.ts",
    "lib/integrations/tuya-regions.ts",
    "lib/home/drivers/contract.ts"
];

/** What a browser has none of. `node:` is the one that actually failed a build;
 *  the rest are the doors into this app's own server half. */
const FORBIDDEN = [/^node:/, /^@polaris\/db$/, /^@polaris\/storage$/, /^@polaris\/config$/, /^mqtt$/, /^fs$/, /^net$/];

/** Every module specifier a file imports, type-only ones excluded: `import type`
 *  is erased before anything is bundled, which is what makes it the right way for
 *  a screen to name a shape that lives on the server. */
function importsOf(source: string): string[] {
    const found: string[] = [];
    const pattern = /(?:^|\n)\s*import\s+([^;]*?)\s*from\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
        const clause = match[1] ?? "";
        const specifier = match[2] ?? "";
        if (/^type\s/.test(clause.trim())) continue;
        // `import { type Foo, type Bar }` is erased too; a clause with a value in
        // it is not.
        const named = /^\{([\s\S]*)\}$/.exec(clause.trim())?.[1];
        if (named && named.split(",").every((part) => part.trim() === "" || /^type\s/.test(part.trim()))) {
            continue;
        }
        found.push(specifier);
    }
    return found;
}

/** The file a specifier means, or null for a package. */
function fileFor(specifier: string, from: string): string | null {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return null;
    const base = specifier.startsWith("@/")
        ? join(SOURCE, specifier.slice(2))
        : resolve(dirname(from), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/** Everything one module pulls in, followed all the way down. */
function reaches(entry: string): { file: string; specifier: string }[] {
    const seen = new Set<string>();
    const found: { file: string; specifier: string }[] = [];
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.shift();
        if (!file || seen.has(file)) continue;
        seen.add(file);
        for (const specifier of importsOf(readFileSync(file, "utf8"))) {
            found.push({ file, specifier });
            const next = fileFor(specifier, file);
            if (next) queue.push(next);
        }
    }
    return found;
}

describe("what a client-safe module is allowed to reach", () => {
    for (const entry of CLIENT_SAFE) {
        it(`keeps the browser out of the server half: ${entry}`, () => {
            const file = join(SOURCE, entry);
            expect(existsSync(file), `${entry} is gone or was renamed`).toBe(true);

            const offending = reaches(file).filter((edge) =>
                FORBIDDEN.some((forbidden) => forbidden.test(edge.specifier))
            );
            expect(
                offending.map((edge) => `${edge.file.slice(SOURCE.length + 1)} -> ${edge.specifier}`)
            ).toEqual([]);
        });
    }
});
