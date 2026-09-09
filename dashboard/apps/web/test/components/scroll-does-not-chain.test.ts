import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";

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
 * That was fixed in the four shared components and reported again the same week,
 * from Mail - because the rule was never about those four. Every screen in this
 * app builds its own panes: Mail is a rail, a list and a reading pane side by
 * side, and each of them scrolls. None of them said so, so reaching the end of
 * the message list dragged the whole page underneath it.
 *
 * So the rule is the whole tree, and it is checked here rather than reviewed:
 * **a class list that scrolls vertically has to say that its scrolling stays
 * there.** A new pane is this bug again, and it is invisible until somebody's
 * pointer happens to be over it.
 */
describe("a panel over the page does not scroll the page", () => {
    const roots = [
        join(__dirname, "..", ".."),
        join(__dirname, "..", "..", "..", "..", "packages", "ui", "src")
    ];

    /** Every source file under a root, minus this suite's own siblings: a test
     *  that quotes a class list is describing one, not drawing it. */
    function sources(dir: string): string[] {
        const found: string[] = [];
        for (const entry of readdirSync(dir)) {
            if (entry === "node_modules" || entry === ".next" || entry === "test") continue;
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) {
                found.push(...sources(path));
                continue;
            }
            if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) found.push(path);
        }
        return found;
    }

    /** What Tailwind calls a vertical scroller. */
    const SCROLLS = /\b(?:overflow-y-auto|overflow-y-scroll|overflow-auto)\b/;

    /** Every string a class list can be written as: the double quotes a `className`
     *  usually takes, and the other two quotes as well - a pane whose classes are
     *  assembled in a template literal is the same pane, and a rule that only reads
     *  one kind of quote is a rule somebody steps over without knowing it. */
    const LITERALS = /"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g;

    /** The file with its comments taken out. A note that quotes `overflow-y-auto`
     *  to explain the rule is backticked prose, not a pane - and reading it as one
     *  is how a guard starts failing on the file that documents it. */
    function code(source: string): string {
        return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    }

    it("every scrolling class list in the app contains its own scrolling", () => {
        const loose: string[] = [];
        for (const root of roots) {
            for (const path of sources(root)) {
                const source = code(readFileSync(path, "utf8"));
                if (!SCROLLS.test(source)) continue;
                for (const match of source.matchAll(LITERALS)) {
                    const classes = match[1] ?? match[2] ?? match[3] ?? "";
                    if (!SCROLLS.test(classes)) continue;
                    if (classes.includes("overscroll-")) continue;
                    loose.push(`${path.split(/[/\\]/).slice(-2).join("/")}: ${classes}`);
                }
            }
        }
        expect(loose).toEqual([]);
    });
});
