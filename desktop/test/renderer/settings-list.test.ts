import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Settings rows are spaced by the list that holds them, never by themselves:
 * a `.setting` sits directly in a `.settings-list`, the list puts one gap
 * between its rows, and a row lays out the same whether it holds a switch, a
 * button or a dropdown. Rows spaced any other way ended up touching the next
 * one whenever a row was not the kind the spacing was written for.
 */
const RENDERER = fileURLToPath(new URL("../../src/renderer", import.meta.url));
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

interface Node {
    tag: string;
    classes: readonly string[];
    parent: Node | null;
}

/** Every element of a page with its parent, from the markup as written. */
function elements(html: string): Node[] {
    const found: Node[] = [];
    const open: Node[] = [];
    const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    for (const match of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
        const [, closing, name, attributes, selfClosing] = match;
        const tag = (name ?? "").toLowerCase();
        if (closing) {
            const at = open.map((node) => node.tag).lastIndexOf(tag);
            if (at >= 0) open.length = at;
            continue;
        }
        const classes = /\bclass="([^"]*)"/.exec(attributes ?? "")?.[1]?.split(/\s+/).filter(Boolean) ?? [];
        const node = { tag, classes, parent: open.at(-1) ?? null };
        found.push(node);
        if (!selfClosing && !VOID.has(tag)) open.push(node);
    }
    return found;
}

/** The declarations of the rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string | null {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null;
}

describe("settings lists", () => {
    const pages = readdirSync(RENDERER).filter((name) => name.endsWith(".html"));
    const css = readFileSync(join(RENDERER, "styles.css"), "utf8");

    it("find the settings rows", () => {
        const rows = elements(readFileSync(join(RENDERER, "connect.html"), "utf8")).filter((node) => node.classes.includes("setting"));
        expect(rows.length).toBeGreaterThan(5);
    });

    for (const name of pages) {
        it(`${name} puts every setting row directly in a settings list`, () => {
            const loose = elements(readFileSync(join(RENDERER, name), "utf8"))
                .filter((node) => node.classes.includes("setting") && !node.parent?.classes.includes("settings-list"))
                .map((node) => `${name}: a <${node.tag} class="setting"> outside a .settings-list`);
            expect(loose).toEqual([]);
        });

        it(`${name} draws every switch as a setting row`, () => {
            // A switch in a `label.row` loses its width to the radio's rule
            // and draws as a lone knob over its own sentence.
            const stray = elements(readFileSync(join(RENDERER, name), "utf8"))
                .filter((node) => node.classes.includes("switch") && !node.parent?.classes.includes("setting"))
                .map((node) => `${name}: a switch outside a .setting row`);
            expect(stray).toEqual([]);
        });
    }

    it("space their rows with one gap", () => {
        const list = rule(css, ".settings-list");
        expect(list).toMatch(/display:\s*flex/);
        expect(list).toMatch(/flex-direction:\s*column/);
        expect(list).toMatch(/gap:\s*[1-9]/);
    });

    it("lay a row out the same whatever element it is", () => {
        const row = rule(css, ".setting");
        expect(row).toMatch(/display:\s*flex/);
        expect(row).toMatch(/flex-direction:\s*row/);
        expect(row).toMatch(/align-items:\s*center/);
        expect(rule(css, ".setting-text")).toMatch(/flex:\s*1 1/);
        // Layout tied to one element is how a div row lost it: only the hover
        // tint, which only a switch's row has, may name the element.
        const tied = [...css.matchAll(/(?:^|\n)([a-z]+\.setting(?:-text)?)\s*\{/g)].map((match) => match[1]);
        expect(tied).toEqual([]);
    });
});
