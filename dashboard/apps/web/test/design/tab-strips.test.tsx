// @vitest-environment jsdom
/**
 * A tab strip on a phone scrolls sideways; it never crushes its labels.
 *
 * The UPS screen in Places has eight tabs. They were a SegmentedControl whose
 * options were `min-w-0 flex-1 truncate`, so at 360px each one was given an
 * eighth of the width and came out as "O...", "E...", "P..." - a row of tabs
 * nobody could read. Hand-written underline strips had the same defect a
 * different way: a plain `flex` row with no overflow pushed the last tabs off
 * the side of the screen, or wrapped a two-word label onto two lines.
 *
 * The rule (dashboard/docs/design.md, "Tab strips"): the strip is a `ScrollRow`
 * - or at least `overflow-x-auto`, or a row that wraps - and every tab in it
 * keeps its label's width (`shrink-0` / `whitespace-nowrap`).
 */

import ts from "typescript";
import { SegmentedControl } from "@polaris/ui";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attribute(node: Opening, name: string): string | null {
    for (const property of node.attributes.properties) {
        if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
        return property.initializer ? property.initializer.getText() : "";
    }
    return null;
}

/** Every class a `className` could hold, however it is assembled. */
const classes = (node: Opening) => attribute(node, "className") ?? "";

const has = (text: string, name: string) =>
    new RegExp(`(^|[\\s"'\`])${name.replace(/[-[\]]/g, "\\$&")}($|[\\s"'\`])`).test(text);

/** A strip that can hold more than its width: it scrolls, or it wraps. */
function stripCopes(node: Opening): boolean {
    const tag = node.tagName.getText();
    if (tag === "ScrollRow" || tag === "SegmentedControl") return true;
    const text = classes(node);
    return (
        has(text, "overflow-x-auto") ||
        has(text, "overflow-x-scroll") ||
        has(text, "flex-wrap") ||
        has(text, "flex-col") ||
        has(text, "grid")
    );
}

/** A tab that keeps its label's width. */
const tabKeepsWidth = (text: string) => has(text, "shrink-0") || has(text, "whitespace-nowrap");

/** The nearest JSX element around a node, skipping the `.map(...)` between them. */
function parentElement(node: ts.Node): Opening | null {
    for (let at = node.parent; at; at = at.parent) {
        if (ts.isJsxElement(at) && at.openingElement !== node) return at.openingElement;
    }
    return null;
}

/** An underline tab: the hairline under the strip, overlapped by the tab's own. */
const isUnderlineTab = (text: string) => has(text, "border-b-2") && has(text, "-mb-px");

/** The element a tab row is drawn as: the one that carries the strip's hairline or scroll. */
function isStripLike(node: Opening): boolean {
    return stripCopes(node) || has(classes(node), "border-b");
}

/** Says which option of a set is the chosen one - a hand-drawn tab or segment. */
const CHOICE_STATE = ["aria-pressed", "aria-selected", "aria-current", "aria-checked"];

/**
 * A hand-drawn pill strip: an option that says it is chosen, made to share out
 * the row (`flex-1`) and cut its label (`truncate`) - the exact classes that
 * turned the UPS tabs into "O...", "E...". Several of them side by side in a
 * row that does not wrap are only readable while the row is wide.
 */
function isCrushingPill(node: Opening, own: string): boolean {
    if (!has(own, "flex-1") || !has(own, "truncate") || tabKeepsWidth(own)) return false;
    // A row of a vertical list - a thread, a file - truncating its name is not a strip.
    if (has(own, "text-left") || !mappedSiblings(node)) return false;
    const role = attribute(node, "role");
    return role === '"radio"' || CHOICE_STATE.some((name) => attribute(node, name) !== null);
}

/** Drawn by a `.map(...)` straight into its parent: one of a row of siblings. */
function mappedSiblings(node: Opening): boolean {
    const element = ts.isJsxSelfClosingElement(node) ? node : node.parent;
    for (let at = element.parent; at && !ts.isJsxElement(at); at = at.parent) {
        if (
            ts.isCallExpression(at) &&
            ts.isPropertyAccessExpression(at.expression) &&
            at.expression.name.text === "map"
        ) {
            return true;
        }
    }
    return false;
}

