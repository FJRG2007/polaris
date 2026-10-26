// @vitest-environment jsdom

/**
 * A field a menu put on screen keeps its focus while the menu is on its way out.
 *
 * On a slow first render the menu was still there when the field took focus, took
 * it back, and the blur threw the row away - a new folder's input vanished the
 * first time and worked the second.
 */

import { useState } from "react";
import { useDeferredFocus } from "../src/lib/use-deferred-focus";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function Draft({ inMenu = false }: { inMenu?: boolean }) {
    const [open, setOpen] = useState(true);
    const field = useDeferredFocus<HTMLInputElement>();
    if (!open) return <p>gone</p>;
    const input = <input ref={field} aria-label="Folder name" onBlur={() => setOpen(false)} />;
    return (
        <>
            <div role="menu">
                <button type="button" role="menuitem">
                    Folder
                </button>
                {inMenu ? input : null}
            </div>
            {inMenu ? null : input}
            <button type="button">Elsewhere</button>
        </>
    );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    vi.useRealTimers();
    cleanup();
});

function steal(from: HTMLElement, to: HTMLElement | null) {
    fireEvent.focusOut(from, { relatedTarget: to });
    to?.focus();
}

describe("a field a menu put on screen", () => {
    it("survives the closing menu taking focus back, and gets it again", () => {
        render(<Draft />);
        vi.advanceTimersByTime(0);
        const field = screen.getByRole("textbox", { name: "Folder name" });
        expect(document.activeElement).toBe(field);
        steal(field, screen.getByRole("menuitem"));
        vi.advanceTimersByTime(0);
        expect(screen.queryByText("gone")).toBeNull();
        expect(document.activeElement).toBe(field);
    });

    it("survives focus dropping to the page itself", () => {
        render(<Draft />);
        vi.advanceTimersByTime(0);
        steal(screen.getByRole("textbox"), null);
        expect(screen.queryByText("gone")).toBeNull();
    });

    it("lets a real move elsewhere through, so blur still commits or cancels", () => {
        render(<Draft />);
        vi.advanceTimersByTime(0);
        steal(screen.getByRole("textbox"), screen.getByRole("button", { name: "Elsewhere" }));
        expect(screen.getByText("gone")).toBeTruthy();
    });

    it("stops guarding once somebody types, so Enter-to-blur commits at once", () => {
        render(<Draft />);
        vi.advanceTimersByTime(0);
        const field = screen.getByRole("textbox");
        fireEvent.keyDown(field, { key: "a" });
        steal(field, null);
        expect(screen.getByText("gone")).toBeTruthy();
    });

    it("stops guarding after the menu has had its time", () => {
        render(<Draft />);
        vi.advanceTimersByTime(0);
        vi.advanceTimersByTime(700);
        steal(screen.getByRole("textbox"), null);
        expect(screen.getByText("gone")).toBeTruthy();
    });

    it("does not guard a field that lives inside the menu", () => {
        render(<Draft inMenu />);
        vi.advanceTimersByTime(0);
        steal(screen.getByRole("textbox"), screen.getByRole("menuitem"));
        expect(screen.getByText("gone")).toBeTruthy();
    });
});
