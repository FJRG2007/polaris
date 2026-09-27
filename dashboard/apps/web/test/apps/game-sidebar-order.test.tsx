// @vitest-environment jsdom

/**
 * Putting the side panel's lines in a different order: by dragging a line's
 * handle, or with the arrow keys on it. An empty line is a gap, so moving one
 * under the title is how the panel gets space between the two.
 *
 * A line can be let go anywhere on the list - on a line, in the gap between two,
 * or on the heading above the first - and letting go above the first line puts
 * it first. Letting go outside a line used to do nothing at all.
 */

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { moved, useListOrder } from "@polaris-app/game-servers/src/components/use-list-order";

afterEach(cleanup);

describe("moving one item", () => {
    it("takes it out and puts it back where asked, the rest in order", () => {
        expect(moved(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
        expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
        expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
        expect(moved(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    });
});

/** The panel's lines, as the editor draws them: a handle and a field each. */
function Lines({ initial }: { initial: string[] }) {
    const [lines, setLines] = useState(initial);
    const order = useListOrder(initial.length, (from, to) => setLines((current) => moved(current, from, to)));
    return (
        <ul data-testid="list" {...order.listProps}>
            {lines.map((line, index) => (
                <li key={order.ids[index]} data-testid="row" {...order.rowProps(index)}>
                    <button type="button" aria-label={`Move line ${index + 1}`} {...order.handleProps(index, lines.length)} />
                    <input aria-label={`Line ${index + 1}`} defaultValue={line} />
                </li>
            ))}
        </ul>
    );
}

const values = () => screen.getAllByRole("textbox").map((field) => (field as HTMLInputElement).value);

/** Rows 40px apart and 30px tall, the first at the top: jsdom lays nothing out. */
function layOut() {
    screen.getAllByTestId("row").forEach((row, index) => {
        row.getBoundingClientRect = () =>
            ({ top: index * 40, height: 30, bottom: index * 40 + 30, left: 0, right: 0, width: 0, x: 0, y: index * 40 }) as DOMRect;
    });
}

const data = { effectAllowed: "", dropEffect: "", setData: () => undefined };

/** A drag event at a height. jsdom has no DragEvent, and the stand-in it makes
 *  drops the pointer's position. */
function at(make: typeof createEvent.dragOver, onto: HTMLElement, y: number) {
    const event = make(onto, { dataTransfer: data });
    Object.defineProperty(event, "clientY", { value: y });
    return event;
}

/** Pick a line up by its handle and let it go at a height, on an element. */
function drag(line: number, onto: HTMLElement, y: number) {
    layOut();
    fireEvent.pointerDown(screen.getByRole("button", { name: `Move line ${line}` }));
    fireEvent.dragStart(screen.getAllByTestId("row")[line - 1]!, { dataTransfer: data });
    fireEvent(onto, at(createEvent.dragOver, onto, y));
    fireEvent(onto, at(createEvent.drop, onto, y));
}

describe("the panel's lines", () => {
    it("move with the arrow keys on a line's handle", () => {
        render(<Lines initial={["Online: 3/20", "Steve, Alex", ""]} />);
        fireEvent.keyDown(screen.getByRole("button", { name: "Move line 3" }), { key: "ArrowUp" });
        fireEvent.keyDown(screen.getByRole("button", { name: "Move line 2" }), { key: "ArrowUp" });
        // The gap is now straight under the title.
        expect(values()).toEqual(["", "Online: 3/20", "Steve, Alex"]);
    });

    it("do not move past either end", () => {
        render(<Lines initial={["a", "b"]} />);
        fireEvent.keyDown(screen.getByRole("button", { name: "Move line 1" }), { key: "ArrowUp" });
        fireEvent.keyDown(screen.getByRole("button", { name: "Move line 2" }), { key: "ArrowDown" });
        expect(values()).toEqual(["a", "b"]);
    });

    it("move by dragging the handle onto another line", () => {
        render(<Lines initial={["a", "b", "c"]} />);
        // The lower half of the first line: after it.
        drag(3, screen.getAllByTestId("row")[0]!, 20);
        expect(values()).toEqual(["a", "c", "b"]);
    });

    it("go first when let go on the upper half of the first line", () => {
        render(<Lines initial={["a", "b", ""]} />);
        drag(3, screen.getAllByTestId("row")[0]!, 5);
        expect(values()).toEqual(["", "a", "b"]);
    });

    it("go first when let go above the first line, off every line", () => {
        render(<Lines initial={["a", "b", "c"]} />);
        drag(2, screen.getByTestId("list"), -8);
        expect(values()).toEqual(["b", "a", "c"]);
    });

    it("land in the gap between two lines they are let go in", () => {
        render(<Lines initial={["a", "b", "c"]} />);
        // 35 is between the first line (0-30) and the second (40-70).
        drag(1, screen.getByTestId("list"), 35);
        expect(values()).toEqual(["a", "b", "c"]);
        drag(3, screen.getByTestId("list"), 35);
        expect(values()).toEqual(["a", "c", "b"]);
    });

    it("go last when let go below the last line", () => {
        render(<Lines initial={["a", "b", "c"]} />);
        drag(1, screen.getByTestId("list"), 500);
        expect(values()).toEqual(["b", "c", "a"]);
    });

    it("only picks a row up from its handle, never from its text field", () => {
        render(<Lines initial={["a", "b"]} />);
        const rows = screen.getAllByTestId("row");
        expect(rows.map((row) => row.getAttribute("draggable"))).toEqual(["false", "false"]);
        fireEvent.pointerDown(screen.getByRole("button", { name: "Move line 2" }));
        expect(screen.getAllByTestId("row").map((row) => row.getAttribute("draggable"))).toEqual(["false", "true"]);
    });

    it("keeps each line's text with it, not with the slot it was in", () => {
        render(<Lines initial={["a", "b"]} />);
        fireEvent.change(screen.getByRole("textbox", { name: "Line 1" }), { target: { value: "typed" } });
        fireEvent.keyDown(screen.getByRole("button", { name: "Move line 1" }), { key: "ArrowDown" });
        expect(values()).toEqual(["b", "typed"]);
    });
});
