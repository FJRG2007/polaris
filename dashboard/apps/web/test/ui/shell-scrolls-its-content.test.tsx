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
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    history.replaceState(null, "", "/");
});

/** Frames run when the test says so, not on a timer. */
function stubFrames() {
    const queue = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        queue.set(++next, callback);
        return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queue.delete(id));
    return () =>
        act(() => {
            const due = [...queue.values()];
            queue.clear();
            for (const callback of due) callback(0);
        });
}

function renderShell() {
    render(
        <AppShell switcher={null} account={null}>
            <p>content</p>
        </AppShell>
    );
    return screen.getByRole("main");
}

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

    it("puts the content back where it was when the user goes back to an address", () => {
        const frame = stubFrames();
        history.replaceState(null, "", "/admin/users?page=2");
        const main = renderShell();
        main.scrollTop = 840;
        fireEvent.scroll(main);
        frame();

        history.pushState(null, "", "/admin/users/42");
        main.scrollTop = 0;
        fireEvent.scroll(main);
        frame();

        history.back = () => undefined;
        history.replaceState(null, "", "/admin/users?page=2");
        fireEvent.popState(window);
        frame();
        expect(main.scrollTop).toBe(840);
    });

    it("leaves the content alone on a return to an address it never saw", () => {
        const frame = stubFrames();
        const main = renderShell();
        main.scrollTop = 120;
        history.replaceState(null, "", "/elsewhere");
        fireEvent.popState(window);
        frame();
        expect(main.scrollTop).toBe(120);
    });

    it("stops restoring the moment the user scrolls on their own", () => {
        const frame = stubFrames();
        history.replaceState(null, "", "/list");
        const main = renderShell();
        main.scrollTop = 500;
        fireEvent.scroll(main);
        frame();
        history.replaceState(null, "", "/record");
        main.scrollTop = 0;
        history.replaceState(null, "", "/list");
        fireEvent.popState(window);
        fireEvent.wheel(window);
        frame();
        expect(main.scrollTop).toBe(0);
    });

    it("sends a scrolling key to the content when nothing has focus", () => {
        const main = renderShell();
        expect(main.tabIndex).toBe(-1);
        expect(document.activeElement).toBe(document.body);
        fireEvent.keyDown(document.body, { key: "PageDown" });
        expect(document.activeElement).toBe(main);
    });

    it("leaves focus where it is when something already has it", () => {
        render(
            <AppShell switcher={null} account={null}>
                <input aria-label="field" />
            </AppShell>
        );
        const field = screen.getByLabelText("field");
        field.focus();
        fireEvent.keyDown(field, { key: " " });
        expect(document.activeElement).toBe(field);
        fireEvent.keyDown(document.body, { key: "a" });
        expect(document.activeElement).toBe(field);
    });
});
