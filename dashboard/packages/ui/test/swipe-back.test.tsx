// @vitest-environment jsdom

/**
 * Swiping a phone screen to the right to go back: the screen follows the
 * finger, letting go far enough along or flicking goes back by pressing the
 * screen's own back control, and anything short of that - or a scroll, or a
 * press on something with a sideways gesture of its own - leaves it in place.
 */

import type { ReactNode } from "react";
import { ShellMain } from "../src/shell/shell-main";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    COMMIT_FRACTION,
    createSwipeBack,
    goesBack,
    swipeAxis,
    SWIPE_BACK_EDGE
} from "../src/shell/swipe-back";

describe("the decision", () => {
    it("takes a move clearly to the right, and leaves a scroll or a swipe left alone", () => {
        expect(swipeAxis(4, 1)).toBe("undecided");
        expect(swipeAxis(20, 2)).toBe("back");
        expect(swipeAxis(2, 20)).toBe("other");
        expect(swipeAxis(-20, 0)).toBe("other");
        // Mirrored in a right-to-left layout.
        expect(swipeAxis(-20, 0, -1)).toBe("back");
    });

    it("goes back past the line or on a flick, and not when let go on the way back", () => {
        expect(goesBack(400 * COMMIT_FRACTION + 1, 0, 400)).toBe(true);
        expect(goesBack(40, 0.1, 400)).toBe(false);
        expect(goesBack(40, 0.9, 400)).toBe(true);
        expect(goesBack(300, -0.5, 400)).toBe(false);
        expect(goesBack(0, 2, 400)).toBe(false);
    });
});

function machine() {
    const draws: number[] = [];
    const finished: Array<[boolean, number]> = [];
    const swipe = createSwipeBack({
        width: () => 400,
        draw: (offset) => draws.push(offset),
        finish: (back, offset) => finished.push([back, offset])
    });
    return { swipe, draws, finished };
}

describe("the gesture", () => {
    it("follows the finger from where it locked, and goes back when let go far along", () => {
        const { swipe, draws, finished } = machine();
        swipe.start({ x: 50, y: 300, t: 0 });
        expect(swipe.move({ x: 62, y: 301, t: 16 }, true)).toBe(true);
        expect(draws.at(-1)).toBe(0);
        swipe.move({ x: 262, y: 305, t: 600 }, true);
        expect(draws.at(-1)).toBe(200);
        expect(swipe.end()).toBe(true);
        expect(finished).toEqual([[true, 200]]);
        expect(swipe.phase).toBe("idle");
    });

    it("returns when let go early and slowly", () => {
        const { swipe, finished } = machine();
        swipe.start({ x: 50, y: 300, t: 0 });
        swipe.move({ x: 62, y: 300, t: 100 }, true);
        swipe.move({ x: 112, y: 300, t: 900 }, true);
        swipe.end();
        expect(finished).toEqual([[false, 50]]);
    });

    it("goes back on a short flick", () => {
        const { swipe, finished } = machine();
        swipe.start({ x: 50, y: 300, t: 0 });
        swipe.move({ x: 62, y: 300, t: 10 }, true);
        swipe.move({ x: 122, y: 300, t: 60 }, true);
        swipe.end();
        expect(finished[0]?.[0]).toBe(true);
    });

    it("lets a scroll go, and never takes a touch the browser or something else already has", () => {
        const scroll = machine();
        scroll.swipe.start({ x: 50, y: 300, t: 0 });
        expect(scroll.swipe.move({ x: 52, y: 340, t: 16 }, true)).toBe(false);
        expect(scroll.swipe.move({ x: 200, y: 340, t: 32 }, true)).toBe(false);
        expect(scroll.draws).toEqual([]);

        const taken = machine();
        taken.swipe.start({ x: 50, y: 300, t: 0 });
        expect(taken.swipe.move({ x: 80, y: 300, t: 16 }, false)).toBe(false);

        const claimed = machine();
        claimed.swipe.start({ x: 50, y: 300, t: 0 });
        expect(claimed.swipe.move({ x: 80, y: 300, t: 16 }, true, true)).toBe(false);
        expect(claimed.finished).toEqual([]);
    });

    it("springs back when the system cancels the touch, and never goes back for it", () => {
        const { swipe, finished } = machine();
        swipe.start({ x: 50, y: 300, t: 0 });
        swipe.move({ x: 62, y: 300, t: 16 }, true);
        swipe.move({ x: 362, y: 300, t: 32 }, true);
        swipe.cancel();
        expect(finished).toEqual([[false, 300]]);
    });

    it("follows the phone app's own back gesture, and goes back or returns with it", () => {
        const { swipe, draws, finished } = machine();
        swipe.begin();
        swipe.progress(0.5);
        expect(draws.at(-1)).toBe(200);
        swipe.abandon();
        expect(finished).toEqual([[false, 200]]);
        swipe.begin();
        swipe.progress(0.25);
        swipe.commit();
        expect(finished.at(-1)).toEqual([true, 100]);
        // A back with no gesture before it (an older Android) still goes back.
        swipe.commit();
        expect(finished.at(-1)).toEqual([true, 0]);
    });
});

