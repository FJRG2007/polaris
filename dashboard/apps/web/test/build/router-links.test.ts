import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * No router link points at an API route.
 *
 * A `next/link` prefetches its target as soon as it is on screen. For a page that
 * is a small payload; for an API route it is the whole response, fetched for
 * nobody. The world tab linked its backup downloads this way, so opening it
 * started a full download of every archive listed - gigabytes over the same
 * connection as the rest of the dashboard - and every other request, navigation
 * and reload in that tab waited behind them until the tab was closed.
 *
 * Read as source: the rule is about what the markup says, and a plain `<a>` is
 * the right element for anything the router does not render.
 */

const SRC = join(process.cwd(), "src");

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith(".tsx") ? [path] : [];
    });
}

/** The local names `next/link`'s default export is imported under in a file. */
function linkNames(source: string): string[] {
    return [...source.matchAll(/import\s+(\w+)\s+from\s+["']next\/link["']/g)].map((match) => match[1]);
}

/** Every router link in a file whose href is an API path. */
function apiLinks(source: string): string[] {
    return linkNames(source).flatMap((name) =>
        [...source.matchAll(new RegExp(`<${name}\\b[^>]*?href=\\{?\\s*[\`"']([^\`"']*)`, "gs"))]
            .map((match) => match[1])
            .filter((href) => href.startsWith("/api/"))
    );
}

describe("router links", () => {
    it("recognises the mistake it is looking for", () => {
        const source = 'import Link from "next/link";\n<Link\n    href={`/api/files/${id}`}\n    download\n>';
        expect(apiLinks(source)).toEqual(["/api/files/${id}"]);
        expect(apiLinks('import Link from "next/link";\n<Link href="/apps">')).toEqual([]);
    });

    it("never point at an API route", () => {
        const found = sources(SRC).flatMap((path) =>
            apiLinks(readFileSync(path, "utf8")).map((href) => `${relative(SRC, path)}: ${href}`)
        );
        expect(found).toEqual([]);
    });
});
