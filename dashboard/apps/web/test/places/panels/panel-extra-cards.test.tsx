// @vitest-environment jsdom

/**
 * The sensor card, the automation button and the colour wheel, drawn: a
 * reading large, a button that asks first when told to and is greyed with the
 * reason for somebody who may not run it, and a wheel only on a coloured light
 * that a keyboard can turn.
 */

import "@/components/app-host/client";
import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
    usePathname: () => "/wall/x"
}));
vi.mock("@polaris-app/places/src/screens/actions", () => ({}));
vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({}));
vi.mock("@polaris/db", () => ({ prisma: {} }));

const { ActionCard, DeviceTile, SensorCard } = await import(
    "@polaris-app/places/src/screens/panels/panel-cards"
);
const { ColorWheel, hsFromPoint, pointFromHs, stepHs } = await import(
    "@polaris-app/places/src/screens/devices/color-wheel"
);

function device(overrides: Partial<DeviceView> = {}): DeviceView {
    return {
        id: "d1",
        vendor: "shelly",
        kind: "sensor",
        name: "Hall thermometer",
        zone: "",
        placeId: "p",
        model: "",
        firmware: "",
        state: "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: false,
        reading: { value: "21.5", unit: "°C" },
        stateAt: null,
        light: null,
        ...overrides
    } as DeviceView;
}

const automation = { id: "a1", name: "Good night", enabled: true };

afterEach(cleanup);

describe("a sensor card", () => {
    it("draws the reading large", () => {
        render(withMessages(<SensorCard device={device()} />));
        expect(screen.getByText("21.5°C")).toBeTruthy();
    });

    it("says when the sensor is not answering", () => {
        render(withMessages(<SensorCard device={device({ online: false })} />));
        expect(screen.getByText("Not answering")).toBeTruthy();
    });
});

describe("an automation button", () => {
    it("runs at once when it does not ask first", async () => {
        const onRun = vi.fn(async () => null);
        render(withMessages(<ActionCard automation={automation} confirm={false} canRun onRun={onRun} />));
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /Good night/ })));
        expect(onRun).toHaveBeenCalledTimes(1);
        expect(screen.getByText("Started")).toBeTruthy();
    });

    it("asks first, and runs only on the confirmation", async () => {
        const onRun = vi.fn(async () => null);
        render(withMessages(<ActionCard automation={automation} confirm canRun onRun={onRun} />));
        fireEvent.click(screen.getByRole("button", { name: /Good night/ }));
        expect(onRun).not.toHaveBeenCalled();
        expect(screen.getByText("Run Good night?")).toBeTruthy();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Run" })));
        expect(onRun).toHaveBeenCalledTimes(1);
    });

    it("is greyed with the reason for somebody who may not run it", () => {
        const onRun = vi.fn(async () => null);
        render(withMessages(<ActionCard automation={automation} confirm={false} canRun={false} onRun={onRun} />));
        const button = screen.getByRole("button", { name: /Good night/ });
        expect(button.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(button);
        expect(onRun).not.toHaveBeenCalled();
        expect(screen.getByText("Only people who manage the house can run this")).toBeTruthy();
    });
});

describe("the colour wheel", () => {
    it("maps a point to a colour and back", () => {
        expect(hsFromPoint(0, -50, 50)).toEqual({ hue: 0, saturation: 100 });
        expect(hsFromPoint(50, 0, 50)).toEqual({ hue: 90, saturation: 100 });
        expect(hsFromPoint(0, 0, 50)).toEqual({ hue: 0, saturation: 0 });
        expect(hsFromPoint(0, 200, 50)).toEqual({ hue: 180, saturation: 100 });
        const point = pointFromHs({ hue: 90, saturation: 50 });
        expect(point.x).toBeCloseTo(0.5);
        expect(point.y).toBeCloseTo(0);
    });

    it("turns with the arrow keys and stays in range", () => {
        expect(stepHs({ hue: 355, saturation: 50 }, "ArrowRight", false)).toEqual({ hue: 0, saturation: 50 });
        expect(stepHs({ hue: 0, saturation: 98 }, "ArrowUp", false)).toEqual({ hue: 0, saturation: 100 });
        expect(stepHs({ hue: 10, saturation: 10 }, "ArrowDown", true)).toEqual({ hue: 10, saturation: 0 });
        expect(stepHs({ hue: 10, saturation: 10 }, "Enter", false)).toBeNull();
    });

    it("sends a key's colour once it settles", () => {
        vi.useFakeTimers();
        try {
            const onCommit = vi.fn();
            render(
                withMessages(
                    <ColorWheel
                        label="Color"
                        valueText={() => ""}
                        value={{ hue: 100, saturation: 80 }}
                        disabled={false}
                        onCommit={onCommit}
                    />
                )
            );
            const wheel = screen.getByRole("slider", { name: "Color" });
            fireEvent.keyDown(wheel, { key: "ArrowRight" });
            fireEvent.keyDown(wheel, { key: "ArrowRight" });
            expect(onCommit).not.toHaveBeenCalled();
            act(() => vi.advanceTimersByTime(500));
            expect(onCommit).toHaveBeenCalledWith({ hue: 110, saturation: 80 });
        } finally {
            vi.useRealTimers();
        }
    });

    it("is drawn only on a light that has colour", () => {
        const acts = { canControl: true, busy: null, onAct: () => undefined };
        const lamp = (color: { hue: number; saturation: number } | null) =>
            device({
                kind: "light",
                reading: null,
                controllable: true,
                light: { brightness: { level: 50 }, temperature: null, color }
            });
        const { unmount } = render(withMessages(<DeviceTile device={lamp(null)} acts={acts} />));
        expect(screen.queryByRole("slider", { name: "Color" })).toBeNull();
        unmount();
        render(withMessages(<DeviceTile device={lamp({ hue: 200, saturation: 60 })} acts={acts} />));
        const wheel = screen.getByRole("slider", { name: "Color" });
        expect(wheel.getAttribute("aria-valuetext")).toBe("Hue 200 degrees, saturation 60%");
    });
});
