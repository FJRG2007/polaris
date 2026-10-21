// @vitest-environment jsdom
/**
 * Only the content area under the header scrolls; the window never does.
 *
 * The bug this exists for: the shell scrolled the document under a sticky
 * header, so the window's scrollbar ran the full height of the screen, up
 * beside the header. With the content area as the scroller, anything that
 * measured "the page" through `window` measures nothing - so the sweep below
 * keeps those readings out of the screens that render inside the shell.
 */

import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { AppShell, shellScroller } from "@polaris/ui";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(cleanup);

/** Every app's sources, the dashboard's own included. The extension is not
 *  drawn inside the shell. */
const APPS = join(__dirname, "..", "..", "..");

/** Readings that only make sense when the window is what scrolls. */
const WINDOW_SCROLL = [
    "window.scrollY",
    "window.pageYOffset",
    "useWindowVirtualizer",
    "h-below-header",
    "top-[calc(var(--header-height)"
];

async function sources(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(
        entries.map((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
            return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
        })
    );
    return nested.flat();
}

describe("the shell scrolls its content, not the window", () => {
    it("is exactly the viewport, with the content area as the one scroller", () => {
        render(
            <AppShell switcher={null} account={null} sidebar={<nav>rail</nav>}>
                <p>content</p>
            </AppShell>
        );
        const main = screen.getByRole("main");
        const shell = main.parentElement!.parentElement!;
        expect(shell.className).toContain("h-dvh");
        expect(shell.className).toContain("overflow-hidden");
        expect(shell.className).not.toContain("min-h-dvh");
        // The row between header and bottom edge may shrink below its content.
        expect(main.parentElement!.className).toContain("min-h-0");
        expect(main.className).toContain("overflow-y-auto");
        expect(main.hasAttribute("data-shell-scroll")).toBe(true);
        expect(screen.getByRole("banner").className).not.toContain("sticky");
        expect(shellScroller(screen.getByText("content"))).toBe(main);
        expect(shellScroller(document.body)).toBeNull();
    });

    it("has no screen measuring against a window that does not scroll", async () => {
        const apps = await readdir(APPS, { withFileTypes: true });
        const roots = apps
            .filter((entry) => entry.isDirectory() && entry.name !== "extension")
            .map((entry) => join(APPS, entry.name, "src"));
        const files = (await Promise.all(roots.map(sources))).flat();
        expect(files.length).toBeGreaterThan(100);
        const offenders: string[] = [];
        for (const file of files) {
            const text = await readFile(file, "utf8");
            for (const needle of WINDOW_SCROLL) {
                if (text.includes(needle)) offenders.push(`${file}: ${needle}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
