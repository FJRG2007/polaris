// @vitest-environment jsdom

/**
 * In the desktop app the window's minimize, maximize and close buttons are
 * drawn over the top right of the page. The picture viewer fills the window,
 * and its zoom out, zoom level, zoom in, menu and close sat right there, under
 * them (BUG-0025). Its toolbar starts below the band they take, and the band
 * above it is the viewer's own dimmed ground rather than a strip of the page.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageViewer, type ViewerLabels } from "../src/image-viewer/image-viewer";

const labels: ViewerLabels = {
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    more: "More for this picture",
    close: "Close",
    previous: "Previous",
    next: "Next",
    position: (index, count) => `${index} of ${count}`
};

beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: vi.fn(() => ({ finished: Promise.resolve() }))
    });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function classesOf(element: Element | null): string[] {
    return (element?.getAttribute("class") ?? "").split(/\s+/);
}

describe("the picture viewer under the desktop app's window buttons", () => {
    it("starts its toolbar below the band the buttons take", () => {
        render(
            <ImageViewer
                image={{ url: "/files/photo.png", name: "photo.png" }}
                onClose={() => {}}
                origin={() => null}
                labels={labels}
            />
        );
        const viewer = screen.getByRole("dialog");
        expect(classesOf(viewer)).toContain("top-[var(--window-controls-height)]");
        for (const name of [labels.zoomOut, labels.zoomIn, labels.close]) {
            const control = screen.getByRole("button", { name });
            // Inside the viewer's own box, which is what was moved down: no
            // ancestor between them pins itself back to the top.
            expect(viewer.contains(control)).toBe(true);
            for (let node = control.parentElement; node && node !== viewer; node = node.parentElement) {
                expect(classesOf(node).some((name) => /^(fixed|top-0|inset-0)$/.test(name))).toBe(false);
            }
        }
    });

    it("fills the band above it with its own ground", () => {
        render(
            <ImageViewer
                image={{ url: "/files/photo.png", name: "photo.png" }}
                onClose={() => {}}
                origin={() => null}
                labels={labels}
            />
        );
        const band = [...screen.getByRole("dialog").querySelectorAll("[aria-hidden]")].find((node) =>
            classesOf(node).includes("h-[var(--window-controls-height)]")
        );
        expect(band).toBeDefined();
        expect(classesOf(band!)).toEqual(expect.arrayContaining(["fixed", "top-0", "inset-x-0", "bg-background/95"]));
    });
});
