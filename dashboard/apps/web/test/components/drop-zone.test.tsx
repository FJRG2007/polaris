// @vitest-environment jsdom

/**
 * A drop zone is the attach button too: one control, reachable by keyboard,
 * that opens the picker when pressed and takes what is dropped on it.
 */

import userEvent from "@testing-library/user-event";
import { DropZone } from "@/components/drop-zone";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

function zone(disabled = false) {
    const onChoose = vi.fn();
    const onFiles = vi.fn();
    render(
        <DropZone onChoose={onChoose} onFiles={onFiles} disabled={disabled}>
            Drop a file here
        </DropZone>
    );
    return { onChoose, onFiles, button: screen.getByRole("button", { name: "Drop a file here" }) };
}

describe("drop zone", () => {
    it("opens the picker when pressed", async () => {
        const { onChoose, button } = zone();
        await userEvent.setup().click(button);
        expect(onChoose).toHaveBeenCalledTimes(1);
    });

    it("opens the picker from the keyboard, with Enter and with Space", async () => {
        const user = userEvent.setup();
        const { onChoose, button } = zone();
        await user.tab();
        expect(document.activeElement).toBe(button);
        await user.keyboard("{Enter}");
        await user.keyboard(" ");
        expect(onChoose).toHaveBeenCalledTimes(2);
    });

    it("hands over what is dropped on it", () => {
        const { onFiles, onChoose, button } = zone();
        const file = new File(["x"], "shot.png", { type: "image/png" });
        fireEvent.drop(button, { dataTransfer: { files: [file] } });
        expect(onFiles).toHaveBeenCalledTimes(1);
        expect(onChoose).not.toHaveBeenCalled();
    });

    it("takes nothing while it is busy", async () => {
        const { onFiles, onChoose, button } = zone(true);
        fireEvent.drop(button, { dataTransfer: { files: [new File(["x"], "a.txt")] } });
        await userEvent.setup().click(button);
        expect(onFiles).not.toHaveBeenCalled();
        expect(onChoose).not.toHaveBeenCalled();
    });
});
