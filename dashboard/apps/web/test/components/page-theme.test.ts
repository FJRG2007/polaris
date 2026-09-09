import { pageIsDark } from "@/lib/page-theme";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which way round the page is, for the code that has to be told.
 *
 * A canvas and an embedded editor cannot read a CSS variable, so they are handed
 * the word - and three components were reading a `data-theme` attribute Polaris
 * has never written. It is null on every page, so every one of them concluded
 * "light", which on the default theme is exactly backwards: a white spreadsheet
 * and a white canvas in the middle of a dark screen.
 *
 * The theme is a class on the root. Dark carries none at all, which is the case
 * worth pinning: "no class" has to mean dark rather than "nothing chosen".
 */
describe("which way round the page is", () => {
    const withRoot = (classes: string, prefersDark = true): void => {
        vi.stubGlobal("document", { documentElement: { classList: tokens(classes) } });
        vi.stubGlobal("window", {
            matchMedia: (query: string) => ({ matches: query.includes("dark") && prefersDark })
        });
    };

    /** Just enough of a `DOMTokenList` for the question being asked. */
    const tokens = (classes: string) => {
        const held = new Set(classes.split(" ").filter(Boolean));
        return { contains: (name: string) => held.has(name) };
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("is dark when nothing says otherwise, because dark is the default", () => {
        withRoot("");
        expect(pageIsDark()).toBe(true);
    });

    it("is light when the light class is on", () => {
        withRoot("light");
        expect(pageIsDark()).toBe(false);
    });

    it("follows the browser when the page is set to", () => {
        withRoot("system", true);
        expect(pageIsDark()).toBe(true);
        withRoot("system", false);
        expect(pageIsDark()).toBe(false);
    });

    it("stays dark on a browser that cannot be asked", () => {
        // No `matchMedia` at all. Dark is what the page is without one, so
        // answering light here would be the same backwards default in a
        // different disguise.
        vi.stubGlobal("document", { documentElement: { classList: tokens("system") } });
        vi.stubGlobal("window", {});
        expect(pageIsDark()).toBe(true);
    });
});

/**
 * Watching the theme, and the loop that froze a spreadsheet.
 *
 * What is observed is the class attribute of the root element - and the listener
 * that needed this most is an embedded spreadsheet whose own dark mode writes a
 * class onto that same element. Told about every mutation, it answered each one
 * with a write, and each write was another mutation: a synchronous loop with no
 * end, which a browser reports as a page that has stopped responding rather than
 * as an error anybody can read.
 *
 * The fix is that a change is reported, not a mutation. These pin it from both
 * sides: a write that leaves the theme where it was says nothing, and a listener
 * that writes to the page while being told cannot re-enter.
 */
describe("watching the theme", () => {
    /** A root element whose classes can be rewritten, with the observers that are
     *  watching it - a MutationObserver, near enough for what is being asked. */
    const page = (classes: string) => {
        let held = new Set(classes.split(" ").filter(Boolean));
        const watchers: (() => void)[] = [];
        const classList = {
            contains: (name: string) => held.has(name),
            /** Any write to the attribute notifies, whether or not it changed
             *  anything - which is what a real MutationObserver does. */
            set: (next: string) => {
                held = new Set(next.split(" ").filter(Boolean));
                for (const watcher of [...watchers]) watcher();
            },
            /** What an embedded editor's own dark mode does: add its class
             *  beside whatever is already there, rather than replace it. */
            add: (name: string) => {
                held.add(name);
                for (const watcher of [...watchers]) watcher();
            }
        };
        vi.stubGlobal("document", { documentElement: { classList } });
        vi.stubGlobal("window", {
            matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
        });
        vi.stubGlobal(
            "MutationObserver",
            class {
                constructor(private readonly run: () => void) {}
                public observe(): void {
                    watchers.push(this.run);
                }
                public disconnect(): void {
                    const at = watchers.indexOf(this.run);
                    if (at >= 0) watchers.splice(at, 1);
                }
            }
        );
        return classList;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("says nothing when a write leaves the theme where it was", async () => {
        const { watchPageTheme } = await import("@/lib/page-theme");
        const root = page("");
        const told = vi.fn();
        const stop = watchPageTheme(told);
        // Something else on the page writes the attribute. The theme is the same
        // either side of it, so there is nothing to report.
        root.set("scroll-locked");
        root.set("scroll-locked menu-open");
        expect(told).not.toHaveBeenCalled();
        stop();
    });

    it("reports a real change once", async () => {
        const { watchPageTheme } = await import("@/lib/page-theme");
        const root = page("");
        const told = vi.fn();
        const stop = watchPageTheme(told);
        root.set("light");
        expect(told.mock.calls).toEqual([[false]]);
        root.set("light extra");
        expect(told).toHaveBeenCalledTimes(1);
        stop();
    });

    it("does not re-enter a listener that writes to the page", async () => {
        // The spreadsheet: being told "dark" makes it write a class of its own,
        // onto the element being watched. Before this, that was an unbounded
        // loop; the test would hang rather than fail, so it is bounded here.
        const { watchPageTheme } = await import("@/lib/page-theme");
        const root = page("");
        let calls = 0;
        const stop = watchPageTheme((dark) => {
            calls += 1;
            if (calls > 50) throw new Error("watchPageTheme re-entered its own listener");
            root.add(dark ? "univer-dark" : "univer-light");
        });
        root.set("light");
        expect(calls).toBe(1);
        stop();
    });
});
