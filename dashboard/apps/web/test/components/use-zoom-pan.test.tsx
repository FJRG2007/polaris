// @vitest-environment jsdom

/**
 * A pan or a wheel never renders.
 *
 * The lag this exists to prevent was a React render on every pointer move and
 * every wheel event over a large picture. So it is asserted with a render
 * counter: a whole drag, and a whole burst of wheel, cost no render while they
 * last, move the picture through its transform once per animation frame, and
 * are committed to React exactly once when they settle.
 */

import { useZoomPan } from "@polaris/ui/use-zoom-pan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let renders = 0;
let frames: FrameRequestCallback[] = [];

/** Runs the animation frames that were asked for, the way the browser would. */
function flushFrames() {
    const due = frames;
    frames = [];
    for (const callback of due) callback(0);
}

function Probe() {
    const look = useZoomPan();
    renders += 1;
    return (
        <div data-testid="frame" ref={look.frameRef} {...look.frameProps}>
            <div data-testid="target" ref={look.targetRef} />
            <span data-testid="scale">{look.zoom.scale.toFixed(2)}</span>
            <button type="button" onClick={look.zoomIn}>
                in
            </button>
        </div>
    );
}

beforeEach(() => {
    renders = 0;
    frames = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    if (typeof window.PointerEvent === "undefined") {
        class PointerEventShim extends MouseEvent {
            readonly pointerId: number;
            readonly pointerType: string;
            constructor(type: string, init: PointerEventInit = {}) {
                super(type, init);
                this.pointerId = init.pointerId ?? 1;
                this.pointerType = init.pointerType ?? "mouse";
            }
        }
        vi.stubGlobal("PointerEvent", PointerEventShim);
    }
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({})
    } as DOMRect);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("useZoomPan", () => {
    it("pans a zoomed picture without a render per pointer move", () => {
        render(<Probe />);
        fireEvent.click(screen.getByText("in"));
        expect(screen.getByTestId("scale").textContent).toBe("1.50");
        const frame = screen.getByTestId("frame");
        const target = screen.getByTestId("target");
        const before = renders;
        const start = target.style.transform;

        fireEvent.pointerDown(frame, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 500, clientY: 250 });
        for (let step = 1; step <= 50; step += 1) {
            fireEvent.pointerMove(frame, { pointerId: 1, pointerType: "mouse", clientX: 500 - step * 2, clientY: 250 });
        }
        // Fifty moves, one frame asked for, and no render at all.
        expect(frames).toHaveLength(1);
        expect(renders).toBe(before);
        flushFrames();
        expect(target.style.transform).not.toBe(start);
        expect(target.style.transform).toBe("translate3d(-100px, 0px, 0) scale(1.5)");
        expect(target.style.willChange).toBe("transform");
        expect(renders).toBe(before);

        fireEvent.pointerUp(frame, { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 250 });
        // Settled: one render, and the layer hint is taken off so the picture
        // is re-rastered sharp.
        expect(renders).toBe(before + 1);
        expect(target.style.willChange).toBe("");
    });

    it("zooms on a burst of wheel without a render until it settles", () => {
        render(<Probe />);
        const frame = screen.getByTestId("frame");
        const target = screen.getByTestId("target");
        const before = renders;
        for (let step = 0; step < 30; step += 1) {
            frame.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, clientX: 750, clientY: 250, cancelable: true }));
        }
        expect(renders).toBe(before);
        flushFrames();
        expect(target.style.transform).toMatch(/^translate3d\(-?\d+(\.\d+)?px, 0px, 0\) scale\(/);
        expect(renders).toBe(before);
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(renders).toBe(before + 1);
        expect(Number(screen.getByTestId("scale").textContent)).toBeGreaterThan(1.5);
    });

    it("keeps the wheel from scrolling or zooming the page", () => {
        render(<Probe />);
        const wheel = new WheelEvent("wheel", { deltaY: -40, ctrlKey: true, cancelable: true });
        screen.getByTestId("frame").dispatchEvent(wheel);
        expect(wheel.defaultPrevented).toBe(true);
    });

    it("does not move an unzoomed picture on a single-pointer drag", () => {
        render(<Probe />);
        const frame = screen.getByTestId("frame");
        fireEvent.pointerDown(frame, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 500, clientY: 250 });
        fireEvent.pointerMove(frame, { pointerId: 1, pointerType: "mouse", clientX: 300, clientY: 250 });
        expect(frames).toHaveLength(0);
    });

    it("pinches with two fingers around their midpoint", () => {
        render(<Probe />);
        const frame = screen.getByTestId("frame");
        const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", id: number, x: number) =>
            fireEvent[type](frame, { pointerId: id, pointerType: "touch", button: 0, clientX: x, clientY: 250 });
        touch("pointerDown", 1, 450);
        touch("pointerDown", 2, 550);
        touch("pointerMove", 2, 650);
        touch("pointerMove", 1, 350);
        const before = renders;
        touch("pointerUp", 1, 350);
        touch("pointerUp", 2, 650);
        expect(renders).toBe(before + 1);
        // Spread from 100px to 300px: three times.
        expect(screen.getByTestId("scale").textContent).toBe("3.00");
    });

    it("toggles on a double-tap and on a double-click", () => {
        render(<Probe />);
        const frame = screen.getByTestId("frame");
        const tap = () => {
            fireEvent.pointerDown(frame, { pointerId: 1, pointerType: "touch", button: 0, clientX: 500, clientY: 250 });
            fireEvent.pointerUp(frame, { pointerId: 1, pointerType: "touch", button: 0, clientX: 500, clientY: 250 });
        };
        tap();
        tap();
        expect(screen.getByTestId("scale").textContent).toBe("3.00");
        // The dblclick a browser may send after that double-tap is ignored.
        fireEvent.doubleClick(frame, { clientX: 500, clientY: 250 });
        expect(screen.getByTestId("scale").textContent).toBe("3.00");
    });
});
