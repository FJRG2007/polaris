// @vitest-environment jsdom

/**
 * Swiping a message to the right to answer it, on a phone.
 *
 * The state machine first, with no DOM: a short drag clearly to the right
 * replies and ticks once; one let go short of the line, one that starts mostly
 * vertical (a scroll), one the browser already took, one that goes left, or one
 * with a second finger does nothing. Then what matters most to somebody using
 * it: every way a touch can end leaves the next swipe working, however many
 * came before. Last, the hook on a real row, with touch events.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    axisOf,
    createSwipe,
    MAX_PULL,
    pullFor,
    REPLY_AT,
    useSwipeReply,
    type TouchPoint
} from "@/app/(app)/chat/swipe-reply";

afterEach(cleanup);

describe("the arithmetic", () => {
    it("follows the finger one to one up to the line, then resists", () => {
        expect(pullFor(-20)).toBe(0);
        expect(pullFor(30)).toBe(30);
        expect(pullFor(REPLY_AT)).toBe(REPLY_AT);
        const far = pullFor(REPLY_AT + 200);
        expect(far).toBeGreaterThan(REPLY_AT);
        expect(far).toBeLessThan(MAX_PULL);
    });

    it("replies at a short distance, the way WhatsApp does", () => {
        expect(REPLY_AT).toBeGreaterThanOrEqual(56);
        expect(REPLY_AT).toBeLessThanOrEqual(72);
    });

    it("waits past the slop, then locks only on a clearly sideways move", () => {
        expect(axisOf(3, 2)).toBe("undecided");
        expect(axisOf(20, 4)).toBe("reply");
        expect(axisOf(16, 10)).toBe("reply");
        // Mostly down is a scroll.
        expect(axisOf(4, 20)).toBe("other");
        expect(axisOf(11, 12)).toBe("other");
        // A finger that wobbles as it lands is not written off yet...
        expect(axisOf(9, 8)).toBe("undecided");
        // ...but a diagonal that never makes up its mind is not a swipe.
        expect(axisOf(24, 20)).toBe("other");
        // Left is not a reply.
        expect(axisOf(-20, 0)).toBe("other");
    });
});

function machine() {
    const draws: Array<[number, boolean, boolean]> = [];
    const output = {
        draw: vi.fn((pull: number, armed: boolean, settle: boolean) => {
            draws.push([pull, armed, settle]);
        }),
        tick: vi.fn(),
        reply: vi.fn()
    };
    return { swipe: createSwipe(output), output, draws };
}

const at = (x: number, y: number, id = 1): TouchPoint[] => [{ id, x, y }];

/** One finger dragged along `path` and lifted, the way a phone reports it. */
function swipeAlong(
    swipe: ReturnType<typeof createSwipe>,
    path: readonly (readonly [number, number])[],
    cancelable = true
) {
    const [first, ...rest] = path;
    swipe.start(at(first![0], first![1]));
    const claimed = rest.map(([x, y]) => swipe.move(at(x, y), cancelable));
    return { claimed, lifted: swipe.end() };
}

const SHORT: ReadonlyArray<readonly [number, number]> = [
    [20, 100],
    [26, 102],
    [34, 104],
    [50, 105],
    [70, 106],
    [88, 106]
];

