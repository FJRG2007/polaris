// @vitest-environment jsdom

/**
 * Find in a terminal: typing searches as it goes, Enter and Shift+Enter step
 * through the matches, the case toggle searches again, Escape closes, the count
 * follows the addon, and the highlights go when the bar does.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));

const { TerminalFindBar } = await import("@/app/(app)/apps/deploy/terminal-find-bar");
const { isFindShortcut } = await import("@/app/(app)/apps/deploy/terminal-panel");

function fakeSearch() {
    let listener: ((results: { resultIndex: number; resultCount: number }) => void) | null = null;
    return {
        findNext: vi.fn(() => true),
        findPrevious: vi.fn(() => true),
        clearDecorations: vi.fn(),
        onDidChangeResults: vi.fn((next: typeof listener) => {
            listener = next;
            return { dispose: () => (listener = null) };
        }),
        emit: (resultIndex: number, resultCount: number) => act(() => listener?.({ resultIndex, resultCount }))
    };
}

afterEach(() => cleanup());

describe("terminal find bar", () => {
    it("searches while typing, steps with Enter and Shift+Enter, and shows the count", () => {
        const search = fakeSearch();
        render(<TerminalFindBar search={search} onClose={vi.fn()} />);
        const input = screen.getByRole("textbox", { name: "terminal.find.label" });
        expect(document.activeElement).toBe(input);

        fireEvent.change(input, { target: { value: "error" } });
        expect(search.findNext).toHaveBeenLastCalledWith(
            "error",
            expect.objectContaining({ incremental: true, caseSensitive: false, decorations: expect.any(Object) })
        );
        search.emit(0, 3);
        expect(screen.getByText(/terminal.find.count/).textContent).toContain('"current":1,"total":3');

        fireEvent.keyDown(input, { key: "Enter" });
        expect(search.findNext).toHaveBeenLastCalledWith("error", expect.objectContaining({ incremental: false }));
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
        expect(search.findPrevious).toHaveBeenCalledWith("error", expect.objectContaining({ incremental: false }));
        fireEvent.click(screen.getByRole("button", { name: "terminal.find.previous" }));
        expect(search.findPrevious).toHaveBeenCalledTimes(2);
        fireEvent.click(screen.getByRole("button", { name: "terminal.find.next" }));
        expect(search.findNext).toHaveBeenCalledTimes(3);
    });

    it("searches again with the case toggle, and says when nothing matches", () => {
        const search = fakeSearch();
        render(<TerminalFindBar search={search} onClose={vi.fn()} />);
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Error" } });
        const toggle = screen.getByRole("button", { name: "terminal.find.matchCase" });
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-pressed")).toBe("true");
        expect(search.findNext).toHaveBeenLastCalledWith("Error", expect.objectContaining({ caseSensitive: true }));
        search.emit(-1, 0);
        expect(screen.getByText("terminal.find.none")).toBeTruthy();
        expect((screen.getByRole("button", { name: "terminal.find.next" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("says when there are more matches than it highlights", () => {
        const search = fakeSearch();
        render(<TerminalFindBar search={search} onClose={vi.fn()} />);
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "a" } });
        search.emit(-1, 1000);
        expect(screen.getByText(/terminal.find.tooMany/)).toBeTruthy();
    });

    it("closes on Escape and on its button, and clears the highlights when it goes", () => {
        const search = fakeSearch();
        const onClose = vi.fn();
        const view = render(<TerminalFindBar search={search} onClose={onClose} />);
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
        fireEvent.click(screen.getByRole("button", { name: "terminal.find.close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
        search.clearDecorations.mockClear();
        view.unmount();
        expect(search.clearDecorations).toHaveBeenCalled();
    });

    it("opens on Ctrl+Shift+F or Cmd+Shift+F, never on a plain Ctrl+F the shell uses", () => {
        const key = (over: Partial<KeyboardEvent>) => ({ key: "F", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });
        expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(true);
        expect(isFindShortcut(key({ metaKey: true, shiftKey: true, key: "f" }))).toBe(true);
        expect(isFindShortcut(key({ ctrlKey: true, key: "f" }))).toBe(false);
        expect(isFindShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    });
});
