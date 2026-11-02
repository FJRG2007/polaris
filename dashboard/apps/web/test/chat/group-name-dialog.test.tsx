// @vitest-environment jsdom

/** Naming a group survives a request that fails, and is sent once. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GroupNameDialog } from "@/app/(app)/chat/group-name-dialog";
import { MessagesWrapper } from "../setup/i18n";

const rename = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/chat/actions", () => ({ renameGroupAction: rename }));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

afterEach(() => {
    cleanup();
    rename.mockReset();
    vi.restoreAllMocks();
});

function open(onOpenChange = vi.fn()) {
    render(
        <GroupNameDialog
            channel={{ id: "c1", name: "Old" }}
            open
            onOpenChange={onOpenChange}
            onSaved={() => undefined}
        />,
        { wrapper: MessagesWrapper }
    );
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "New" } });
    return field;
}

describe("naming a group", () => {
    it("stays open with the reason when the action rejects", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        rename.mockRejectedValue(new Error("Failed to find Server Action"));
        const onOpenChange = vi.fn();
        const field = open(onOpenChange);
        fireEvent.keyDown(field, { key: "Enter" });
        expect(await screen.findByText("The request could not be completed. Try again.")).toBeTruthy();
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
