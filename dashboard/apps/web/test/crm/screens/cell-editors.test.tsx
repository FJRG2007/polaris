// @vitest-environment jsdom

/**
 * The editors laid over a cell, by keyboard: Tab walks the boxes of an editor
 * with several and keeps only when it leaves the last one, Enter on a star is
 * not a cancel, and a choice taken off the field does not lock the field.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { customDef } from "@polaris-app/crm/src/model/fields";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    AddressEditor,
    ChoicesEditor,
    DateEditor,
    RatingEditor,
    editorFor
} from "@polaris-app/crm/src/screens/cell-editors";

const office = customDef({
    id: "f1",
    slot: "cText1",
    label: "Office",
    kind: "address",
    options: []
});
const tags = customDef({
    id: "f2",
    slot: "cText2",
    label: "Tags",
    kind: "multiSelect",
    options: ["Red", "Blue"]
});
const due = customDef({ id: "f4", slot: "cDate1", label: "Due", kind: "date", options: [] });
const score = customDef({ id: "f3", slot: "cNum1", label: "Score", kind: "rating", options: [] });

afterEach(cleanup);

describe("cell editors", () => {
    it("moves through an address's boxes on Tab and keeps it when Tab leaves the last", () => {
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        render(
            <AddressEditor
                field={office}
                value={"Main Street 1\nSpringfield\n\n12345\nExample Land"}
                onCommit={onCommit}
                onCancel={onCancel}
            />,
            { wrapper: MessagesWrapper }
        );
        const boxes = screen.getAllByRole("textbox");
        expect(boxes).toHaveLength(5);
        boxes[0]!.focus();
        fireEvent.keyDown(boxes[0]!, { key: "Tab" });
        expect(onCommit).not.toHaveBeenCalled();
        boxes[4]!.focus();
        fireEvent.keyDown(boxes[4]!, { key: "Tab", shiftKey: true });
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.keyDown(boxes[4]!, { key: "Tab" });
        expect(onCommit).toHaveBeenCalledWith("Main Street 1\nSpringfield\n\n12345\nExample Land");
        expect(onCancel).not.toHaveBeenCalled();
    });

    it("names the stars by the field and does not cancel on Enter", () => {
        const onCancel = vi.fn();
        render(<RatingEditor field={score} value={2} onCommit={vi.fn()} onCancel={onCancel} />, {
            wrapper: MessagesWrapper
        });
        const group = screen.getByRole("radiogroup", { name: "Score" });
        const star = screen.getAllByRole("radio")[2]!;
        fireEvent.keyDown(star, { key: "Enter" });
        expect(onCancel).not.toHaveBeenCalled();
        fireEvent.keyDown(group, { key: "Escape" });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("keeps the choices still on the field when one was taken off it since", () => {
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        render(
            <ChoicesEditor
                field={tags}
                value={JSON.stringify(["Red", "Green"])}
                onCommit={onCommit}
                onCancel={onCancel}
            />,
            { wrapper: MessagesWrapper }
        );
        const group = screen.getByRole("group", { name: "Tags" });
        const [red, blue] = screen.getAllByRole("checkbox");
        red!.focus();
        fireEvent.keyDown(red!, { key: "Tab" });
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.click(blue!);
        fireEvent.keyDown(group, { key: "Enter" });
        expect(onCommit).toHaveBeenCalledWith(JSON.stringify(["Red", "Blue"]));
        expect(onCancel).not.toHaveBeenCalled();
    });

    it("writes nothing when choices are opened and left, a removed one included", () => {
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        render(
            <ChoicesEditor
                field={tags}
                value={JSON.stringify(["Red", "Green"])}
                onCommit={onCommit}
                onCancel={onCancel}
            />,
            { wrapper: MessagesWrapper }
        );
        expect(screen.getAllByRole("checkbox")).toHaveLength(3);
        expect(screen.getByText("Green")).toBeTruthy();
        fireEvent.pointerDown(document.body);
        expect(onCommit).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("closes instead of committing a value the cell already holds", () => {
        const name = customDef({
            id: "f4",
            slot: "cText3",
            label: "Nick",
            kind: "text",
            options: []
        });
        const Editor = editorFor(name)!;
        expect(editorFor(name)).toBe(Editor);
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        render(<Editor field={name} value="Sample" onCommit={onCommit} onCancel={onCancel} />, {
            wrapper: MessagesWrapper
        });
        const box = screen.getByRole("textbox");
        fireEvent.change(box, { target: { value: " Sample " } });
        fireEvent.keyDown(box, { key: "Enter" });
        expect(onCommit).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalledTimes(1);
        cleanup();
        const blank = vi.fn();
        render(<Editor field={name} value={null} onCommit={blank} onCancel={vi.fn()} />, {
            wrapper: MessagesWrapper
        });
        fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
        expect(blank).not.toHaveBeenCalled();
    });

    it("keeps a day on Enter and drops it on Escape, leaving the calendar's own keys alone", () => {
        const onCommit = vi.fn();
        const onCancel = vi.fn();
        render(
            <DateEditor field={due} value="2026-03-04" onCommit={onCommit} onCancel={onCancel} />,
            { wrapper: MessagesWrapper }
        );
        const field = screen.getByRole("button", { name: "Value" });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(onCommit).toHaveBeenCalledWith("2026-03-04");
        fireEvent.keyDown(field, { key: "Escape" });
        expect(onCancel).toHaveBeenCalledTimes(1);

        fireEvent.click(field);
        const day = screen.getByRole("grid").querySelector("[data-day='2026-03-10']")!;
        fireEvent.keyDown(day, { key: "Enter" });
        fireEvent.keyDown(day, { key: "Escape" });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });
});
