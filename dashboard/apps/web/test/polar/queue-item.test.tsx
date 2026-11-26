// @vitest-environment jsdom
/**
 * A queued message reads as typed - line breaks kept, its files counted - with
 * Send now, Edit and Remove on the row and the reordering in a "..." menu; Send
 * now is left out where nobody may send it ahead, and saving the words it already
 * has changes nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueueItem, type QueueItemLabels } from "@/components/polar/elements/queue";

const LABELS: QueueItemLabels = {
    menu: "More options",
    sendNow: "Send now",
    edit: "Edit",
    up: "Move up",
    down: "Move down",
    remove: "Remove",
    save: "Save",
    cancel: "Cancel",
    files: null
};

afterEach(cleanup);

function show(props: Partial<Parameters<typeof QueueItem>[0]> = {}) {
    const calls = { save: vi.fn(), sendNow: vi.fn(), up: vi.fn(), down: vi.fn(), remove: vi.fn() };
    render(
        <ol>
            <QueueItem
                value={"first line\nsecond line"}
                labels={LABELS}
                first={false}
                last={false}
                onSave={calls.save}
                onSendNow={calls.sendNow}
                onUp={calls.up}
                onDown={calls.down}
                onRemove={calls.remove}
                {...props}
            />
        </ol>
    );
    return calls;
}

function openMenu() {
    fireEvent.pointerDown(screen.getByRole("button", { name: "More options" }), {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse"
    });
}

describe("a queued message", () => {
    it("reads as typed, line breaks kept, with its files counted", () => {
        show({ labels: { ...LABELS, files: "+2 files" } });
        const text = screen.getByTitle("first line\nsecond line", { normalizer: (title) => title });
        expect(text.textContent).toBe("first line\nsecond line");
        expect(text.className).toContain("whitespace-pre-wrap");
        expect(screen.getByText("+2 files")).toBeTruthy();
    });

    it("sends, edits and removes from buttons on the row, reachable by keyboard", () => {
        const calls = show();
        const send = screen.getByRole("button", { name: "Send now" });
        expect(send.tagName).toBe("BUTTON");
        expect(send.getAttribute("tabindex")).toBeNull();
        fireEvent.click(send);
        expect(calls.sendNow).toHaveBeenCalledOnce();
        fireEvent.click(screen.getByRole("button", { name: "Remove" }));
        expect(calls.remove).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    });

    it("keeps the reordering in the menu", async () => {
        const calls = show();
        openMenu();
        fireEvent.click(await screen.findByText("Move up"));
        expect(calls.up).toHaveBeenCalledOnce();
        openMenu();
        fireEvent.click(await screen.findByText("Move down"));
        expect(calls.down).toHaveBeenCalledOnce();
    });

    it("offers no Send now where nobody may send it ahead, and no menu with nothing to move", () => {
        show({ onSendNow: null, first: true, last: true });
        expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
        expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    });

    it("offers only the move that exists", async () => {
        show({ first: true });
        openMenu();
        expect(await screen.findByText("Move down")).toBeTruthy();
        expect(screen.queryByText("Move up")).toBeNull();
    });

    it("waits for a change on its way before acting", () => {
        show({ disabled: true });
        for (const name of ["Send now", "Edit", "Remove", "More options"]) {
            expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
        }
    });
});

describe("editing a queued message", () => {
    async function edit() {
        const calls = show();
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        return { calls, box: (await screen.findByLabelText("Edit")) as HTMLTextAreaElement };
    }

    it("saves the changed words", async () => {
        const { calls, box } = await edit();
        fireEvent.change(box, { target: { value: "new words" } });
        fireEvent.click(screen.getByText("Save"));
        expect(calls.save).toHaveBeenCalledWith("new words");
        expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("changes nothing when the words are the same, and closes on Enter", async () => {
        const { calls, box } = await edit();
        expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(box, { target: { value: "first line\nsecond line  " } });
        fireEvent.keyDown(box, { key: "Enter" });
        expect(calls.save).not.toHaveBeenCalled();
        expect(screen.queryByRole("textbox")).toBeNull();
    });

    it("drops the edit on Escape", async () => {
        const { calls, box } = await edit();
        fireEvent.change(box, { target: { value: "other" } });
        fireEvent.keyDown(box, { key: "Escape" });
        expect(calls.save).not.toHaveBeenCalled();
        expect(screen.getByTitle("first line\nsecond line", { normalizer: (title) => title })).toBeTruthy();
    });
});
