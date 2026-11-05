// @vitest-environment jsdom

/** Editing a group: Save waits for a change, survives a failure, and sends once. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditGroupDialog, groupEditDirty } from "@/app/(app)/chat/edit-group-dialog";
import { MessagesWrapper } from "../setup/i18n";

const rename = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/chat/actions", () => ({
    renameGroupAction: rename,
    setGroupGifAction: vi.fn(),
    tenorReadyAction: async () => false,
    searchTenorAction: async () => ({ results: [] })
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

afterEach(() => {
    cleanup();
    rename.mockReset();
    vi.restoreAllMocks();
});

function open(onOpenChange = vi.fn()) {
    render(
        <EditGroupDialog
            channel={{ id: "c1", name: "Old" }}
            open
            onOpenChange={onOpenChange}
            onSaved={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
    const field = screen.getByRole("textbox", { name: "Group name" });
    fireEvent.change(field, { target: { value: "New" } });
    return field;
}

describe("editing a group", () => {
    it("keeps Save off until something differs from what was loaded", () => {
        expect(groupEditDirty("Old", "Old", { kind: "keep" })).toBe(false);
        expect(groupEditDirty("Old", "Old ", { kind: "keep" })).toBe(false);
        expect(groupEditDirty("Old", "New", { kind: "keep" })).toBe(true);
        expect(groupEditDirty("Old", "Old", { kind: "remove" })).toBe(true);
    });

    it("titles the dialog and disables Save on a name typed back", () => {
        const field = open();
        expect(screen.getByText("Edit group")).toBeTruthy();
        fireEvent.change(field, { target: { value: "Old" } });
        const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
    });

    it("stays open with the reason when the action rejects", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        rename.mockRejectedValue(new Error("Failed to find Server Action"));
        const onOpenChange = vi.fn();
        const field = open(onOpenChange);
        fireEvent.keyDown(field, { key: "Enter" });
        expect(
            await screen.findByText("The request could not be completed. Try again.")
        ).toBeTruthy();
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    it("sends one rename for a double press", async () => {
        let answer: (value: object) => void = () => undefined;
        rename.mockReturnValue(new Promise((resolve) => (answer = resolve)));
        const onOpenChange = vi.fn();
        const field = open(onOpenChange);
        fireEvent.keyDown(field, { key: "Enter" });
        fireEvent.keyDown(field, { key: "Enter" });
        answer({});
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(rename).toHaveBeenCalledTimes(1);
    });
});