describe("the machine", () => {
    it("replies on a short swipe, ticks once at the line, and springs back", () => {
        const { swipe, output, draws } = machine();
        const { claimed, lifted } = swipeAlong(swipe, SHORT);
        expect(output.reply).toHaveBeenCalledTimes(1);
        expect(output.tick).toHaveBeenCalledTimes(1);
        // The undecided first move is the browser's; every move after the lock
        // is claimed, so the list cannot scroll under it.
        expect(claimed).toEqual([false, true, true, true, true]);
        expect(lifted).toBe(true);
        expect(draws.at(-1)).toEqual([0, false, true]);
        expect(swipe.phase).toBe("idle");
    });

    it("does nothing when let go short of the line", () => {
        const { swipe, output } = machine();
        swipeAlong(swipe, [
            [20, 100],
            [40, 101],
            [60, 101]
        ]);
        expect(output.reply).not.toHaveBeenCalled();
        expect(output.tick).not.toHaveBeenCalled();
    });

    it("cancels when dragged back under the line before letting go", () => {
        const { swipe, output } = machine();
        swipeAlong(swipe, [
            [20, 100],
            [100, 100],
            [40, 100]
        ]);
        expect(output.reply).not.toHaveBeenCalled();
    });

    it("never starts on a vertical scroll, and never draws for one", () => {
        const { swipe, output } = machine();
        const { claimed, lifted } = swipeAlong(swipe, [
            [20, 100],
            [22, 120],
            [140, 160]
        ]);
        expect(claimed).toEqual([false, false]);
        expect(lifted).toBe(false);
        expect(output.draw).not.toHaveBeenCalled();
        expect(output.reply).not.toHaveBeenCalled();
    });

    it("leaves a touch the browser is already scrolling alone", () => {
        const { swipe, output } = machine();
        swipeAlong(swipe, SHORT, false);
        expect(output.reply).not.toHaveBeenCalled();
        expect(output.draw).not.toHaveBeenCalled();
    });

    it("ignores a swipe to the left", () => {
        const { swipe, output } = machine();
        swipeAlong(swipe, [
            [200, 100],
            [150, 100],
            [80, 100]
        ]);
        expect(output.reply).not.toHaveBeenCalled();
    });

    it("stops at a second finger, mid-swipe or from the start", () => {
        const { swipe, output, draws } = machine();
        swipe.start(at(20, 100));
        swipe.move(at(60, 100), true);
        swipe.move(at(100, 100), true);
        swipe.start([
            { id: 1, x: 100, y: 100 },
            { id: 2, x: 300, y: 300 }
        ]);
        expect(swipe.phase).toBe("idle");
        expect(draws.at(-1)).toEqual([0, false, true]);
        expect(swipe.end()).toBe(false);
        expect(output.reply).not.toHaveBeenCalled();

        swipe.start([
            { id: 1, x: 20, y: 100 },
            { id: 2, x: 300, y: 300 }
        ]);
        expect(swipe.move(at(120, 100), true)).toBe(false);
        expect(output.reply).not.toHaveBeenCalled();
    });

    it("ignores moves of a finger it is not following", () => {
        const { swipe, output } = machine();
        swipe.start(at(20, 100, 1));
        expect(swipe.move(at(120, 100, 9), true)).toBe(false);
        expect(swipe.phase).toBe("idle");
        swipe.end();
        expect(output.reply).not.toHaveBeenCalled();
    });

    it("never replies when cancelled, armed or not", () => {
        const { swipe, output, draws } = machine();
        swipe.start(at(20, 100));
        swipe.move(at(60, 100), true);
        swipe.move(at(120, 100), true);
        swipe.cancel();
        expect(output.reply).not.toHaveBeenCalled();
        expect(draws.at(-1)).toEqual([0, false, true]);
        expect(swipe.end()).toBe(false);
        expect(output.reply).not.toHaveBeenCalled();
    });
});

describe("again and again", () => {
    it("works after many swipes in a row", () => {
        const { swipe, output } = machine();
        for (let n = 0; n < 25; n += 1) swipeAlong(swipe, SHORT);
        expect(output.reply).toHaveBeenCalledTimes(25);
        expect(output.tick).toHaveBeenCalledTimes(25);
    });

    it("works after every kind of interrupted touch", () => {
        const { swipe, output } = machine();
        const interruptions: Array<() => void> = [
            // The system took the touch.
            () => {
                swipe.start(at(20, 100));
                swipe.move(at(90, 100), true);
                swipe.cancel();
            },
            // A second finger.
            () => {
                swipe.start(at(20, 100));
                swipe.move(at(90, 100), true);
                swipe.start([
                    { id: 1, x: 90, y: 100 },
                    { id: 2, x: 200, y: 200 }
                ]);
            },
            // A scroll.
            () => {
                swipeAlong(swipe, [
                    [20, 100],
                    [22, 140],
                    [24, 300]
                ]);
            },
            // A touch the browser took.
            () => {
                swipeAlong(swipe, SHORT, false);
            },
            // A finger put down and never lifted - the next touch starts over.
            () => {
                swipe.start(at(20, 100));
                swipe.move(at(90, 100), true);
            },
            // A tap.
            () => {
                swipe.start(at(20, 100));
                swipe.end();
            }
        ];
        let expected = 0;
        for (let round = 0; round < 3; round += 1) {
            for (const interrupt of interruptions) {
                interrupt();
                swipeAlong(swipe, SHORT);
                expected += 1;
                expect(output.reply).toHaveBeenCalledTimes(expected);
            }
        }
    });
});

// ---- The hook, on a row -----------------------------------------------------

function Row({ onReply }: { onReply?: () => void }) {
    const swipe = useSwipeReply(onReply);
    return (
        <div>
            <span ref={swipe.cue} data-testid="cue" />
            <div ref={swipe.line} data-testid="row">
                a message
            </div>
        </div>
    );
}

/** A touch event with the lists jsdom's plain Event does not carry. */
function touchEvent(type: string, touches: readonly TouchPoint[], cancelable = true): Event {
    const event = new Event(type, { bubbles: true, cancelable });
    const list = touches.map((touch) => ({
        identifier: touch.id,
        clientX: touch.x,
        clientY: touch.y
    }));
    Object.defineProperty(event, "touches", { value: list });
    return event;
}

