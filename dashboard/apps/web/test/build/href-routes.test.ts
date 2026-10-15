import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

/**
 * Every literal address the dashboard links to has a page behind it.
 *
 * A link to a route that was never built, or that moved, is the dashboard's own
 * 404 page with no sign of what went wrong. The tasks first-visit screen offered
 * "Do it myself" as a link to `/tasks/spaces`, which has never existed.
 *
 * Read as source: only literal `href`s are checked, since an address assembled
 * at runtime cannot be resolved here. A dynamic segment matches any value.
 */

const WEB = join(__dirname, "..", "..");
const SRC = join(WEB, "src");

/** Tool groups listed as coming soon: drawn, but never linked. */
const NOT_LINKED = new Set(["/tools/documents", "/tools/video", "/tools/links"]);

function routes(dir: string, segments: string[] = []): string[][] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
            if (entry.name.startsWith("@") || entry.name.startsWith("_")) return [];
            const group = /^\(.*\)$/.test(entry.name);
            return routes(join(dir, entry.name), group ? segments : [...segments, entry.name]);
        }
        return /^(page|route)\.(tsx?|js)$/.test(entry.name) ? [segments] : [];
    });
}

function resolves(path: string, table: string[][]): boolean {
    const parts = path.split(/[?#]/)[0].split("/").filter(Boolean);
    return table.some((route) => {
        for (let index = 0; index < route.length; index++) {
            if (/^\[\[?\.\.\./.test(route[index])) return true;
            if (index >= parts.length) return false;
            if (/^\[.+\]$/.test(route[index])) continue;
            if (route[index] !== parts[index]) return false;
        }
        return route.length === parts.length;
    });
}

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

describe("literal links", () => {
    const table = routes(join(SRC, "app"));

    it("reads the route table", () => {
        expect(resolves("/apps/runners/secrets", table)).toBe(true);
        expect(resolves("/tasks/s/abc", table)).toBe(true);
        expect(resolves("/tasks/spaces", table)).toBe(false);
    });

    it("point at a page that exists", () => {
        const broken: string[] = [];
        for (const file of sources(SRC)) {
            const source = readFileSync(file, "utf8");
            for (const match of source.matchAll(/\bhref(?:=\{?|:)\s*["'`](\/[^"'`$\s]*)["'`]/g)) {
                const href = match[1];
                if (href.startsWith("/api/") || href.startsWith("//") || NOT_LINKED.has(href)) continue;
                // A file served from public/ rather than a route.
                if (existsSync(join(WEB, "public", href.split(/[?#]/)[0]))) continue;
                if (!resolves(href, table)) broken.push(`${relative(WEB, file).split("\\").join("/")}: ${href}`);
            }
        }
        expect(broken).toEqual([]);
    });
});
