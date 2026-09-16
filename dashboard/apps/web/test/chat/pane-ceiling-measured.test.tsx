// @vitest-environment jsdom

/**
 * The ceiling, as it is actually arrived at on a drawn screen.
 *
 * The arithmetic is pinned next door; what is pinned here is the wiring, which
 * is the half that can silently do nothing. The panels in this row are drawn by
 * three components that cannot see each other, so what a panel is beside is
 * found rather than named - the one child of the row that grows is where every
 * extra pixel comes from. Find nothing, and the hook hands back the stated
 * ceiling and the conversation goes back to being squeezed off the screen with
 * no test noticing.
 */

import { usePaneCeiling } from "@/app/(app)/chat/pane-room";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BOUNDS = { min: 280, max: 560 };

/** jsdom lays nothing out, so a width is whatever the markup says it is. */
function widthsFromMarkup(): void {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
        configurable: true,
        get(this: HTMLElement) {
            return Number(this.dataset["width"] ?? 0);
        }
    });
}

/** Enough of one to deliver the first measurement, which is the one that counts:
 *  everything after it is the browser telling this the same way. */
function observerThatNeverFires(): void {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        }
    );
}

function Row({
    beside,
    grows,
    hidden = false
}: {
    beside: number;
    grows: boolean;
    hidden?: boolean;
}) {
    const { ceiling, measure } = usePaneCeiling(BOUNDS);
    return (
        <div style={{ display: "flex" }}>
            <div
                data-width={beside}
                style={{ flexGrow: grows ? 1 : 0, display: hidden ? "none" : "block" }}
            >
                conversation
            </div>
            <aside ref={measure} data-width={560}>
                <span>ceiling {ceiling}</span>
            </aside>
        </div>
    );
}

beforeEach(() => {
    widthsFromMarkup();
    observerThatNeverFires();
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the ceiling on a drawn screen", () => {
    it("takes it from what the conversation beside it has to spare", () => {
        // 560 of panel and 340 of conversation: 900 between them, and 360 of that
        // belongs to the conversation whatever the panel would like.
        render(<Row beside={340} grows />);
        expect(screen.getByText("ceiling 540")).toBeTruthy();
    });

    it("pulls the panel back rather than the conversation, when neither fits", () => {
        render(<Row beside={80} grows />);
        expect(screen.getByText(`ceiling ${BOUNDS.min}`)).toBeTruthy();
    });

    it("leaves the stated ceiling alone while the conversation is not drawn", () => {
        // The narrow layouts, where one column is the whole screen and the other
        // is not there at all. A column with no box measures nothing, and reading
        // that as "no room" would hold the panel at its floor on the screen where
        // it is the only thing showing.
        render(<Row beside={340} grows hidden />);
        expect(screen.getByText(`ceiling ${BOUNDS.max}`)).toBeTruthy();
    });

    it("leaves the stated ceiling alone where nothing yields", () => {
        // A row of fixed columns has no slack to hand over, and a ceiling
        // invented from one would shrink a panel for no reason.
        render(<Row beside={340} grows={false} />);
        expect(screen.getByText(`ceiling ${BOUNDS.max}`)).toBeTruthy();
    });
});

/**
 * The conversation list's row, which is not that shape.
 *
 * Its growing neighbour is the whole content column, and the thread and members
 * panels are inside that column with dividers of their own. So the room the list
 * may grow into is not the column's width - most of it is already spoken for.
 */
function NestedRow({ column, conversation }: { column: number; conversation: number }) {
    const { ceiling, measure } = usePaneCeiling(BOUNDS);
    return (
        <div style={{ display: "flex" }}>
            <aside ref={measure} data-width={560}>
                <span>ceiling {ceiling}</span>
            </aside>
            <div
                data-width={column}
                style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}
            >
                <div data-width={column} style={{ flexGrow: 1, display: "flex" }}>
                    <div data-width={conversation} style={{ flexGrow: 1 }}>
                        conversation
                    </div>
                    <aside data-width={240} style={{ flexGrow: 0 }}>
                        members
                    </aside>
                </div>
            </div>
        </div>
    );
}

describe("a panel whose neighbour holds other panels", () => {
    // 560 of list and 900 of content column, but 240 of that column is the
    // members list and only 340 of it is conversation. Measuring the column says
    // there are 1100 pixels to play with and hands back the stated ceiling;
    // measuring what actually yields says 540, which is the true one. The
    // difference is a conversation drawn under its floor with nobody having
    // touched a divider.
    it("measures what actually yields, not the column in between", () => {
        render(<NestedRow column={900} conversation={340} />);
        expect(screen.getByText("ceiling 540")).toBeTruthy();
    });

    it("still stops at the floor when the conversation inside is already small", () => {
        render(<NestedRow column={900} conversation={80} />);
        expect(screen.getByText(`ceiling ${BOUNDS.min}`)).toBeTruthy();
    });
});
