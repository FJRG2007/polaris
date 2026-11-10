/**
 * A page, layout or route never calls a function out of a "use client" file.
 *
 * On the server every export of a client module is a reference, not the
 * function, so calling one throws "Attempted to call x() from the server" and
 * the whole route renders as an error. That is how Analytics went down: its page
 * checked `?tab=` with a helper that lived in the reports component. Rendering a
 * client component is fine - only a call is not - so what is looked for is a
 * lower-case import from a client module used as `name(`.
 */

import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");
const WEB_SRC = join(APPS, "web/src");
const ROOTS = ["web/src/app", "game-servers/src", "places/src"].map((root) => join(APPS, root));

/** What renders or runs on the server by itself: Next's entry files. */
const ENTRY = /^(page|layout|template|default|not-found|route)\.tsx?$/;
const sources = new Map<string, string>();
function read(path: string): string {
    let source = sources.get(path);
    if (source === undefined) sources.set(path, (source = readFileSync(path, "utf8")));
    return source;
}

/** Whether a file opens with "use client", once its leading comments are skipped. */
function isClient(source: string): boolean {
    let rest = source.trimStart();
    for (;;) {
        if (rest.startsWith("/*")) rest = rest.slice(rest.indexOf("*/") + 2).trimStart();
        else if (rest.startsWith("//")) rest = rest.slice(rest.indexOf("\n") + 1).trimStart();
        else break;
    }
    return /^["']use client["']/.test(rest);
}
const IMPORT = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : files(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

function resolveImport(from: string, spec: string): string | null {
    const base = spec.startsWith("@/")
        ? join(WEB_SRC, spec.slice(2))
        : spec.startsWith(".")
          ? resolve(dirname(from), spec)
          : null;
    if (!base) return null;
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const path = base + suffix;
        if (existsSync(path) && statSync(path).isFile()) return path;
    }
    return null;
}

function callsIntoClient(path: string): string[] {
    const source = read(path);
    if (isClient(source)) return [];
    const found: string[] = [];
    for (const match of source.matchAll(IMPORT)) {
        const target = resolveImport(path, match[2] ?? "");
        if (!target || !isClient(read(target))) continue;
        for (const raw of (match[1] ?? "").split(",")) {
            const name = raw.trim();
            if (!name || name.startsWith("type ")) continue;
            const local = name.split(/\s+as\s+/).pop()?.trim() ?? "";
            if (!/^[a-z]/.test(local)) continue;
            const call = new RegExp(`(?<![\\w.<])${local}\\s*\\(`);
            if (call.test(source.slice((match.index ?? 0) + match[0].length)))
                found.push(`${relative(APPS, path).split("\\").join("/")}: ${local}()`);
        }
    }
    return found;
}

describe("server entry files", () => {
    it("are found at all, so this cannot pass by looking at nothing", () => {
        expect(ROOTS.flatMap(files).filter((path) => ENTRY.test(path.split(/[\\/]/).pop() ?? "")).length).toBeGreaterThan(100);
    });

    it("never call a function exported from a client module", () => {
        const offenders = ROOTS.flatMap(files)
            .filter((path) => ENTRY.test(path.split(/[\\/]/).pop() ?? ""))
            .flatMap(callsIntoClient);
        expect(offenders).toEqual([]);
    });
});
