/**
 * No screen under a loading boundary is only a redirect.
 *
 * Opening Polaris at its address crashed the tab on the first visit ("Application
 * error", Minified React error #310 in Next's App Router) and worked on a reload.
 * The address is `/`, and `/` was a page in the signed-in group whose whole job
 * was `redirect()` to the reader's home. That group draws every page inside its
 * `loading.tsx`, which is a Suspense boundary, so the frame had already gone out
 * with a 200 by the time the page decided to leave: the redirect travelled inside
 * the stream, the browser carried it out while still hydrating, and the React
 * Next 15 ships commits a half-rendered router when anything else talks to it at
 * that moment. The reload worked because it was a reload of `/home`.
 *
 * A screen that forwards unconditionally belongs in `next.config.mjs` (a 307
 * before anything is drawn) or outside the boundary, like the root page. A
 * redirect that depends on data - a list somebody lost access to - can only be
 * decided by the page, and is not what this looks for.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { dirname, join, relative, sep } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const APP_DIR = join(process.cwd(), "src/app");

/** Every page.tsx under the app router, as absolute paths. */
function pages(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return pages(path);
        return entry.name === "page.tsx" ? [path] : [];
    });
}

/** Whether a page is drawn inside some `loading.tsx` above it (or beside it). */
function underLoading(page: string): boolean {
    for (let dir = dirname(page); dir.length >= APP_DIR.length; dir = dirname(dir)) {
        if (existsSync(join(dir, "loading.tsx"))) return true;
        if (dir === APP_DIR) break;
    }
    return false;
}

const FORWARDS = new Set(["redirect", "permanentRedirect"]);

/**
 * Whether the page's default export calls `redirect` as one of its own
 * statements - not inside an `if`, a `try` or a helper, where it depends on
 * something only the page can know.
 */
function forwardsUnconditionally(source: string, file: string): boolean {
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of tree.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.body) continue;
        const modifiers = ts.getModifiers(statement) ?? [];
        if (!modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) continue;
        return statement.body.statements.some((own) => {
            if (!ts.isExpressionStatement(own)) return false;
            const call = ts.isAwaitExpression(own.expression) ? own.expression.expression : own.expression;
            return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && FORWARDS.has(call.expression.text);
        });
    }
    return false;
}

describe("redirects under a loading boundary", () => {
    it("finds the pages it is about", () => {
        // Guards the guard: a walk that found nothing would pass for ever.
        expect(pages(APP_DIR).filter(underLoading).length).toBeGreaterThan(100);
    });

    it("are never a page's unconditional answer", () => {
        const offenders = pages(APP_DIR)
            .filter(underLoading)
            .filter((page) => forwardsUnconditionally(readFileSync(page, "utf8"), page))
            .map((page) => relative(APP_DIR, page).split(sep).join("/"));
        expect(offenders).toEqual([]);
    });

    it("leaves the dashboard root outside every boundary", () => {
        const root = join(APP_DIR, "page.tsx");
        expect(existsSync(root)).toBe(true);
        expect(underLoading(root)).toBe(false);
        expect(existsSync(join(APP_DIR, "(app)", "page.tsx"))).toBe(false);
    });

    it("recognises the shape it forbids", () => {
        const page = `import { redirect } from "next/navigation";
            export default async function Index() { redirect(await home()); }`;
        const guarded = `import { redirect } from "next/navigation";
            export default async function List() { try { await load(); } catch { redirect("/tasks"); } }`;
        expect(forwardsUnconditionally(page, "page.tsx")).toBe(true);
        expect(forwardsUnconditionally(guarded, "page.tsx")).toBe(false);
    });
});