/** A screen inside the shell with a back arrow. */
function page(onBack: () => void, extra?: ReactNode) {
    render(
        <ShellMain>
            <button type="button" data-swipe-back="" onClick={onBack}>
                back
            </button>
            <p>conversation</p>
            {extra}
        </ShellMain>
    );
    return screen.getByText("conversation");
}

function touch(x: number, y = 300) {
    return { touches: [{ identifier: 1, clientX: x, clientY: y }] };
}

function drag(target: Element, from: number, to: number) {
    fireEvent.touchStart(target, touch(from));
    fireEvent.touchMove(target, touch(from + 12));
    fireEvent.touchMove(target, touch(to));
    fireEvent.touchEnd(target, { touches: [] });
}

describe("on a screen", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // jsdom lays nothing out: every element counts as drawn here.
        vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.restoreAllMocks();
        delete (window as unknown as { polarisMobile?: unknown }).polarisMobile;
    });

    it("slides the screen with the finger and presses its back control once let go far along", () => {
        const onBack = vi.fn();
        const body = page(onBack);
        const main = body.closest("main")!;
        fireEvent.touchStart(body, touch(100));
        fireEvent.touchMove(body, touch(112));
        fireEvent.touchMove(body, touch(600));
        expect(main.style.transform).toBe("translateX(488px)");
        fireEvent.touchEnd(body, { touches: [] });
        expect(onBack).not.toHaveBeenCalled();
        act(() => void vi.advanceTimersByTime(400));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("puts the screen back and goes nowhere on a short drag", () => {
        const onBack = vi.fn();
        const body = page(onBack);
        drag(body, 100, 160);
        act(() => void vi.advanceTimersByTime(1000));
        expect(onBack).not.toHaveBeenCalled();
        expect(body.closest("main")!.style.transform).toBe("");
    });

    it("does nothing on a screen with no back", () => {
        render(
            <ShellMain>
                <p>home</p>
            </ShellMain>
        );
        const body = screen.getByText("home");
        drag(body, 100, 700);
        expect(body.closest("main")!.style.transform).toBe("");
    });

    it("leaves a field alone, and a row with its own sideways swipe except at the edge", () => {
        const onBack = vi.fn();
        page(
            onBack,
            <>
                <input aria-label="field" />
                <div data-testid="row" style={{ touchAction: "pan-y" }}>
                    message
                </div>
            </>
        );
        drag(screen.getByLabelText("field"), 100, 700);
        const row = screen.getByTestId("row");
        expect(getComputedStyle(row).touchAction).toBe("pan-y");
        drag(row, 100, 700);
        act(() => void vi.advanceTimersByTime(1000));
        expect(onBack).not.toHaveBeenCalled();
        drag(row, SWIPE_BACK_EDGE - 4, 700);
        act(() => void vi.advanceTimersByTime(1000));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("tells the phone app it has a back, and goes back when the app's back says so", () => {
        const swipeBack = vi.fn();
        (window as unknown as { polarisMobile: unknown }).polarisMobile = { swipeBack };
        const onBack = vi.fn();
        page(onBack);
        act(() => void vi.advanceTimersByTime(200));
        expect(swipeBack).toHaveBeenLastCalledWith(true);
        let handled: boolean | undefined;
        act(() => {
            window.polarisSwipeBack!.begin();
            window.polarisSwipeBack!.progress(0.6);
            handled = window.polarisSwipeBack!.commit();
        });
        expect(handled).toBe(true);
        act(() => void vi.advanceTimersByTime(400));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it("says it has no back where there is none, so the app's history back goes on working", () => {
        const swipeBack = vi.fn();
        (window as unknown as { polarisMobile: unknown }).polarisMobile = { swipeBack };
        render(
            <ShellMain>
                <p>home</p>
            </ShellMain>
        );
        act(() => void vi.advanceTimersByTime(200));
        expect(swipeBack).toHaveBeenLastCalledWith(false);
        expect(window.polarisSwipeBack!.commit()).toBe(false);
    });
});
