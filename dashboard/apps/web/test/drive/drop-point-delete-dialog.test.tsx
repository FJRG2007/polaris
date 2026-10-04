// @vitest-environment jsdom

/**
 * The choice offered when a drop point is deleted.
 *
 * Deleting the folder with it is the usual intent, so the switch starts on for
 * every drop point that has a folder of its own - and stays where its owner put
 * it, even when the screen behind the dialog re-renders and hands the dialog a
 * fresh copy of the same drop point.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeleteDropPointDialog, type DropPointTarget } from "@/app/(app)/drive/drop-points/delete-drop-point-dialog";

afterEach(cleanup);

const photos = (): DropPointTarget => ({
    id: "dp1",
    title: "Photos",
    destinationPath: "Drop Points/Photos",
    connectionName: "NAS",
    submissionCount: 3
});

function dialog(target: DropPointTarget | null, onConfirm = vi.fn()) {
    return (
        <MessagesWrapper>
            <DeleteDropPointDialog target={target} onCancel={() => undefined} onConfirm={onConfirm} />
        </MessagesWrapper>
    );
}

describe("deleting a drop point", () => {
    it("offers to delete the folder too, switched on", () => {
        const onConfirm = vi.fn();
        render(dialog(photos(), onConfirm));
        const choice = screen.getByRole("switch", { name: "Delete the folder too" });
        expect(choice.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(onConfirm).toHaveBeenCalledWith(true);
    });

    it("keeps the switch off once turned off, through a re-render with a new copy", () => {
        const onConfirm = vi.fn();
        const { rerender } = render(dialog(photos(), onConfirm));
        act(() => fireEvent.click(screen.getByRole("switch", { name: "Delete the folder too" })));
        rerender(dialog(photos(), onConfirm));
        expect(
            screen.getByRole("switch", { name: "Delete the folder too" }).getAttribute("aria-checked")
        ).toBe("false");
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(onConfirm).toHaveBeenCalledWith(false);
    });

    it("starts on again for the next drop point", () => {
        const { rerender } = render(dialog(photos()));
        act(() => fireEvent.click(screen.getByRole("switch", { name: "Delete the folder too" })));
        rerender(dialog(null));
        rerender(dialog({ ...photos(), id: "dp2", title: "Invoices" }));
        expect(
            screen.getByRole("switch", { name: "Delete the folder too" }).getAttribute("aria-checked")
        ).toBe("true");
    });
});
