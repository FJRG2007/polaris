// @vitest-environment jsdom

/**
 * Seeing where a dragged channel is about to land.
 *
 * A row under the pointer has always been answered with a line above or below
 * it. A heading was not answered at all, and that is the case that matters:
 * dropping into an empty heading, into a folded one, or past the last row under
 * one is a real move with no row to draw a line beside, so the only way to find
 * out where the channel would go was to let go of it and look.
 *
 * Two things are asserted, and the second is the one that would rot quietly. A
 * heading reports itself while something is held over it - and it stops the
 * moment a row claims the pointer, because two answers on screen at once is
 * worse than one that is late.
 *
 * The third is what showing a landing spot is for: letting go on the heading has
 * to make the move it was advertising. The heading is a row of its own inside
 * the area that owns the drop, so the two handlers run one after the other, and
 * the first has to leave the drag intact for the second.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRailDrag, type Dragging, type DropTarget } from "@/app/(app)/chat/use-rail-drag";

/** The rail in miniature: one heading holding one channel, and the reported
 *  answer written out where a test can read it. */
function Rail({ onDrop = () => undefined }: { onDrop?: (source: Dragging, target: DropTarget) => void }) {
    const drag = useRailDrag({ enabled: true, onDrop });
    return (
        <div>
            <span data-testid="into">{drag.dropInto ? String(drag.dropInto.categoryId) : "-"}</span>
            <span data-testid="at">{drag.dropAt ? drag.dropAt.id : "-"}</span>
            <div data-testid="area" {...drag.areaProps("voice")}>
                {/* Inside the area, as the rail draws it: the heading is what is
                    left to aim at once a section is folded. */}
                <div data-testid="heading" {...drag.rowProps("category", "voice")} />
                <div
                    data-testid="row"
                    {...drag.handleProps({ kind: "channel", id: "general" })}
                    {...drag.rowProps("channel", "general")}
                />
                {/* Somewhere else to put it: a row never reports itself as its
                    own destination. */}
                <div data-testid="other" {...drag.rowProps("channel", "random")} />
            </div>
        </div>
    );
}

/** Pick a channel up. jsdom has no drag machinery of its own, so the transfer
 *  object the handler writes to is supplied. */
function pickUp(): void {
    fireEvent.dragStart(screen.getByTestId("row"), {
        dataTransfer: { setData: () => undefined, effectAllowed: "" }
    });
}

afterEach(cleanup);

describe("where a dragged channel says it will land", () => {
    it("names the heading while it is held over one", () => {
        render(<Rail />);
        pickUp();

        expect(screen.getByTestId("into").textContent).toBe("-");
        fireEvent.dragOver(screen.getByTestId("area"));
        expect(screen.getByTestId("into").textContent).toBe("voice");
    });

    it("hands the answer back to a row the moment one claims the pointer", () => {
        render(<Rail />);
        pickUp();
        fireEvent.dragOver(screen.getByTestId("area"));

        fireEvent.dragOver(screen.getByTestId("other"));
        // The precise answer wins, and the heading stops claiming it: a line
        // beside a row and a lit heading at the same time say two things.
        expect(screen.getByTestId("at").textContent).toBe("random");
        expect(screen.getByTestId("into").textContent).toBe("-");
    });

    it("lights the heading a channel is held over, folded or not", () => {
        render(<Rail />);
        pickUp();

        fireEvent.dragOver(screen.getByTestId("heading"));
        expect(screen.getByTestId("into").textContent).toBe("voice");
        // Not a line beside the heading: a channel is not going above or below
        // it, it is going into it.
        expect(screen.getByTestId("at").textContent).toBe("-");
    });

    it("makes the move when the channel is let go on the heading", () => {
        const dropped = vi.fn();
        render(<Rail onDrop={dropped} />);
        pickUp();
        fireEvent.dragOver(screen.getByTestId("heading"));

        fireEvent.drop(screen.getByTestId("heading"));
        expect(dropped).toHaveBeenCalledWith(
            { kind: "channel", id: "general" },
            { at: "end", categoryId: "voice" }
        );
    });

    it("forgets both when the drag ends", () => {
        render(<Rail />);
        pickUp();
        fireEvent.dragOver(screen.getByTestId("area"));

        fireEvent.dragEnd(screen.getByTestId("row"));
        expect(screen.getByTestId("into").textContent).toBe("-");
        expect(screen.getByTestId("at").textContent).toBe("-");
    });
});
