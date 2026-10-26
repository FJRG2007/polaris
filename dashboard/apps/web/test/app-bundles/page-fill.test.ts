/**
 * PAGE_FILL gives a screen exactly the height left in the window and clips the
 * rest, so a screen wrapped in it has to scroll inside a pane of its own. A page
 * that just grows downwards - Security scans with an image's findings open was
 * the one somebody hit - lost everything below the fold, with no scrollbar to
 * reach it.
 *
 * The check reads source: every page that wraps its screen in PAGE_FILL must
 * reach, through its own imports, a class list holding both `min-h-0` and an
 * `overflow-auto` / `overflow-y-auto` - the bounded pane that does the
 * scrolling.
 */

import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");
const WEB_SRC = join(DASHBOARD, "apps/web/src");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (name === "page.tsx") out.push(path);
    }
    return out;
}

/** The pages to check: every app bundle's routes, and the dashboard's own. */
function pages(): string[] {
    const appsDir = join(DASHBOARD, "apps");
    const roots = readdirSync(appsDir)
        .map((app) => join(appsDir, app, "src/routes"))
        .filter((dir) => existsSync(dir));
    return [...roots, join(WEB_SRC, "app")].flatMap((dir) => walk(dir));
}

function resolveImport(from: string, specifier: string): string | null {
    const base = specifier.startsWith("@/")
        ? join(WEB_SRC, specifier.slice(2))
        : specifier.startsWith(".")
          ? resolve(dirname(from), specifier)
          : null;
    if (!base) return null;
    for (const candidate of [base, `${base}.tsx`, `${base}.ts`, join(base, "index.tsx")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

const IMPORT = /\bfrom\s+"([^"]+)"/g;
const SCROLL_PANE =
    /["`'][^"`'\n]*\bmin-h-0\b[^"`'\n]*\boverflow-(?:y-)?auto\b|["`'][^"`'\n]*\boverflow-(?:y-)?auto\b[^"`'\n]*\bmin-h-0\b/;

/** Whether `entry`, or anything it imports from its own tree, draws a bounded scroll pane. */
function reachesScrollPane(entry: string): boolean {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const source = readFileSync(file, "utf8");
        if (SCROLL_PANE.test(source)) return true;
        for (const match of source.matchAll(IMPORT)) {
            const next = resolveImport(file, match[1]!);
            if (next) queue.push(next);
        }
    }
    return false;
}

describe("PAGE_FILL", () => {
    const filled = pages().filter((page) => /\bPAGE_FILL\b/.test(readFileSync(page, "utf8")));

    it("finds the pages that use it", () => {
        expect(filled.length).toBeGreaterThan(0);
    });

    it.each(filled.map((page) => [relative(DASHBOARD, page).replace(/\\/g, "/"), page]))(
        "%s scrolls inside a pane of its own",
        (_name, page) => {
            expect(reachesScrollPane(page)).toBe(true);
        }
    );

    it("is not wrapped around pages that grow downwards", () => {
        const documents = [
            "apps/security-scans/src/routes/apps/servers/security/[[...path]]/page.tsx",
            "apps/cloud-servers/src/routes/apps/servers/cloud/[[...path]]/page.tsx",
            "apps/status-pages/src/routes/status-pages/[[...path]]/page.tsx",
            "apps/arcade/src/routes/games/[[...path]]/page.tsx"
        ];
        for (const page of documents) {
            expect(readFileSync(join(DASHBOARD, page), "utf8"), page).not.toMatch(/\bPAGE_FILL\b/);
        }
    });
});
