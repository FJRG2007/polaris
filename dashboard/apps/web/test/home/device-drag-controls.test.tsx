// @vitest-environment jsdom

/**
 * The controls a device is dragged with: the big slider, the thermostat dial and
 * the colour wheel, and the arithmetic under them.
 *
 * A value shown while dragging is always one the device accepts - on its step,
 * inside its range - and only the one let go on is sent. Key presses are
 * gathered and sent as one. Ending where the device already is sends nothing.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ControlSlider, bigStep, fractionOf, keyedValue, snapValue, valueAt } from "@polaris/ui";
import {
    angleFromValue,
    dialValueFromPoint,
    moveSetpoint,
    nearerSetpoint,
    pointAt,
    valueFromAngle
} from "@polaris-app/places/src/screens/devices/controls/dial-math";
import { ColorWheel } from "@polaris-app/places/src/screens/devices/color-wheel";
import type { ClimateView, DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { ClimateControls } from "@polaris-app/places/src/screens/devices/climate-controls";
import { ThermostatDial } from "@polaris-app/places/src/screens/devices/controls/thermostat-dial";
import { kelvinToRgb, kelvinTrack } from "@polaris-app/places/src/screens/devices/light-controls";

beforeAll(() => {
    // jsdom has no PointerEvent; the mouse event under it carries the point.
    if (!("PointerEvent" in window)) {
        class PointerEventShim extends MouseEvent {
            readonly pointerId: number;
            constructor(type: string, init: PointerEventInit = {}) {
                super(type, init);
                this.pointerId = init.pointerId ?? 1;
            }
        }
        Object.assign(window, { PointerEvent: PointerEventShim });
    }
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function boxed(element: Element, width: number, height: number) {
    element.getBoundingClientRect = () =>
        ({
            left: 0,
            top: 0,
            right: width,
            bottom: height,
            width,
            height,
            x: 0,
            y: 0,
            toJSON: () => ({})
        }) as DOMRect;
}

const RANGE = { min: 16, max: 30, step: 0.5 };

describe("the arithmetic of a dragged value", () => {
    it("holds a value to the range and the step, counted from the minimum", () => {
        expect(snapValue(22.3, RANGE)).toBe(22.5);
        expect(snapValue(22.2, RANGE)).toBe(22);
        expect(snapValue(40, RANGE)).toBe(30);
        expect(snapValue(-5, RANGE)).toBe(16);
        expect(snapValue(Number.NaN, RANGE)).toBe(16);
        // A step that does not divide the span never lands past the maximum.
        expect(snapValue(100, { min: 2203, max: 6500, step: 50 })).toBe(2203);
        expect(snapValue(6500, { min: 2203, max: 6500, step: 50 })).toBe(6453);
        expect(snapValue(0.30000000000000004, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    });

    it("maps a point along the track to a value and back", () => {
        expect(valueAt(0, RANGE)).toBe(16);
        expect(valueAt(1, RANGE)).toBe(30);
        expect(valueAt(0.5, RANGE)).toBe(23);
        expect(valueAt(1.4, RANGE)).toBe(30);
        expect(valueAt(-1, RANGE)).toBe(16);
        expect(fractionOf(23, RANGE)).toBe(0.5);
        expect(fractionOf(99, RANGE)).toBe(1);
        expect(fractionOf(5, { min: 5, max: 5, step: 1 })).toBe(0);
    });

    it("moves by a step on the arrows, a tenth on Page keys, and to the ends on Home/End", () => {
        expect(keyedValue(22, "ArrowUp", RANGE)).toBe(22.5);
        expect(keyedValue(22, "ArrowLeft", RANGE)).toBe(21.5);
        expect(keyedValue(30, "ArrowRight", RANGE)).toBe(30);
        expect(keyedValue(16, "ArrowDown", RANGE)).toBe(16);
        expect(bigStep(RANGE)).toBe(1.5);
        expect(keyedValue(22, "PageUp", RANGE)).toBe(23.5);
        expect(keyedValue(22, "ArrowUp", RANGE, true)).toBe(23.5);
        expect(keyedValue(22, "Home", RANGE)).toBe(16);
        expect(keyedValue(22, "End", RANGE)).toBe(30);
        expect(keyedValue(null, "ArrowUp", RANGE)).toBe(16.5);
        expect(keyedValue(22, "Enter", RANGE)).toBeNull();
    });
});

describe("the dial's geometry", () => {
    const whole = { min: 16, max: 30, step: 1 };

    it("runs 270° from bottom left to bottom right", () => {
        expect(angleFromValue(16, whole)).toBe(-135);
        expect(angleFromValue(23, whole)).toBe(0);
        expect(angleFromValue(30, whole)).toBe(135);
        expect(valueFromAngle(0, whole)).toBe(23);
        expect(valueFromAngle(-135, whole)).toBe(16);
        expect(valueFromAngle(200, whole)).toBe(30);
    });

    it("reads a point on the ring, snapped to the step", () => {
        expect(dialValueFromPoint(0, -100, whole)).toBe(23);
        expect(dialValueFromPoint(100, 0, whole)).toBe(28);
        expect(dialValueFromPoint(-100, 0, whole)).toBe(18);
    });

    it("takes the gap at the bottom as the nearer end, without jumping across it", () => {
        expect(dialValueFromPoint(10, 100, whole)).toBe(30);
        expect(dialValueFromPoint(-10, 100, whole)).toBe(16);
        // Dragged down from the maximum and past the bottom: it stays at the top end.
        expect(dialValueFromPoint(-10, 100, whole, 30)).toBe(30);
        expect(dialValueFromPoint(10, 100, whole, 16)).toBe(16);
    });

    it("keeps a range's two ends apart and lets a press pick up the nearer", () => {
        const pair = { low: 20, high: 24 };
        expect(moveSetpoint(pair, "low", 26, whole)).toEqual({ low: 23, high: 24 });
        expect(moveSetpoint(pair, "high", 10, whole)).toEqual({ low: 20, high: 21 });
        expect(moveSetpoint(pair, "high", 27.4, whole)).toEqual({ low: 20, high: 27 });
        expect(nearerSetpoint(pair, 19)).toBe("low");
        expect(nearerSetpoint(pair, 23)).toBe("high");
    });
});

describe("the big slider", () => {
    function slider(onCommit = vi.fn(), props: Partial<Parameters<typeof ControlSlider>[0]> = {}) {
        render(
            <ControlSlider
                label="Brightness"
                value={40}
                min={0}
                max={100}
                step={5}
                valueText={(value) => `${value}%`}
                onCommit={onCommit}
                {...props}
            />
        );
        const element = screen.getByRole("slider", { name: "Brightness" });
        boxed(element, 200, props.orientation === "vertical" ? 200 : 44);
        return { element, onCommit };
    }

    it("shows every point of a drag and sends only the one it is let go on", () => {
        const { element, onCommit } = slider();
        fireEvent.pointerDown(element, { clientX: 20, clientY: 10, pointerId: 1 });
        expect(element.getAttribute("aria-valuenow")).toBe("10");
        fireEvent.pointerMove(element, { clientX: 150, clientY: 10, pointerId: 1 });
        expect(element.getAttribute("aria-valuenow")).toBe("75");
        expect(element.getAttribute("aria-valuetext")).toBe("75%");
        fireEvent.pointerMove(element, { clientX: 500, clientY: 10, pointerId: 1 });
        expect(element.getAttribute("aria-valuenow")).toBe("100");
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.pointerUp(element, { clientX: 500, clientY: 10, pointerId: 1 });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(100);
    });

    it("reads a vertical bar from the bottom", () => {
        const { element, onCommit } = slider(vi.fn(), { orientation: "vertical" });
        expect(element.getAttribute("aria-orientation")).toBe("vertical");
        fireEvent.pointerDown(element, { clientX: 10, clientY: 50, pointerId: 1 });
        fireEvent.pointerUp(element, { clientX: 10, clientY: 50, pointerId: 1 });
        expect(onCommit).toHaveBeenCalledWith(75);
    });

    it("sends nothing when let go where the device already is, or when the drag is taken away", () => {
        const { element, onCommit } = slider();
        fireEvent.pointerDown(element, { clientX: 80, clientY: 10, pointerId: 1 });
        fireEvent.pointerUp(element, { clientX: 80, clientY: 10, pointerId: 1 });
        fireEvent.pointerDown(element, { clientX: 160, clientY: 10, pointerId: 1 });
        fireEvent.pointerCancel(element, { pointerId: 1 });
        expect(onCommit).not.toHaveBeenCalled();
        expect(element.getAttribute("aria-valuenow")).toBe("40");
    });

    it("gathers key presses and sends them once they stop, or at once on leaving", () => {
        vi.useFakeTimers();
        const { element, onCommit } = slider();
        fireEvent.keyDown(element, { key: "ArrowRight" });
        fireEvent.keyDown(element, { key: "ArrowRight" });
        fireEvent.keyDown(element, { key: "PageUp" });
        expect(element.getAttribute("aria-valuenow")).toBe("60");
        act(() => {
            vi.advanceTimersByTime(600);
        });
        expect(onCommit).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(200);
        });
        expect(onCommit).toHaveBeenCalledWith(60);
        fireEvent.keyDown(element, { key: "Home" });
        fireEvent.blur(element);
        expect(onCommit).toHaveBeenLastCalledWith(0);
        expect(onCommit).toHaveBeenCalledTimes(2);
    });

    it("cannot be moved while disabled", () => {
        vi.useFakeTimers();
        const { element, onCommit } = slider(vi.fn(), { disabled: true });
        expect(element.getAttribute("aria-disabled")).toBe("true");
        fireEvent.pointerDown(element, { clientX: 150, clientY: 10, pointerId: 1 });
        fireEvent.pointerUp(element, { clientX: 150, clientY: 10, pointerId: 1 });
        fireEvent.keyDown(element, { key: "ArrowUp" });
        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(onCommit).not.toHaveBeenCalled();
        expect(element.getAttribute("aria-valuenow")).toBe("40");
    });
});

describe("the thermostat dial", () => {
    const whole = { min: 16, max: 30, step: 1 };
    const at = (angle: number) => pointAt(160, 160, 136, angle);

    function dial(props: Partial<Parameters<typeof ThermostatDial>[0]> = {}) {
        const onCommit = vi.fn();
        const onCommitRange = vi.fn();
        const { container } = render(
            <ThermostatDial
                range={whole}
                value={22}
                label="Target"
                lowLabel="Heat to"
                highLabel="Cool to"
                valueText={(value) => `${value}°C`}
                onCommit={onCommit}
                onCommitRange={onCommitRange}
                {...props}
            >
                <button type="button">middle</button>
            </ThermostatDial>
        );
        const svg = container.querySelector("svg")!;
        boxed(svg, 320, 320);
        return { svg, onCommit, onCommitRange };
    }

    it("is dragged round the ring and sends the value it is let go on", () => {
        const { svg, onCommit } = dial();
        const handle = screen.getByRole("slider", { name: "Target" });
        expect(handle.getAttribute("aria-valuenow")).toBe("22");
        fireEvent.pointerDown(svg, { clientX: at(0).x, clientY: at(0).y, pointerId: 1 });
        expect(handle.getAttribute("aria-valuenow")).toBe("23");
        fireEvent.pointerMove(svg, { clientX: at(135).x, clientY: at(135).y, pointerId: 1 });
        expect(handle.getAttribute("aria-valuetext")).toBe("30°C");
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.pointerUp(svg, { pointerId: 1 });
        expect(onCommit).toHaveBeenCalledWith(30);
        expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it("leaves a press in the middle to the number there", () => {
        const { svg, onCommit } = dial();
        fireEvent.pointerDown(svg, { clientX: 160, clientY: 160, pointerId: 1 });
        fireEvent.pointerUp(svg, { pointerId: 1 });
        expect(onCommit).not.toHaveBeenCalled();
        expect(screen.getByRole("button", { name: "middle" })).toBeTruthy();
    });

    it("steps from the keyboard and holds to the range", () => {
        vi.useFakeTimers();
        const { onCommit } = dial({ value: 29 });
        const handle = screen.getByRole("slider", { name: "Target" });
        fireEvent.keyDown(handle, { key: "ArrowUp" });
        fireEvent.keyDown(handle, { key: "ArrowUp" });
        expect(handle.getAttribute("aria-valuenow")).toBe("30");
        act(() => {
            vi.advanceTimersByTime(800);
        });
        expect(onCommit).toHaveBeenCalledWith(30);
    });

    it("draws two handles for a range and moves the nearer one", () => {
        const { svg, onCommitRange } = dial({ value: null, setpoints: { low: 19, high: 25 } });
        expect(screen.getByRole("slider", { name: "Heat to" }).getAttribute("aria-valuenow")).toBe(
            "19"
        );
        fireEvent.pointerDown(svg, { clientX: at(90).x, clientY: at(90).y, pointerId: 1 });
        fireEvent.pointerUp(svg, { pointerId: 1 });
        expect(onCommitRange).toHaveBeenCalledWith({ low: 19, high: 28 });
    });

    it("keeps the low end below the high one from the keyboard", () => {
        vi.useFakeTimers();
        const { onCommitRange } = dial({ value: null, setpoints: { low: 24, high: 25 } });
        const low = screen.getByRole("slider", { name: "Heat to" });
        fireEvent.keyDown(low, { key: "ArrowUp" });
        fireEvent.keyDown(low, { key: "End" });
        act(() => {
            vi.advanceTimersByTime(800);
        });
        expect(low.getAttribute("aria-valuenow")).toBe("24");
        expect(onCommitRange).not.toHaveBeenCalled();
    });
});

describe("the colour wheel", () => {
    it("sends the colour it is let go on, not every one it passes", () => {
        const onCommit = vi.fn();
        render(
            <ColorWheel
                label="Colour"
                valueText={({ hue }) => `hue ${hue}`}
                value={{ hue: 0, saturation: 50 }}
                disabled={false}
                onCommit={onCommit}
            />
        );
        const wheel = screen.getByRole("slider", { name: "Colour" });
        boxed(wheel, 200, 200);
        fireEvent.pointerDown(wheel, { clientX: 200, clientY: 100, pointerId: 1 });
        fireEvent.pointerMove(wheel, { clientX: 100, clientY: 200, pointerId: 1 });
        expect(wheel.getAttribute("aria-valuenow")).toBe("180");
        expect(onCommit).not.toHaveBeenCalled();
        fireEvent.pointerUp(wheel, { pointerId: 1 });
        expect(onCommit).toHaveBeenCalledWith({ hue: 180, saturation: 100 });
        expect(onCommit).toHaveBeenCalledTimes(1);
    });
});

describe("the colour temperature track", () => {
    it("runs from warm at the minimum to cold at the maximum", () => {
        const [warmRed, , warmBlue] = kelvinToRgb(2000);
        const [coldRed, , coldBlue] = kelvinToRgb(6500);
        expect(warmRed).toBe(255);
        expect(warmBlue).toBeLessThan(coldBlue);
        expect(coldRed).toBeLessThanOrEqual(255);
        expect(kelvinTrack(2000, 6500, 3)).toMatch(/^linear-gradient\(to right, rgb\(255 /);
    });
});

describe("an air conditioner's panel", () => {
    const CLIMATE: ClimateView = {
        mode: "heat",
        modes: ["cool", "heat", "auto"],
        target: 21,
        min: 16,
        max: 30,
        step: 0.5,
        unit: "C",
        fan: "auto",
        fans: ["auto", "low", "high"],
        options: {},
        current: 19.5
    };
    const device = {
        id: "ac-1",
        vendor: "gree",
        kind: "climate",
        name: "Bedroom AC",
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        climate: CLIMATE
    } as DeviceView;

    it("sets the target on a dial, with the mode and fan as large buttons", () => {
        vi.useFakeTimers();
        const onAct = vi.fn();
        render(
            withMessages(
                <ClimateControls device={device} canControl busy={null} onAct={onAct} detailed />
            )
        );
        const target = screen.getByRole("group", { name: "Target temperature of Bedroom AC" });
        expect(target.textContent).toContain("21°C");
        expect(target.textContent).toContain("Room 19.5°C");
        const handle = within(target).getByRole("slider", {
            name: "Target temperature of Bedroom AC"
        });
        fireEvent.keyDown(handle, { key: "ArrowUp" });
        expect(target.textContent).toContain("21.5°C");
        act(() => {
            vi.advanceTimersByTime(800);
        });
        expect(onAct).toHaveBeenCalledWith("set-temperature", {
            action: "set-temperature",
            target: 21.5
        });

        const modes = screen.getByRole("radiogroup", { name: "Mode of Bedroom AC" });
        for (const radio of within(modes).getAllByRole("radio"))
            expect(radio.className).toContain("min-h-11");
        fireEvent.click(within(modes).getByRole("radio", { name: "Cool" }));
        expect(onAct).toHaveBeenLastCalledWith("set-mode", { action: "set-mode", mode: "cool" });
        fireEvent.click(within(modes).getByRole("radio", { name: "Heat" }));
        // Already heating: nothing to send.
        expect(onAct).toHaveBeenCalledTimes(2);

        const fans = screen.getByRole("radiogroup", { name: "Fan speed of Bedroom AC" });
        fireEvent.click(within(fans).getByRole("radio", { name: "High" }));
        expect(onAct).toHaveBeenLastCalledWith("set-fan", { action: "set-fan", fan: "high" });
    });
});
