// @vitest-environment jsdom

/**
 * A screen that takes a file offers the shared picker - Drive, this computer,
 * an address - rather than the browser's own chooser, and still gets back the
 * `File`s it already knows how to check.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PictureField } from "@/components/picture-field";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { ChooseFilesDialog } from "@/components/file-picker/choose-files-dialog";
import { MessagesWrapper } from "../setup/i18n";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const SOURCES = { sources: [{ id: "c1", name: "Files", shared: false, rootPath: "/" }] };

const ENTRIES = {
    entries: [
        { name: "Skin.png", path: "Skin.png", kind: "file", size: "10", modifiedAt: "" },
        { name: "Photo.jpg", path: "Photo.jpg", kind: "file", size: "10", modifiedAt: "" },
        { name: "Theme.ogg", path: "Theme.ogg", kind: "file", size: "20", modifiedAt: "" }
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

describe("the shared picker in place of a file input", () => {
    it("lists only an exact image type's files", async () => {
        stubDrive();
        render(<FilePickerDialog accept="image/png" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Skin.png")).toBeTruthy());
        expect(screen.queryByText("Photo.jpg")).toBeNull();
        expect(screen.queryByText("Theme.ogg")).toBeNull();
    });

    it("lists a wildcard type's whole family", async () => {
        stubDrive();
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByText("Photo.jpg")).toBeTruthy());
        expect(screen.getByText("Skin.png")).toBeTruthy();
        expect(screen.queryByText("Theme.ogg")).toBeNull();
    });

    it("hands back a file from this computer as a File", async () => {
        stubDrive();
        const onFiles = vi.fn();
        render(<ChooseFilesDialog accept="image/png" onFiles={onFiles} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await userEvent.click(screen.getByRole("button", { name: "Upload" }));
        const input = document.querySelector<HTMLInputElement>('input[type="file"]');
        expect(input?.getAttribute("accept")).toBe("image/png");
        const file = new File(["png"], "skin.png", { type: "image/png" });
        await userEvent.upload(input!, file);
        await waitFor(() => expect(onFiles).toHaveBeenCalledWith([file]));
    });

    it("opens from a picture field's Upload", async () => {
        stubDrive();
        render(<PictureField endpoint="/api/x/picture" preview={null} onDone={() => {}} />, {
            wrapper: MessagesWrapper
        });
        expect(document.querySelector('input[type="file"]')).toBeNull();
        await userEvent.click(screen.getByRole("button", { name: "Upload" }));
        expect(await screen.findByRole("dialog")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Recent" })).toBeTruthy();
    });
});
