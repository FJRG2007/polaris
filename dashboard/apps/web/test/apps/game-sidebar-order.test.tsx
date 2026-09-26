// @vitest-environment jsdom

/**
 * Putting the side panel's lines in a different order: by dragging a line's
 * handle, or with the arrow keys on it. An empty line is a gap, so moving one
 * under the title is how the panel gets space between the two.
 */

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
        <ul>
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
        const rows = screen.getAllByTestId("row");
        // Rows report no size in jsdom, so every point is below a row's middle:
        // dropping on the first row lands after it.
        fireEvent.pointerDown(screen.getByRole("button", { name: "Move line 3" }));
        const data = { effectAllowed: "", dropEffect: "", setData: () => undefined };
        fireEvent.dragStart(rows[2]!, { dataTransfer: data });
        fireEvent.dragOver(rows[0]!, { dataTransfer: data, clientY: 10 });
        fireEvent.drop(rows[0]!, { dataTransfer: data });
        expect(values()).toEqual(["a", "c", "b"]);
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
