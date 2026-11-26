// @vitest-environment jsdom
/**
 * A queued message reads as typed - line breaks kept, its files counted - with
 * its actions in one "..." menu; Send now is left out where nobody may send it
 * ahead, and saving the words it already has changes nothing.
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
        const text = screen.getByTitle("first line\nsecond line");
        expect(text.textContent).toBe("first line\nsecond line");
        expect(text.className).toContain("whitespace-pre-wrap");
        expect(screen.getByText("+2 files")).toBeTruthy();
    });

    it("keeps its actions in the menu", async () => {
        const calls = show();
        openMenu();
        fireEvent.click(await screen.findByText("Send now"));
        expect(calls.sendNow).toHaveBeenCalledOnce();
        openMenu();
        expect(await screen.findByText("Move up")).toBeTruthy();
        expect(screen.getByText("Move down")).toBeTruthy();
        fireEvent.click(screen.getByText("Remove"));
        expect(calls.remove).toHaveBeenCalledOnce();
    });

    it("offers no Send now where nobody may send it ahead, and no move past an end", async () => {
        show({ onSendNow: null, first: true, last: true });
        openMenu();
        expect(await screen.findByText("Edit")).toBeTruthy();
        expect(screen.queryByText("Send now")).toBeNull();
        expect(screen.queryByText("Move up")).toBeNull();
        expect(screen.queryByText("Move down")).toBeNull();
    });

    it("waits for a change on its way before opening the menu", () => {
        show({ disabled: true });
        expect((screen.getByRole("button", { name: "More options" }) as HTMLButtonElement).disabled).toBe(true);
    });
});

describe("editing a queued message", () => {
    async function edit() {
        const calls = show();
        openMenu();
        fireEvent.click(await screen.findByText("Edit"));
        return { calls, box: (await screen.findByLabelText("Edit")) as HTMLTextAreaElement };
    }

    it("saves the changed words", async () => {
        const { calls, box } = await edit();
        fireEvent.change(box, { target: { value: "new words" } });
        fireEvent.click(screen.getByText("Save"));
        expect(calls.save).toHaveBeenCalledWith("new words");
        expect(screen.queryByLabelText("Edit")).toBeNull();
    });

    it("changes nothing when the words are the same, and closes on Enter", async () => {
        const { calls, box } = await edit();
        expect((screen.getByText("Save") as HTMLButtonElement).disabled).toBe(true);
        fireEvent.change(box, { target: { value: "first line\nsecond line  " } });
        fireEvent.keyDown(box, { key: "Enter" });
        expect(calls.save).not.toHaveBeenCalled();
        expect(screen.queryByLabelText("Edit")).toBeNull();
    });

    it("drops the edit on Escape", async () => {
        const { calls, box } = await edit();
        fireEvent.change(box, { target: { value: "other" } });
        fireEvent.keyDown(box, { key: "Escape" });
        expect(calls.save).not.toHaveBeenCalled();
        expect(screen.getByTitle("first line\nsecond line")).toBeTruthy();
    });
});
