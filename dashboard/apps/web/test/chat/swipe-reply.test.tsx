// @vitest-environment jsdom

/**
 * Swiping a message to the right to answer it, on a phone.
 *
 * What is asserted is what the gesture must and must not do: a finger dragged
 * right past the line replies and ticks once; one let go short of it, one that
 * starts mostly vertical (a scroll), one that goes left, or a mouse, does
 * nothing at all.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axisOf, MAX_PULL, pullFor, REPLY_AT, useSwipeReply } from "@/app/(app)/chat/swipe-reply";

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

    it("waits for a few pixels, then locks to one axis", () => {
        expect(axisOf(3, 2)).toBe("undecided");
        expect(axisOf(20, 4)).toBe("reply");
        // Mostly down is a scroll, and so is a diagonal that is not clearly sideways.
        expect(axisOf(4, 20)).toBe("other");
        expect(axisOf(12, 11)).toBe("other");
        // Left is not a reply.
        expect(axisOf(-20, 0)).toBe("other");
    });
});

function Row({ onReply }: { onReply?: () => void }) {
    const swipe = useSwipeReply(onReply);
    return (
        <div>
            <span ref={swipe.cue} data-testid="cue" />
            <div ref={swipe.line} data-testid="row" {...swipe.handlers}>
                a message
            </div>
        </div>
    );
}

/** A pointer event with the fields jsdom's MouseEvent does not carry. */
function pointer(type: string, x: number, y: number, pointerType = "touch"): Event {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperties(event, {
        pointerId: { value: 7 },
        pointerType: { value: pointerType },
        isPrimary: { value: true }
    });
    return event;
}

function drag(row: Element, path: readonly (readonly [number, number])[], pointerType = "touch") {
    const [start, ...rest] = path;
    row.dispatchEvent(pointer("pointerdown", start![0], start![1], pointerType));
    for (const [x, y] of rest) row.dispatchEvent(pointer("pointermove", x, y, pointerType));
    const end = path[path.length - 1]!;
    row.dispatchEvent(pointer("pointerup", end[0], end[1], pointerType));
}

let coarse = true;
const vibrate = vi.fn();

beforeEach(() => {
    coarse = true;
    vibrate.mockReset();
    window.matchMedia = ((query: string) => ({
        matches: query.includes("coarse") ? coarse : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
});

describe("the gesture", () => {
    it("replies once dragged right past the line, with one tick", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        drag(getByTestId("row"), [
            [10, 100],
            [30, 102],
            [60, 103],
            [90, 104],
            [120, 104]
        ]);
        expect(onReply).toHaveBeenCalledTimes(1);
        expect(vibrate).toHaveBeenCalledTimes(1);
        // And it springs back.
        expect(getByTestId("row").style.transform).toBe("");
    });

    it("moves the line and shows the arrow while the finger is down", () => {
        const { getByTestId } = render(<Row onReply={() => {}} />);
        const row = getByTestId("row");
        row.dispatchEvent(pointer("pointerdown", 10, 100));
        row.dispatchEvent(pointer("pointermove", 40, 101));
        expect(row.style.transform).toBe("translateX(30px)");
        expect(Number(getByTestId("cue").style.opacity)).toBeGreaterThan(0);
        row.dispatchEvent(pointer("pointermove", 100, 101));
        expect(getByTestId("cue").dataset.armed).toBe("true");
    });

    it("does nothing when let go short of the line", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        drag(getByTestId("row"), [
            [10, 100],
            [30, 100],
            [50, 100]
        ]);
        expect(onReply).not.toHaveBeenCalled();
        expect(vibrate).not.toHaveBeenCalled();
    });

    it("cancels when dragged back under the line before letting go", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        drag(getByTestId("row"), [
            [10, 100],
            [100, 100],
            [30, 100]
        ]);
        expect(onReply).not.toHaveBeenCalled();
    });

    it("leaves a vertical scroll alone", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        const row = getByTestId("row");
        drag(row, [
            [10, 100],
            [14, 130],
            [120, 160]
        ]);
        expect(onReply).not.toHaveBeenCalled();
        expect(row.style.transform).toBe("");
    });

    it("ignores a swipe to the left", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        drag(getByTestId("row"), [
            [200, 100],
            [150, 100],
            [80, 100]
        ]);
        expect(onReply).not.toHaveBeenCalled();
    });

    it("ignores a mouse, and a screen with no finger", () => {
        const onReply = vi.fn();
        const { getByTestId } = render(<Row onReply={onReply} />);
        drag(
            getByTestId("row"),
            [
                [10, 100],
                [120, 100]
            ],
            "mouse"
        );
        coarse = false;
        drag(getByTestId("row"), [
            [10, 100],
            [120, 100]
        ]);
        expect(onReply).not.toHaveBeenCalled();
    });

    it("is not there at all where replying is not offered", () => {
        const { getByTestId } = render(<Row />);
        const row = getByTestId("row");
        drag(row, [
            [10, 100],
            [120, 100]
        ]);
        expect(row.style.transform).toBe("");
    });
});
