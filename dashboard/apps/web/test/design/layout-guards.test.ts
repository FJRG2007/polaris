/**
 * Two layout defects that are invisible in review and obvious on screen.
 *
 * Badges stacked one per line. A table's name column takes the leftover width
 * (`w-full max-w-0`), and the browser then gives every other column only its
 * min-content width. For a badge cell drawn as a plain `flex flex-wrap` row that
 * is the widest single badge, so "admin / limited / 2FA" became three lines a row
 * beside a column that was mostly empty. `TagList` from `@polaris/ui` makes the
 * whole row the column's floor; a badge cell uses it.
 *
 * Sections with no space between them. The shell's `<main>` is a plain block, so
 * a page that returns `<><PageHeader/><A/><B/></>` puts A and B edge to edge.
 * After its header, a page holds one block - a spaced column when it has several.
 */

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { join, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(import.meta.dirname, "../../../..");
const ROOTS = [
    join(DASHBOARD, "packages/ui/src"),
    ...readdirSync(join(DASHBOARD, "apps"))
        .map((app) => join(DASHBOARD, "apps", app, "src"))
        .filter((dir) => existsSync(dir))
];

function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules") continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* sources(path);
        else if (name.endsWith(".tsx")) yield path;
    }
}

const where = (file: string, text: string, index: number) =>
    `${relative(DASHBOARD, file).split("\\").join("/")}:${text.slice(0, index).split("\n").length}`;

/** A cell holding two or more badges (or a mapped one) in a hand-rolled wrapping row. */
function badgeRowsWithoutTagList(file: string, text: string): string[] {
    const found: string[] = [];
    for (const open of text.matchAll(/<td\b[^>]*>/g)) {
        // The name column is the greedy one: badges there sit beside the name.
        if (/\bw-full\b/.test(open[0]) && /\bmax-w-0\b/.test(open[0])) continue;
        const end = text.indexOf("</td>", open.index);
        if (end < 0) continue;
        const cell = text.slice(open.index, end);
        const badges = cell.match(/<Badge\b/g)?.length ?? 0;
        const mapped = /\.map\([^)]*\)\s*=>\s*\(?\s*<Badge\b/.test(cell);
        if ((badges >= 2 || mapped) && /\bflex-wrap\b/.test(cell) && !cell.includes("<TagList")) {
            found.push(where(file, text, open.index));
        }
    }
    return found;
}

/** Renders nothing in the flow: a portal, a provider, or a component that returns null. */
const OUT_OF_FLOW = /Dialog|Sheet|Drawer|Toaster|Modal|Provider|Keeper|Watcher|SeenOnVisit|Script/;

function tagOf(node: ts.Node): string | null {
    if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
    if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
    return null;
}

function blocksIn(fragment: ts.JsxFragment): string[] {
    const blocks: string[] = [];
    for (const child of fragment.children) {
        if (ts.isJsxText(child)) continue;
        let tag: string | null = null;
        if (ts.isJsxExpression(child)) {
            if (!child.expression) continue;
            tag = child.expression.getText().match(/<([A-Za-z][\w.]*)/)?.[1] ?? null;
        } else tag = tagOf(child);
        if (tag && !OUT_OF_FLOW.test(tag)) blocks.push(tag);
    }
    return blocks;
}

function unspacedPageSections(file: string, text: string): string[] {
    if (!text.includes("<PageHeader")) return [];
    const found: string[] = [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
        if (ts.isJsxFragment(node)) {
            const blocks = blocksIn(node);
            if (blocks[0] === "PageHeader" && blocks.length > 2) {
                found.push(`${where(file, text, node.getStart())} ${blocks.join(", ")}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe("layout guards", () => {
    const files = ROOTS.flatMap((root) => [...sources(root)]).map((file) => ({
        file,
        text: readFileSync(file, "utf8")
    }));

    it("draws every badge cell of a table with TagList", () => {
        expect(files.flatMap(({ file, text }) => badgeRowsWithoutTagList(file, text))).toEqual([]);
    });

    it("spaces the sections a page stacks under its header", () => {
        expect(files.flatMap(({ file, text }) => unspacedPageSections(file, text))).toEqual([]);
    });

    it("catches what it is for", () => {
        const cell = `<tr><td className="px-3"><div className="flex flex-wrap gap-1"><Badge>a</Badge><Badge>b</Badge></div></td></tr>`;
        expect(badgeRowsWithoutTagList("x.tsx", cell)).toHaveLength(1);
        expect(
            badgeRowsWithoutTagList(
                "x.tsx",
                cell.replace(/div className="[^"]*"/, "TagList").replace("</div>", "</TagList>")
            )
        ).toEqual([]);
        const page = `export default function P() { return (<><PageHeader title="t" /><A /><B /></>); }`;
        expect(unspacedPageSections("x.tsx", page)).toHaveLength(1);
        expect(
            unspacedPageSections("x.tsx", page.replace("<A /><B />", "<div><A /><B /></div>"))
        ).toEqual([]);
    });
});