function drag(row: Element, path: readonly (readonly [number, number])[]) {
    const [start, ...rest] = path;
    row.dispatchEvent(touchEvent("touchstart", at(start![0], start![1])));
    const moves = rest.map(([x, y]) => {
        const event = touchEvent("touchmove", at(x, y));
        row.dispatchEvent(event);
        return event.defaultPrevented;
    });
    const end = touchEvent("touchend", []);
    row.dispatchEvent(end);
    return { moves, end: end.defaultPrevented };
}

const vibrate = vi.fn();

beforeEach(() => {
    vibrate.mockReset();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
});

describe("the row", () => {
    it("replies on a short swipe, ticks, claims the moves and the lift", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        const { moves, end } = drag(getByTestId("row"), SHORT);
        expect(onReply).toHaveBeenCalledTimes(1);
        expect(vibrate).toHaveBeenCalledTimes(1);
        expect(moves.slice(1).every(Boolean)).toBe(true);
        // Claiming the lift is what keeps it from also being a tap.
        expect(end).toBe(true);
        expect(getByTestId("row").style.transform).toBe("");
    });

    it("moves the line and grows the arrow while the finger is down", () => {
        const { getByTestId } = render(<Row onReply={() => {}} />);
        const row = getByTestId("row");
        row.dispatchEvent(touchEvent("touchstart", at(10, 100)));
        row.dispatchEvent(touchEvent("touchmove", at(40, 101)));
        expect(row.style.transform).toBe("translateX(30px)");
        expect(Number(getByTestId("cue").style.opacity)).toBeGreaterThan(0);
        row.dispatchEvent(touchEvent("touchmove", at(100, 101)));
        expect(getByTestId("cue").dataset.armed).toBe("true");
        row.dispatchEvent(touchEvent("touchcancel", []));
        expect(row.style.transform).toBe("");
        expect(getByTestId("cue").dataset.armed).toBe("false");
    });

    it("springs back and stays usable when the list scrolls mid-swipe", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        const row = getByTestId("row");
        row.dispatchEvent(touchEvent("touchstart", at(10, 100)));
        row.dispatchEvent(touchEvent("touchmove", at(100, 100)));
        document.dispatchEvent(new Event("scroll"));
        expect(row.style.transform).toBe("");
        row.dispatchEvent(touchEvent("touchend", []));
        expect(onReply).not.toHaveBeenCalled();
        drag(row, SHORT);
        expect(onReply).toHaveBeenCalledTimes(1);
    });

    it("keeps working through a re-render mid-drag and ten swipes after", () => {
        const onReply = vi.fn();
        const { getByTestId, rerender } = render(<Row onReply={onReply} />);
        const row = getByTestId("row");
        row.dispatchEvent(touchEvent("touchstart", at(10, 100)));
        row.dispatchEvent(touchEvent("touchmove", at(60, 100)));
        // The reply handler changes identity, as it does on every render.
        rerender(<Row onReply={() => onReply()} />);
        row.dispatchEvent(touchEvent("touchmove", at(100, 100)));
        row.dispatchEvent(touchEvent("touchend", []));
        expect(onReply).toHaveBeenCalledTimes(1);
        for (let n = 0; n < 10; n += 1) drag(row, SHORT);
        expect(onReply).toHaveBeenCalledTimes(11);
    });

    it("springs back when replying stops being offered mid-swipe", () => {
        const onReply = vi.fn();
        const { getByTestId, rerender } = render(<Row onReply={onReply} />);
        const row = getByTestId("row");
        row.dispatchEvent(touchEvent("touchstart", at(10, 100)));
        row.dispatchEvent(touchEvent("touchmove", at(100, 100)));
        act(() => rerender(<Row />));
        expect(row.style.transform).toBe("");
        row.dispatchEvent(touchEvent("touchend", []));
        expect(onReply).not.toHaveBeenCalled();
    });

    it("leaves a vertical scroll's moves to the browser", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        const { moves } = drag(getByTestId("row"), [
            [10, 100],
            [14, 130],
            [120, 160]
        ]);
        expect(moves).toEqual([false, false]);
        expect(onReply).not.toHaveBeenCalled();
    });

    it("ignores a mouse", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        const row = getByTestId("row");
        row.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 100 })
        );
        row.dispatchEvent(
            new MouseEvent("mousemove", { bubbles: true, clientX: 140, clientY: 100 })
        );
        row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 140, clientY: 100 }));
        expect(onReply).not.toHaveBeenCalled();
        expect(row.style.transform).toBe("");
    });

    it("is not there at all where replying is not offered", () => {
        const { getByTestId } = render(<Row />);
        const row = getByTestId("row");
        drag(row, SHORT);
        expect(row.style.transform).toBe("");
    });
});
