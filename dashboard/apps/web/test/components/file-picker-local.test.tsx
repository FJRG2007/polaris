// @vitest-environment jsdom

/**
 * A picker for a file that stays on this computer (a device plugin's picture):
 * nothing is uploaded, so the tab that takes a file from this machine reads
 * Select, not Upload, and a file chosen there comes back as it is.
 */

import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { MessagesWrapper } from "../setup/i18n";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

function stubDrive(): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ sources: [] }), { headers: { "content-type": "application/json" } }))
    );
}

describe("choosing a file that stays on this computer", () => {
    it("names the tab Select and hands the chosen file back untouched", async () => {
        stubDrive();
        const onPick = vi.fn();
        const { container } = render(<FilePickerDialog local accept=".png" multiple={false} onPick={onPick} onClose={() => {}} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("button", { name: "Select" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Upload" })).toBeNull();
        const input = container.ownerDocument.querySelector("input[type=file]") as HTMLInputElement;
        const file = new File([new Uint8Array([1, 2, 3])], "icon.png", { type: "image/png" });
        await userEvent.upload(input, file);
        expect(onPick).toHaveBeenCalledWith([{ kind: "upload", file }]);
    });

    it("keeps Upload everywhere else", () => {
        stubDrive();
        render(<FilePickerDialog onPick={() => {}} onClose={() => {}} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    });
});
