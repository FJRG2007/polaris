// @vitest-environment jsdom

/**
 * A note raised while something is full screen (a terminal, a call, a
 * presentation) is drawn inside that element: the browser shows only the
 * fullscreen element's own tree, so a note left on the body is there and unseen.
 * When full screen ends the note goes back to the body.
 */

import { ToastProvider, useToast } from "../src/components/toast";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

function Raise() {
    const toast = useToast();
    return (
        <button type="button" onClick={() => toast.show({ title: "Copied" })}>
            raise
        </button>
    );
}

// jsdom has no Fullscreen API; the property is defined here and set per step.
let fullscreen: Element | null = null;
Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });

function goFullscreen(element: Element | null) {
    fullscreen = element;
    act(() => {
        document.dispatchEvent(new Event("fullscreenchange"));
    });
}

describe("notes while something is full screen", () => {
    afterEach(() => {
        cleanup();
        fullscreen = null;
    });

    it("draws a note inside the fullscreen element, and back on the body after", () => {
        render(
            <ToastProvider>
                <div role="dialog" data-testid="terminal">
                    <Raise />
                </div>
            </ToastProvider>
        );
        const terminal = screen.getByTestId("terminal");
        goFullscreen(terminal);
        fireEvent.click(screen.getByText("raise"));
        expect(terminal.contains(screen.getByText("Copied"))).toBe(true);

        goFullscreen(null);
        const note = screen.getByText("Copied");
        expect(terminal.contains(note)).toBe(false);
        expect(document.body.contains(note)).toBe(true);
    });

    it("moves a note already on screen into an element that goes full screen", () => {
        render(
            <ToastProvider>
                <div data-testid="terminal">
                    <Raise />
                </div>
            </ToastProvider>
        );
        fireEvent.click(screen.getByText("raise"));
        const terminal = screen.getByTestId("terminal");
        expect(terminal.contains(screen.getByText("Copied"))).toBe(false);
        goFullscreen(terminal);
        expect(terminal.contains(screen.getByText("Copied"))).toBe(true);
    });

    it("keeps the body for a fullscreen video, which draws no children", () => {
        render(
            <ToastProvider>
                <video data-testid="video" />
                <Raise />
            </ToastProvider>
        );
        goFullscreen(screen.getByTestId("video"));
        fireEvent.click(screen.getByText("raise"));
        expect(screen.getByTestId("video").contains(screen.getByText("Copied"))).toBe(false);
    });
});
