// @vitest-environment jsdom

/**
 * Pulling a bottom sheet down to close it from anywhere on it: a clear pull
 * down closes it, a flick closes it, and a scroll, a sideways swipe, a press on
 * a field or a short pull leaves it where it is.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../src/components/dialog";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    createSheetSwipe,
    DISMISS_MAX,
    sheetAxis,
    sheetCloses,
    sheetOffset,
    type SheetSample
} from "../src/lib/sheet-swipe";

describe("the decision", () => {
    it("waits a few pixels, then takes only a move clearly downwards", () => {
        expect(sheetAxis(1, 4)).toBe("undecided");
        expect(sheetAxis(2, 20)).toBe("dismiss");
        // Sideways, upwards, or too diagonal to tell: not a close.
        expect(sheetAxis(20, 2)).toBe("other");
        expect(sheetAxis(0, -20)).toBe("other");
        expect(sheetAxis(15, 15)).toBe("other");
    });

    it("closes past a quarter of the height or on a flick, and not on the way back up", () => {
        expect(sheetCloses(100, 0, 400)).toBe(true);
        expect(sheetCloses(90, 0, 400)).toBe(false);
        // A tall sheet never needs more than DISMISS_MAX.
        expect(sheetCloses(DISMISS_MAX, 0, 2000)).toBe(true);
        // A flick closes from a short pull, a twitch does not.
        expect(sheetCloses(30, 0.8, 400)).toBe(true);
        expect(sheetCloses(10, 0.8, 400)).toBe(false);
        // Pulled far, but moving back up when let go.
        expect(sheetCloses(150, -0.5, 400)).toBe(false);
        expect(sheetCloses(0, 2, 400)).toBe(false);
    });

    it("follows the finger down and gives only a little upwards", () => {
        expect(sheetOffset(50)).toBe(50);
        expect(sheetOffset(-100)).toBeGreaterThan(-30);
        expect(sheetOffset(-100)).toBeLessThan(0);
    });
});

describe("the machine", () => {
    const at = (y: number, t: number, x = 100): SheetSample => ({ x, y, t });

    function machine() {
        const draw = vi.fn();
        const finish = vi.fn();
        return { draw, finish, swipe: createSheetSwipe({ height: () => 400, draw, finish }) };
    }

    it("locks onto a pull down, measured from where it locked, and closes when let go far", () => {
        const { draw, finish, swipe } = machine();
        swipe.start(at(100, 0));
        expect(swipe.move(at(104, 10), true)).toBe(false);
        expect(swipe.move(at(112, 20), true)).toBe(true);
        expect(draw).toHaveBeenLastCalledWith(0);
        swipe.move(at(240, 400), true);
        expect(draw).toHaveBeenLastCalledWith(128);
        expect(swipe.end()).toBe(true);
        expect(finish).toHaveBeenCalledWith(true, 128);
    });

    it("lets a sideways swipe or an upward scroll go for the rest of the touch", () => {
        const { draw, swipe } = machine();
        swipe.start(at(100, 0));
        expect(swipe.move(at(102, 10, 130), true)).toBe(false);
        expect(swipe.phase).toBe("idle");
        // Coming down afterwards is still not this gesture.
        expect(swipe.move(at(300, 20, 130), true)).toBe(false);
        swipe.start(at(100, 0));
        expect(swipe.move(at(80, 10), true)).toBe(false);
        expect(swipe.phase).toBe("idle");
        expect(draw).not.toHaveBeenCalled();
    });

    it("never takes a touch the browser already scrolls", () => {
        const { swipe } = machine();
        swipe.start(at(100, 0));
        expect(swipe.move(at(130, 10), false)).toBe(false);
        expect(swipe.phase).toBe("idle");
    });

    it("comes back when let go short, slowly, or cancelled", () => {
        const { finish, swipe } = machine();
        swipe.start(at(100, 0));
        swipe.move(at(112, 10), true);
        swipe.move(at(150, 1000), true);
        swipe.end();
        expect(finish).toHaveBeenLastCalledWith(false, 38);
        swipe.start(at(100, 0));
        swipe.move(at(112, 10), true);
        swipe.move(at(400, 1000), true);
        swipe.cancel();
        expect(finish).toHaveBeenLastCalledWith(false, 288);
    });
});

describe("on a sheet", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // A phone-sized window, with no reduced motion asked for.
        window.matchMedia = ((query: string) => ({
            matches: query.includes("max-width"),
            media: query,
            addEventListener() {},
            removeEventListener() {}
        })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
        vi.useRealTimers();
        cleanup();
    });

    function Sheet({ swipeToClose }: { swipeToClose?: boolean }) {
        const [open, setOpen] = useState(true);
        return (
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent aria-describedby={undefined} swipeToClose={swipeToClose}>
                    <DialogTitle>Actions</DialogTitle>
                    <div data-testid="list" style={{ overflowY: "auto" }}>
                        <button type="button">Reply</button>
                    </div>
                    <input aria-label="Name" />
                </DialogContent>
            </Dialog>
        );
    }

    // Radix's scroll lock reads `changedTouches`, so both are given.
    const touch = (y: number, x = 100) => {
        const list = [{ identifier: 1, clientX: x, clientY: y }];
        return { touches: list, changedTouches: list };
    };

    function pull(target: Element, to: number, x = 100) {
        fireEvent.touchStart(target, touch(100));
        fireEvent.touchMove(target, touch(112, x === 100 ? 100 : 100 + (x - 100) / 3));
        fireEvent.touchMove(target, touch(to, x));
        fireEvent.touchEnd(target, { touches: [], changedTouches: touch(to, x).touches });
        act(() => {
            vi.advanceTimersByTime(500);
        });
    }

    it("closes when pulled down from anywhere on it, not only the handle", () => {
        render(<Sheet />);
        pull(screen.getByRole("button", { name: "Reply" }), 600);
        expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("stays when the list under the finger is scrolled down", () => {
        render(<Sheet />);
        const list = screen.getByTestId("list");
        Object.defineProperty(list, "scrollHeight", { value: 900 });
        Object.defineProperty(list, "clientHeight", { value: 300 });
        list.scrollTop = 120;
        pull(screen.getByRole("button", { name: "Reply" }), 600);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("stays for a sideways swipe and for a press on a field", () => {
        render(<Sheet />);
        pull(screen.getByRole("button", { name: "Reply" }), 110, 400);
        expect(screen.getByRole("dialog")).toBeTruthy();
        pull(screen.getByRole("textbox", { name: "Name" }), 600);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("can be switched off", () => {
        render(<Sheet swipeToClose={false} />);
        pull(screen.getByRole("button", { name: "Reply" }), 600);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });
});
