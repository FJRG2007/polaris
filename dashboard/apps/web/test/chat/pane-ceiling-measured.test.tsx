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

import { CONVERSATION_FLOOR, usePaneCeiling } from "@/app/(app)/chat/pane-room";
import { act, cleanup, render, screen } from "@testing-library/react";
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

/**
 * The page under it, replaced.
 *
 * What a panel is beside is not a fixture: the conversation list lives in the
 * layout and outlives every conversation opened beside it, and the element it
 * measures against belongs to the page - swapped on every navigation, and again
 * the moment the skeleton gives way to the messages. Resolved once, that element
 * is detached before the first message lands, and what is left is the stated
 * ceiling for the rest of the session - which is the squeeze this was written to
 * stop, back again and harder to see.
 */
function SwappingRow({ ready }: { ready: boolean }) {
    const { ceiling, measure } = usePaneCeiling(BOUNDS);
    return (
        <div style={{ display: "flex" }}>
            <aside ref={measure} data-width={560}>
                <span>ceiling {ceiling}</span>
            </aside>
            <div data-width={900} style={{ flexGrow: 1, display: "flex", flexDirection: "column" }}>
                {ready ? (
                    <div
                        key="conversation"
                        data-width={900}
                        style={{ flexGrow: 1, display: "flex" }}
                    >
                        <div data-width={340} style={{ flexGrow: 1 }}>
                            conversation
                        </div>
                        <aside data-width={240} style={{ flexGrow: 0 }}>
                            members
                        </aside>
                    </div>
                ) : (
                    <div key="skeleton" data-width={900} style={{ flexGrow: 1 }}>
                        skeleton
                    </div>
                )}
            </div>
        </div>
    );
}

describe("a panel whose neighbour is replaced under it", () => {
    it("measures what is there now, not what was there at mount", async () => {
        // The skeleton fills the column, so there is nothing to give back and the
        // stated ceiling stands.
        const { rerender } = render(<SwappingRow ready={false} />);
        expect(screen.getByText(`ceiling ${BOUNDS.max}`)).toBeTruthy();

        // The messages arrive and the column is a row again, with the members
        // list in it. Nothing changed size: the skeleton was simply taken out and
        // the conversation put in, so a measurement waiting on a resize waits
        // forever.
        await act(async () => rerender(<SwappingRow ready />));
        expect(screen.getByText("ceiling 540")).toBeTruthy();
    });
});

/**
 * A neighbour that is not a flex row.
 *
 * The descent follows `flex-grow` down, and `flex-grow` on the child of anything
 * else is a declaration nothing acts on. The conversation's scroller is an
 * ordinary block, and a child of it carrying the class for a reason of its own
 * would be read as the thing the whole row yields to - pinning every panel near
 * its minimum, quietly, for a class nobody thought was load-bearing.
 */
function BlockInside() {
    const { ceiling, measure } = usePaneCeiling(BOUNDS);
    return (
        <div style={{ display: "flex" }}>
            <aside ref={measure} data-width={300}>
                <span>ceiling {ceiling}</span>
            </aside>
            <div data-width={400} style={{ flexGrow: 1, display: "block" }}>
                <div data-width={120} style={{ flexGrow: 1 }}>
                    a list, not a row
                </div>
            </div>
        </div>
    );
}

describe("the descent", () => {
    it("stops where nothing divides, rather than reading a class off a block", () => {
        // 300 beside 400 is 340. Walked into the block it would be 300 beside
        // 120, which is the minimum and a panel held there for no reason.
        render(<BlockInside />);
        expect(screen.getByText("ceiling 340")).toBeTruthy();
    });
});

/**
 * The list and the members column, measuring the same conversation.
 *
 * Both of them work out what they may grow to from the room that one
 * conversation has to spare, and neither can see the other. Handed that room
 * whole, they both take it: each gives back what it is over by, each then reads
 * the other's pixels as going spare and claims them, and the pair is over again
 * - a cycle a resize observer runs every frame, with the conversation under its
 * floor on half of them and nobody having touched a divider.
 */
const LIST = { min: 208, max: 480 };
const MEMBERS = { min: 208, max: 420 };
/** A 1024 window, less the rail and the dividers. */
const ROW = 957;

/** One that can be asked to deliver, so a settling pass can be run a frame at a
 *  time and watched for the two of them taking turns. */
function observerOnDemand(frames: (() => void)[]): void {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(private readonly ran: () => void) {
                frames.push(ran);
            }
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {
                const at = frames.indexOf(this.ran);
                if (at >= 0) frames.splice(at, 1);
            }
        }
    );
}

/** The list remembers 480 from a wider monitor; the members column is at the
 *  width it opens at. Both are drawn at whatever their ceiling allows, which is
 *  what feeds the next measurement. */
function TwoPanels() {
    const list = usePaneCeiling(LIST);
    const members = usePaneCeiling(MEMBERS);
    const listWidth = Math.min(480, list.ceiling);
    const membersWidth = Math.min(240, members.ceiling);
    const conversation = ROW - listWidth - membersWidth;
    return (
        <div style={{ display: "flex" }}>
            <aside ref={list.measure} data-width={listWidth}>
                list
            </aside>
            <div data-width={ROW - listWidth} style={{ flexGrow: 1, display: "flex" }}>
                <div data-width={conversation} style={{ flexGrow: 1 }}>
                    conversation
                </div>
                <aside ref={members.measure} data-width={membersWidth}>
                    members
                </aside>
            </div>
            <p data-testid="widths">{`${listWidth}/${membersWidth}/${conversation}`}</p>
        </div>
    );
}

describe("two panels beside one conversation", () => {
    const frames: (() => void)[] = [];

    beforeEach(() => {
        frames.length = 0;
        observerOnDemand(frames);
    });

    /** One delivery of every observation, which is what a browser does per
     *  frame. */
    async function settle(): Promise<string> {
        await act(async () => {
            for (const ran of [...frames]) ran();
        });
        return screen.getByTestId("widths").textContent ?? "";
    }

    it("lands on one arrangement instead of trading the same pixels every frame", async () => {
        render(<TwoPanels />);
        const seen: string[] = [];
        for (let pass = 0; pass < 8; pass += 1) seen.push(await settle());

        // Settled, not alternating: the defect this replaces reads 357/208 and
        // 389/240 turn and turn about, for as long as the window is that size.
        expect(new Set(seen.slice(-4)).size).toBe(1);
        expect(new Set(seen).size).toBeLessThan(seen.length);
    });

    it("never draws the conversation under its floor on the way there", async () => {
        render(<TwoPanels />);
        for (let pass = 0; pass < 8; pass += 1) {
            const conversation = Number((await settle()).split("/")[2]);
            expect(conversation).toBeGreaterThanOrEqual(CONVERSATION_FLOOR);
        }
    });
});
