import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A panel over the page must not scroll the page.
 *
 * This shell scrolls the DOCUMENT: the header and the rail are sticky over it
 * and the content simply flows. That is the right shape for a page, and it has
 * one consequence nobody expects - a scroll that a panel cannot use is handed
 * up to the document underneath it.
 *
 * So putting the pointer on the rail and turning the wheel scrolled the whole
 * page, while the rail stayed exactly where it was, because the rail's entries
 * fit and there was nothing in it to scroll. It looks like a fixed panel, so it
 * has to behave like one. The same was true of every dialog (reaching the bottom
 * of a long one carried on into the page behind it), of the mobile drawer, and
 * of the select menu.
 *
 * `overscroll-contain` is the one thing that stops it, and it has to be on every
 * one of them - which is why this is a test rather than four fixes. A new panel
 * that scrolls is the same bug again, and it is invisible until somebody's
 * pointer happens to be over it.
 */
describe("a panel over the page does not scroll the page", () => {
    const ui = join(__dirname, "..", "..", "..", "..", "packages", "ui", "src");
    const read = (...path: string[]): string => readFileSync(join(ui, ...path), "utf8");

    const panels: [string, string[]][] = [
        ["the rail", ["shell", "app-shell.tsx"]],
        ["the mobile drawer", ["shell", "mobile-nav.tsx"]],
        ["a dialog", ["components", "dialog.tsx"]],
        ["a select menu", ["components", "select.tsx"]]
    ];

    it.each(panels)("%s contains its own scrolling", (_name, path) => {
        const source = read(...path);
        // Every class list in the file that scrolls vertically has to say so.
        const scrolling = [...source.matchAll(/"([^"]*overflow-y-auto[^"]*)"/g)].map(
            (match) => match[1] ?? ""
        );
        expect(scrolling.length).toBeGreaterThan(0);
        for (const classes of scrolling) {
            expect(classes, classes).toContain("overscroll-contain");
        }
    });
});
