// @vitest-environment jsdom

/**
 * The divider, moved without a mouse.
 *
 * Which way is wider depends on which side of the line the panel is: dragging
 * left widens a panel that is to the right of the handle and narrows one that is
 * to its left. The arrow keys have to make the same inversion, and the failure
 * when they do not is quiet - the divider does one thing to the pointer and the
 * opposite to the keyboard, which reads as the control being broken rather than
 * as being backwards.
 *
 * The third test is the one worth having. Both halves are memoized, and they
 * were memoized on different inputs: a handle whose side changed after it was
 * drawn kept the old answer for the keys and took the new one for the drag, so
 * the two disagreed on exactly the panel the side was added for.
 */

import { ResizeHandle } from "../src/components/resize-handle";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/** One arrow press, as the component counts one. */
const STEP = 16;
const SIZE = 300;

function handle(side: "start" | "end", onChange: (size: number) => void) {
    return (
        <ResizeHandle
            axis="x"
            side={side}
            size={SIZE}
            min={200}
            max={400}
            onChange={onChange}
            label="Panel width"
        />
    );
}

afterEach(cleanup);

describe("moving a divider with the arrow keys", () => {
    it("widens a panel before the line when the pointer would be sent away from it", () => {
        const onChange = vi.fn();
        render(handle("start", onChange));
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
        expect(onChange).toHaveBeenCalledWith(SIZE + STEP);
    });

    it("widens a panel after the line on the opposite key", () => {
        const onChange = vi.fn();
        render(handle("end", onChange));
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
        expect(onChange).toHaveBeenCalledWith(SIZE + STEP);
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowRight" });
        expect(onChange).toHaveBeenLastCalledWith(SIZE - STEP);
    });

    it("follows the side changing after it was first drawn", () => {
        const onChange = vi.fn();
        const drawn = render(handle("start", onChange));
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
        expect(onChange).toHaveBeenLastCalledWith(SIZE - STEP);

        drawn.rerender(handle("end", onChange));
        fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
        expect(onChange).toHaveBeenLastCalledWith(SIZE + STEP);
    });

    it("goes to the limits, whichever side it is on", () => {
        const onChange = vi.fn();
        render(handle("end", onChange));
        fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
        expect(onChange).toHaveBeenLastCalledWith(200);
        fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
        expect(onChange).toHaveBeenLastCalledWith(400);
    });

    it("leaves a key it does not handle to whatever else is listening", () => {
        const onChange = vi.fn();
        render(handle("end", onChange));
        const stopped = fireEvent.keyDown(screen.getByRole("separator"), { key: "Tab" });
        expect(onChange).not.toHaveBeenCalled();
        expect(stopped).toBe(true);
    });
});
