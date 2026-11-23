// @vitest-environment jsdom

/**
 * The desktop app's window buttons take a band across the top right of the
 * window (BUG-0025). A menu, a list or a calendar that opens near the top edge
 * flips or shifts by its collision padding, so that padding carries the band;
 * and a page copy of a control the top bar holds switches at the bar's own
 * width, which `TitlebarWidths` puts on `<html>`.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TitlebarWidths } from "../src/shell/titlebar-widths";
import { clearOfWindowControls, windowControlsHeight } from "../src/shell/window-controls";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (navigator as { windowControlsOverlay?: unknown; }).windowControlsOverlay;
});

function overlay(visible: boolean, height: number) {
    Object.defineProperty(navigator, "windowControlsOverlay", {
        configurable: true,
        value: { visible, getTitlebarAreaRect: () => ({ height }) }
    });
}

describe("a popper's collision padding", () => {
    it("is unchanged in a browser", () => {
        expect(windowControlsHeight()).toBe(0);
        expect(clearOfWindowControls(8)).toBe(8);
        expect(clearOfWindowControls({ left: 4 })).toEqual({ left: 4 });
    });

    it("is unchanged while the desktop app's overlay is off", () => {
        overlay(false, 47);
        expect(windowControlsHeight()).toBe(0);
        expect(clearOfWindowControls(16)).toBe(16);
    });

    it("takes the window buttons' band at the top in the desktop app", () => {
        overlay(true, 47);
        expect(windowControlsHeight()).toBe(47);
        expect(clearOfWindowControls(8)).toEqual({ top: 55, right: 8, bottom: 8, left: 8 });
        expect(clearOfWindowControls({ bottom: 4 })).toEqual({ bottom: 4, top: 47 });
    });

    const ROOTS = [join(__dirname, "../src/components"), join(__dirname, "../../diagrams/src/editor/components")];
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : []
        );
    const PRIMITIVE = /import \* as (\w+) from "@radix-ui\/react-(popover|dropdown-menu|context-menu|select)"/;

    it("goes through clearOfWindowControls on every popper", () => {
        let found = 0;
        for (const path of ROOTS.flatMap(walk)) {
            const source = readFileSync(path, "utf8");
            const primitive = source.match(PRIMITIVE);
            if (!primitive) continue;
            const opening = new RegExp(`<${primitive[1]}\\.(Sub)?Content\\b([\\s\\S]*?)>`, "g");
            // A wrapper that only forwards its props is checked where it is used.
            const wrappers = (tag: string, at: number) => {
                if (/collisionPadding=/.test(tag) || !/\{\.\.\.props\}/.test(tag)) return [tag];
                const name = [...source.slice(0, at).matchAll(/const (\w+) = forwardRef/g)].at(-1)?.[1];
                expect(name, path).toBeDefined();
                return [...source.matchAll(new RegExp(`<${name}\\b([\\s\\S]*?)>`, "g"))].map((use) => use[0]);
            };
            for (const match of source.matchAll(opening)) {
                for (const tag of wrappers(match[0], match.index)) {
                    found += 1;
                    expect(tag, path).toMatch(/collisionPadding=\{[^}]*clearOfWindowControls\(/);
                }
            }
        }
        expect(found).toBeGreaterThanOrEqual(10);
    });
});

describe("TitlebarWidths", () => {
    it("lists on <html> the screens the bar's frame is narrower than, and clears them on unmount", () => {
        let report: ((entries: { contentRect: { width: number; }; }[]) => void) | undefined;
        let observed: Element | undefined;
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: typeof report) {
                    report = callback;
                }
                observe(target: Element) {
                    observed = target;
                }
                disconnect() {}
            }
        );
        const { unmount } = render(
            <div className="app-titlebar-frame">
                <TitlebarWidths />
            </div>
        );
        expect(observed?.className).toBe("app-titlebar-frame");
        report!([{ contentRect: { width: 900 } }]);
        expect(document.documentElement.dataset.titlebarUnder).toBe("lg xl 2xl");
        report!([{ contentRect: { width: 700 } }]);
        expect(document.documentElement.dataset.titlebarUnder).toBe("md lg xl 2xl");
        report!([{ contentRect: { width: 1600 } }]);
        expect(document.documentElement.dataset.titlebarUnder).toBe("");
        unmount();
        expect(document.documentElement.dataset.titlebarUnder).toBeUndefined();
    });
});
