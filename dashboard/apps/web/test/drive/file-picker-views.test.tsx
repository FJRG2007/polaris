// @vitest-environment jsdom

/**
 * The file picker shows a folder as a list or as a grid of tiles, with Drive's
 * own switch and Drive's own thumbnails, and switching between the two is only
 * a change of layout: what was chosen stays chosen.
 */

import { MessagesWrapper } from "../setup/i18n";
import { useMemoryStorage } from "./fixtures/memory-storage";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { PICKER_VIEW_MODES, rememberedViewMode } from "@/app/(app)/drive/view-mode";

beforeEach(() => useMemoryStorage());

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const SOURCES = { sources: [{ id: "c1", name: "Files", shared: false, rootPath: "/" }] };

const ENTRIES = {
    entries: [
        { name: "Budget.xlsx", path: "Budget.xlsx", kind: "file", size: "10", modifiedAt: "" },
        { name: "Photo.png", path: "Photo.png", kind: "file", size: "20", modifiedAt: "" },
        { name: "Reports", path: "Reports", kind: "dir", size: "0", modifiedAt: "" }
    ]
};

function stubDrive(): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async (url: string) =>
                new Response(JSON.stringify(url.includes("/sources") ? SOURCES : ENTRIES), {
                    headers: { "content-type": "application/json" }
                })
        )
    );
}

function entry(name: string): HTMLElement {
    // A file names its size after it; a folder is its name alone.
    return screen.getByRole("button", { name: (accessible) => accessible.startsWith(name) });
}

describe("the file picker's list and grid", () => {
    it("keeps the selection across both layouts and remembers the one chosen", async () => {
        stubDrive();
        render(<FilePickerDialog onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Budget.xlsx")).toBeTruthy());

        const user = userEvent.setup();
        await user.click(entry("Budget.xlsx"));
        await user.click(entry("Photo.png"));
        expect(screen.getByText("2 files chosen")).toBeTruthy();

        const grid = screen.getByRole("button", { name: "Grid view" });
        expect(grid.getAttribute("title")).toBe("Grid view");
        await user.click(grid);

        // Tiles now, with the picture Drive draws for a file that has one.
        expect(document.querySelector("ul.grid")).toBeTruthy();
        expect(
            document.querySelector('img[src*="/api/drive/thumbnail"][src*="Photo.png"]')
        ).toBeTruthy();
        expect(entry("Budget.xlsx").getAttribute("aria-pressed")).toBe("true");
        expect(entry("Photo.png").getAttribute("aria-pressed")).toBe("true");
        expect(screen.getByText("2 files chosen")).toBeTruthy();
        expect(rememberedViewMode("c1", "recent:", PICKER_VIEW_MODES)).toBe("grid");

        // Multi-select still adds and removes in the grid.
        await user.click(entry("Photo.png"));
        expect(entry("Photo.png").getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByText("1 file chosen")).toBeTruthy();

        await user.click(screen.getByRole("button", { name: "List view" }));
        expect(document.querySelector("ul.grid")).toBeNull();
        expect(entry("Budget.xlsx").getAttribute("aria-pressed")).toBe("true");
        expect(entry("Photo.png").getAttribute("aria-pressed")).toBe("false");
        expect(screen.getByText("1 file chosen")).toBeTruthy();
    });

    it("moves between entries with the arrow keys in either layout", async () => {
        stubDrive();
        render(<FilePickerDialog onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Budget.xlsx")).toBeTruthy());
        const user = userEvent.setup();

        entry("Budget.xlsx").focus();
        await user.keyboard("{ArrowDown}");
        expect(document.activeElement).toBe(entry("Photo.png"));
        await user.keyboard(" ");
        expect(entry("Photo.png").getAttribute("aria-pressed")).toBe("true");

        await user.click(screen.getByRole("button", { name: "Grid view" }));
        entry("Budget.xlsx").focus();
        await user.keyboard("{ArrowRight}");
        expect(document.activeElement).toBe(entry("Photo.png"));
        await user.keyboard("{ArrowLeft}");
        expect(document.activeElement).toBe(entry("Budget.xlsx"));
    });

    it("opens a folder from a grid tile", async () => {
        stubDrive();
        render(<FilePickerDialog initialTab="mine" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Reports")).toBeTruthy());
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Grid view" }));
        await user.dblClick(entry("Reports"));

        await waitFor(() =>
            expect(
                vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("p=Reports"))
            ).toBe(true)
        );
    });
});
