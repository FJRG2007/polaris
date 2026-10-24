// @vitest-environment jsdom

/**
 * A device on a wall panel offers the controls it really has and no others:
 * a dimmer only on a light that dims, a colour only on a coloured one, a
 * switch on a plug, and its battery with a warning once it is low.
 */

import "@/components/app-host/client";
import { withMessages } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
    usePathname: () => "/wall/x"
}));
vi.mock("@polaris-app/places/src/screens/actions", () => ({}));
vi.mock("@polaris-app/places/src/screens/automations/actions", () => ({}));
vi.mock("@polaris/db", () => ({ prisma: {} }));

const { DeviceTile } = await import("@polaris-app/places/src/screens/panels/panel-cards");

function device(overrides: Partial<DeviceView> = {}): DeviceView {
    return {
        id: "d1",
        vendor: "hue",
        kind: "light",
        name: "Desk lamp",
        zone: "",
        placeId: "p",
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
        light: null,
        ...overrides
    };
}

const acts = { canControl: true, busy: null, onAct: () => undefined };

afterEach(cleanup);

describe("a device tile", () => {
    it("draws a brightness slider and nothing else for a light that only dims", () => {
        render(
            withMessages(
                <DeviceTile
                    device={device({
                        light: { brightness: { level: 50 }, temperature: null, color: null }
                    })}
                    acts={acts}
                />
            )
        );
        expect(screen.getAllByRole("slider")).toHaveLength(1);
        expect(screen.getByRole("switch")).toBeTruthy();
    });

    it("draws brightness, warmth and colour for a light that has all three", () => {
        render(
            withMessages(
                <DeviceTile
                    device={device({
                        light: {
                            brightness: { level: 50 },
                            temperature: { kelvin: 3000, min: 2000, max: 6500 },
                            color: { hue: 120, saturation: 100 }
                        }
                    })}
                    acts={acts}
                />
            )
        );
        expect(screen.getAllByRole("slider")).toHaveLength(3);
    });

    it("draws only a switch for a plug", () => {
        render(withMessages(<DeviceTile device={device({ kind: "outlet" })} acts={acts} />));
        expect(screen.getByRole("switch")).toBeTruthy();
        expect(screen.queryAllByRole("slider")).toHaveLength(0);
    });

    it("draws no switch and no slider for a sensor", () => {
        render(
            withMessages(
                <DeviceTile
                    device={device({ kind: "sensor", reading: { value: "21", unit: "C" } })}
                    acts={acts}
                />
            )
        );
        expect(screen.queryAllByRole("switch")).toHaveLength(0);
        expect(screen.queryAllByRole("slider")).toHaveLength(0);
    });

    it("shows the battery, and warns once it is low", () => {
        const { rerender } = render(
            withMessages(
                <DeviceTile device={device({ kind: "lock", batteryPercent: 80 })} acts={acts} />
            )
        );
        expect(screen.getByRole("img", { name: "Battery 80%" })).toBeTruthy();
        rerender(
            withMessages(
                <DeviceTile device={device({ kind: "lock", batteryPercent: 5 })} acts={acts} />
            )
        );
        expect(screen.getByRole("img", { name: /Battery low/ })).toBeTruthy();
    });

    it("draws no battery for a device that reports none", () => {
        render(withMessages(<DeviceTile device={device({ kind: "outlet" })} acts={acts} />));
        expect(screen.queryByRole("img", { name: /Battery/ })).toBeNull();
    });
});
