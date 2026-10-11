// @vitest-environment jsdom

/**
 * Narrowing a log: level chips, text search with highlights and stepping, and
 * folded repeats - and that the level choice outlives a reload.
 */

import { MessagesWrapper } from "../setup/i18n";
import { LogViewer } from "@/components/log-viewer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);
beforeEach(() => {
    const store = new Map<string, string>();
    const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => [...store.keys()][index] ?? null,
        get length() {
            return store.size;
        }
    };
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
});

const LOG = [
    "[12:00:01] [Server thread/INFO]: Starting minecraft server",
    "[12:00:02] [Server thread/WARN]: Can't keep up!",
    "[12:00:03] [Server thread/ERROR]: Encountered an unexpected exception",
    "[12:00:04] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]",
    "[12:00:05] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]",
    "[12:00:06] [Server thread/INFO]: [Rcon: Changed display name to Alex for polaris.line.01]"
].join("\n");

function rows(container: HTMLElement): string[] {
    return [...container.querySelectorAll("[data-row]")].map((row) => row.textContent ?? "");
}

function chip(name: RegExp): HTMLElement {
    return screen.getByRole("button", { name });
}

describe("log filters", () => {
    it("counts each level and folds the repeated line", () => {
        const { container } = render(<LogViewer log={LOG} name="mc" searchable />, {
            wrapper: MessagesWrapper
        });
        expect(chip(/^Errors/).textContent).toContain("1");
        expect(chip(/^Warnings/).textContent).toContain("1");
        expect(chip(/^Info/).textContent).toContain("4");
        expect(rows(container)).toHaveLength(4);
        expect(screen.getByText("x3")).toBeTruthy();
    });

    it("shows every repeat once folding is switched off", () => {
        const { container } = render(<LogViewer log={LOG} name="mc" />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(chip(/Collapse repeats/));
        expect(rows(container)).toHaveLength(6);
    });

    it("filters by several levels at once and remembers the choice", () => {
        const { container, unmount } = render(<LogViewer log={LOG} name="mc" />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(chip(/^Info/));
        expect(rows(container)).toHaveLength(2);
        expect(chip(/^Info/).getAttribute("aria-pressed")).toBe("false");
        unmount();

        const again = render(<LogViewer log={LOG} name="mc" />, { wrapper: MessagesWrapper });
        expect(rows(again.container)).toHaveLength(2);
    });

    it("keeps a separate choice per viewer and survives a corrupt entry", () => {
        window.localStorage.setItem("polaris.logViewer.other", "{not json");
        const { container } = render(<LogViewer log={LOG} name="other" />, {
            wrapper: MessagesWrapper
        });
        expect(rows(container)).toHaveLength(4);
    });

    it("never filters down to nothing when the last level is switched off", () => {
        const { container } = render(<LogViewer log={LOG} name="mc" />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(chip(/^Info/));
        fireEvent.click(chip(/^Warnings/));
        fireEvent.click(chip(/^Errors/));
        expect(rows(container)).toHaveLength(4);
    });

    it("highlights matches and steps through them", () => {
        const { container } = render(<LogViewer log={LOG} name="mc" searchable />, {
            wrapper: MessagesWrapper
        });
        const input = screen.getByRole("textbox");
        fireEvent.change(input, { target: { value: "server" } });
        expect(container.querySelectorAll("mark").length).toBeGreaterThan(0);
        expect(screen.getByText(/matches?$/)).toBeTruthy();

        // Showing every line keeps the matches in context.
        fireEvent.click(screen.getByRole("button", { name: "Only show matching lines" }));
        expect(rows(container).length).toBe(4);

        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        expect(screen.getByText(/^1 of \d+$/)).toBeTruthy();
        fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
        expect(screen.getByText(/^(\d+) of \1$/)).toBeTruthy();
    });

    it("keeps the live tail coming in while filtered", () => {
        const { container, rerender } = render(<LogViewer log={LOG} name="mc" />, {
            wrapper: MessagesWrapper
        });
        fireEvent.click(chip(/^Info/));
        rerender(
            <LogViewer log={`${LOG}\n[12:00:07] [Server thread/ERROR]: second failure`} name="mc" />
        );
        expect(rows(container).at(-1)).toContain("second failure");
        expect(chip(/^Errors/).textContent).toContain("2");
    });

    it("keeps the repeat count when only a later line of the block matches", () => {
        const block = ["client started", "client shutting down"];
        const log = ["boot", ...block, ...block, ...block].join("\n");
        const { container } = render(<LogViewer log={log} name="mc" searchable />, {
            wrapper: MessagesWrapper
        });
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "shutting" } });
        expect(rows(container)).toHaveLength(1);
        expect(screen.getByText("x3")).toBeTruthy();
    });

    it("keeps the active match on its line as the tail passes the row cap", () => {
        const lines = (count: number) =>
            Array.from(
                { length: count },
                (_, index) => `line ${index}${index % 500 === 0 ? " needle" : ""}`
            ).join("\n");
        const { container, rerender } = render(
            <LogViewer log={lines(3000)} name="cap" searchable />,
            {
                wrapper: MessagesWrapper
            }
        );
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "needle" } });
        fireEvent.click(screen.getByRole("button", { name: "Only show matching lines" }));
        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        fireEvent.click(screen.getByRole("button", { name: "Next match" }));
        const marked = () =>
            container.querySelector('[data-row][class*="bg-yellow-400/10"]')?.textContent ?? "";
        expect(marked()).toContain("line 500 needle");

        rerender(<LogViewer log={lines(3100)} name="cap" searchable />);
        expect(marked()).toContain("line 500 needle");
        expect(screen.getByText(/^1 of 6$/)).toBeTruthy();
    });
});