export function crushedTabStrips(file: string, text: string): string[] {
    if (!/role="tab|border-b-2|truncate/.test(text)) return [];
    const found: string[] = [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = (node: ts.Node) =>
        `${relative(DASHBOARD, file).split("\\").join("/")}:${
            source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        }`;
    const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const role = attribute(node, "role");
            if (role === '"tablist"' && !stripCopes(node)) {
                found.push(`${where(node)} tablist neither scrolls nor wraps`);
            }
            const own = classes(node);
            if (role === '"tab"' || isUnderlineTab(own)) {
                // The tab itself, or the box it sits in inside the strip, keeps
                // its width - a closable tab is a button inside such a box.
                let strip = parentElement(node);
                let keeps = tabKeepsWidth(own);
                if (strip && attribute(strip, "role") !== '"tablist"' && !isStripLike(strip)) {
                    keeps ||= tabKeepsWidth(classes(strip));
                    strip = parentElement(strip);
                }
                const wraps = strip !== null && /flex-wrap|flex-col|grid/.test(classes(strip));
                if (!keeps && !wraps) found.push(`${where(node)} tab shrinks below its label`);
                if (strip && isUnderlineTab(own) && !stripCopes(strip)) {
                    found.push(`${where(strip)} tab strip neither scrolls nor wraps`);
                }
            } else if (isCrushingPill(node, own)) {
                const strip = parentElement(node);
                const wraps = strip !== null && /flex-wrap|flex-col|grid/.test(classes(strip));
                if (!wraps) found.push(`${where(node)} option cuts its label to share the row - use SegmentedControl`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe("tab strips", () => {
    it("scroll or wrap, and never squeeze a tab below its label", () => {
        const files = ROOTS.flatMap((root) => [...sources(root)]);
        expect(files.length).toBeGreaterThan(500);
        expect(files.flatMap((file) => crushedTabStrips(file, readFileSync(file, "utf8")))).toEqual([]);
    });

    it("catches what it is for", () => {
        const button = (cls: string) => `<button role="tab" className="${cls}">A long label</button>`;
        const strip = (open: string, close: string, cls: string) =>
            `const x = (<>${open}{tabs.map((t) => (${button(cls)}))}${close}</>);`;

        // A tablist that cannot hold its tabs.
        expect(crushedTabStrips("x.tsx", strip(`<div role="tablist" className="flex gap-1">`, "</div>", "shrink-0"))).toHaveLength(1);
        // A tab that can shrink, and the exact classes that crushed the UPS tabs.
        expect(crushedTabStrips("x.tsx", strip(`<ScrollRow role="tablist" className="flex">`, "</ScrollRow>", "px-3"))).toHaveLength(1);
        expect(
            crushedTabStrips("x.tsx", strip(`<ScrollRow role="tablist" className="flex">`, "</ScrollRow>", "min-w-0 flex-1 truncate"))
        ).toHaveLength(1);
        // The underline strip that hid the last tabs.
        const underline = `const x = (<div className="flex gap-1 border-b border-border">{tabs.map((t) => (<button className="-mb-px border-b-2 px-3">{t}</button>))}</div>);`;
        expect(crushedTabStrips("x.tsx", underline)).toHaveLength(2);
        // A hand-drawn segmented control with no tab role at all.
        const pills = (row: string) =>
            `const x = (<div className="${row}">{tabs.map((t) => (<button aria-pressed={t === on} className="min-w-0 flex-1 truncate rounded px-2">{t}</button>))}</div>);`;
        expect(crushedTabStrips("x.tsx", pills("flex gap-0.5 rounded-md bg-muted p-0.5"))).toHaveLength(1);

        // Each of them done right.
        expect(crushedTabStrips("x.tsx", strip(`<ScrollRow role="tablist" className="flex">`, "</ScrollRow>", "shrink-0"))).toEqual([]);
        expect(crushedTabStrips("x.tsx", strip(`<div role="tablist" className="flex flex-wrap">`, "</div>", "px-3"))).toEqual([]);
        expect(crushedTabStrips("x.tsx", pills("flex flex-wrap gap-1"))).toEqual([]);
        expect(
            crushedTabStrips(
                "x.tsx",
                underline
                    .replace('<div className="flex', '<ScrollRow className="flex')
                    .replace("</div>", "</ScrollRow>")
                    .replace("-mb-px border-b-2", "-mb-px shrink-0 whitespace-nowrap border-b-2")
            )
        ).toEqual([]);
        // A name in a list row truncating is not a tab.
        expect(
            crushedTabStrips("x.tsx", `const x = (<li className="flex">{rows.map((r) => (<a href="/x" className="min-w-0 flex-1 truncate">{r}</a>))}</li>);`)
        ).toEqual([]);
    });
});

describe("SegmentedControl", () => {
    const UPS = ["Overview", "Energy", "Power", "Battery", "Events", "Commands", "Variables", "Settings"];
    const options = UPS.map((label) => ({ value: label.toLowerCase(), label }));

    afterEach(cleanup);

    it("is a scrolling track whose options keep their labels' width", () => {
        render(<SegmentedControl aria-label="UPS sections" value="overview" onValueChange={() => {}} options={options} />);
        const track = screen.getByRole("radiogroup", { name: "UPS sections" });
        expect(track.hasAttribute("data-scroll-row")).toBe(true);
        expect(track.className).toMatch(/\boverflow-x-auto\b/);
        // Kept inside a narrow column, so what does not fit scrolls instead of
        // pushing the screen wider.
        expect(track.className).toMatch(/\bmax-w-full\b/);
        const radios = screen.getAllByRole("radio");
        expect(radios.map((radio) => radio.textContent)).toEqual(UPS);
        for (const radio of radios) {
            const names = radio.className.split(/\s+/);
            expect(names).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
            // What crushed the UPS tabs: an option allowed to shrink and cut its label.
            expect(names).not.toContain("truncate");
            expect(names).not.toContain("min-w-0");
            // On a wide screen the options still share the width when they fit.
            expect(names).toEqual(expect.arrayContaining(["flex-1", "basis-auto"]));
        }
    });

    it("scrolls the chosen option into view on a narrow screen", () => {
        // jsdom lays nothing out, so the phone is described: a 360px track
        // holding 800px of options, with Variables at 600-690px.
        const restore = describeLayout((element) => {
            if (element.hasAttribute("data-scroll-row")) return { left: 0, right: 360, scroll: 800, client: 360 };
            if (element.textContent === "Variables") return { left: 600, right: 690, scroll: 90, client: 90 };
            return null;
        });
        try {
            render(<SegmentedControl aria-label="UPS sections" value="variables" onValueChange={() => {}} options={options} />);
            const track = screen.getByRole("radiogroup");
            // Its right edge clear of the faded end (24px).
            expect(track.scrollLeft).toBe(690 - (360 - 24));
        } finally {
            restore();
        }
    });
});

type Box = { left: number; right: number; scroll: number; client: number };

/** Give elements a layout jsdom does not compute; returns the undo. */
function describeLayout(box: (element: HTMLElement) => Box | null): () => void {
    const proto = HTMLElement.prototype;
    const saved = ["scrollWidth", "clientWidth", "getBoundingClientRect"].map(
        (key) => [key, Object.getOwnPropertyDescriptor(proto, key)] as const
    );
    Object.defineProperty(proto, "scrollWidth", {
        configurable: true,
        get(this: HTMLElement) {
            return box(this)?.scroll ?? 0;
        }
    });
    Object.defineProperty(proto, "clientWidth", {
        configurable: true,
        get(this: HTMLElement) {
            return box(this)?.client ?? 0;
        }
    });
    Object.defineProperty(proto, "getBoundingClientRect", {
        configurable: true,
        value(this: HTMLElement) {
            const at = box(this) ?? { left: 0, right: 0 };
            return { left: at.left, right: at.right, top: 0, bottom: 0, width: at.right - at.left, height: 0, x: at.left, y: 0 };
        }
    });
    return () => {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(proto, key, descriptor);
            else delete (proto as unknown as Record<string, unknown>)[key];
        }
    };
}
