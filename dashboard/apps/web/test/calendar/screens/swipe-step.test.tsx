// @vitest-environment jsdom

/**
 * Swiping the calendar sideways on a phone steps it to the next or previous
 * page.
 *
 * What is pinned:
 * - a quick, mostly sideways move far enough is a swipe: left goes forward,
 *   right goes back;
 * - a short, slow or mostly vertical move is not;
 * - the hook only acts on a phone-sized screen, for one finger, and never for a
 *   touch that starts inside a dialog.
 */

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SWIPE_DISTANCE,
    SWIPE_MS,
    swipeDirection,
    useSwipeStep
} from "@polaris-app/calendar/src/screens/swipe-step";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("swipeDirection", () => {
    it("goes forward on a swipe to the left and back on one to the right", () => {
        expect(swipeDirection(-SWIPE_DISTANCE - 10, 5, 200)).toBe(1);
        expect(swipeDirection(SWIPE_DISTANCE + 10, -5, 200)).toBe(-1);
    });

    it("ignores a move that is too short, too slow or mostly vertical", () => {
        expect(swipeDirection(-(SWIPE_DISTANCE - 1), 0, 200)).toBeNull();
        expect(swipeDirection(-200, 0, SWIPE_MS + 1)).toBeNull();
        expect(swipeDirection(-100, 80, 200)).toBeNull();
    });
});

function touch(target: Element, type: string, x: number, y: number, fingers = 1) {
    const point = { clientX: x, clientY: y, target } as unknown as Touch;
    const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
    Object.defineProperty(event, "touches", {
        value: type === "touchend" ? [] : Array.from({ length: fingers }, () => point)
    });
    Object.defineProperty(event, "changedTouches", { value: [point] });
    target.dispatchEvent(event);
}

function mount(phone: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone, media: query }));
    const step = vi.fn();
    function Harness() {
        const ref = useRef<HTMLDivElement>(null);
        useSwipeStep(ref, step);
        return (
            <div ref={ref}>
                <p id="cell">day</p>
                <div role="dialog">
                    <p id="inside">dialog</p>
                </div>
            </div>
        );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<Harness />));
    return { step, host, root };
}

describe("useSwipeStep", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = "";
    });

    it("steps forward and back on a phone", () => {
        const { step, host, root } = mount(true);
        const cell = host.querySelector("#cell")!;
        touch(cell, "touchstart", 300, 200);
        touch(cell, "touchend", 150, 210);
        touch(cell, "touchstart", 100, 200);
        touch(cell, "touchend", 260, 190);
        expect(step.mock.calls).toEqual([[1], [-1]]);
        act(() => root.unmount());
    });

    it("does nothing on a wide screen, for two fingers or inside a dialog", () => {
        const wide = mount(false);
        const cell = wide.host.querySelector("#cell")!;
        touch(cell, "touchstart", 300, 200);
        touch(cell, "touchend", 100, 200);
        expect(wide.step).not.toHaveBeenCalled();
        act(() => wide.root.unmount());

        const phone = mount(true);
        const own = phone.host.querySelector("#cell")!;
        touch(own, "touchstart", 300, 200, 2);
        touch(own, "touchend", 100, 200);
        const inside = phone.host.querySelector("#inside")!;
        touch(inside, "touchstart", 300, 200);
        touch(inside, "touchend", 100, 200);
        expect(phone.step).not.toHaveBeenCalled();
        act(() => phone.root.unmount());
    });

    it("leaves a sideways pan alone while the page is pinched in", () => {
        const { step, host, root } = mount(true);
        vi.stubGlobal("visualViewport", { scale: 2 });
        const cell = host.querySelector("#cell")!;
        touch(cell, "touchstart", 300, 200);
        touch(cell, "touchend", 100, 200);
        expect(step).not.toHaveBeenCalled();
        act(() => root.unmount());
    });
});
