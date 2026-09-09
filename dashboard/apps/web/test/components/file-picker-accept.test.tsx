// @vitest-environment jsdom

/**
 * A picker offering only what the screen it was opened from can take.
 *
 * The dialog is shared, so every screen sees the same files - but Office can
 * open a spreadsheet and cannot open a video, and a file chosen there travels
 * from a storage through the server before anything says so. Filtering the
 * listing is what turns that into "it was never offered" rather than "it was
 * fetched, sent, and refused".
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const SOURCES = { sources: [{ id: "c1", name: "Files", shared: false, rootPath: "/" }] };

const ENTRIES = {
    entries: [
        { name: "Budget.xlsx", path: "Budget.xlsx", kind: "file", size: "10", modifiedAt: "" },
        { name: "Clip.mp4", path: "Clip.mp4", kind: "file", size: "20", modifiedAt: "" },
        { name: "Folder", path: "Folder", kind: "dir", size: "0", modifiedAt: "" }
    ]
};

/** The two endpoints the dialog reaches on its own as it opens. */
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

describe("choosing a file for a screen that takes some of them", () => {
    it("lists only what the screen accepts", async () => {
        stubDrive();
        render(<FilePickerDialog accept=".xlsx,.csv" onPick={() => {}} onClose={() => {}} />);

        await waitFor(() => expect(screen.getByText("Budget.xlsx")).toBeTruthy());
        expect(screen.queryByText("Clip.mp4")).toBeNull();
        // A folder is not a file the screen would take or refuse: it is where
        // the ones it takes are.
        expect(screen.getByText("Folder")).toBeTruthy();
    });

    it("lists everything when the screen said nothing", async () => {
        stubDrive();
        render(<FilePickerDialog onPick={() => {}} onClose={() => {}} />);

        await waitFor(() => expect(screen.getByText("Budget.xlsx")).toBeTruthy());
        expect(screen.getByText("Clip.mp4")).toBeTruthy();
    });

    it("hands the same list to the machine's own chooser", async () => {
        stubDrive();
        render(<FilePickerDialog accept=".xlsx,.csv" onPick={() => {}} onClose={() => {}} />);

        await userEvent.click(screen.getByRole("button", { name: "Upload" }));
        const input = document.querySelector('input[type="file"]');
        expect(input?.getAttribute("accept")).toBe(".xlsx,.csv");
    });
});
