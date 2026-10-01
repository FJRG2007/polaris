// @vitest-environment jsdom

/**
 * An air purifier on the Devices screen: its power, preset, fan speed, humidity
 * target, switches, readings and filters.
 *
 * Every control moves the moment it is used and moves back when the unit
 * refuses. The humidity stepper gathers presses into one change. What a unit
 * cannot do is never offered, a worn filter is flagged on the row, and a unit
 * that cannot be operated says why.
 *
 * The whole screen is drawn, with its actions replaced, because the optimistic
 * state and its rollback live in the screen.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AirSettings, DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const AIR: AirSettings = {
    mode: "auto",
    modes: ["auto", "sleep", "turbo"],
    speed: null,
    speeds: ["sleep", "speed_1", "speed_2", "turbo"],
    humidity: { target: 50, min: 40, max: 70, step: 10 },
    options: { childLock: false, light: true },
    readings: { pm25: 12, allergen: 2, humidity: 45, temperature: 21 },
    filters: [
        { kind: "pre", percent: null, hours: 300, state: "ok" },
        { kind: "hepa", percent: 12, hours: 540, state: "soon" }
    ]
};

function purifier(overrides: Partial<DeviceView> = {}): DeviceView {
    return {
        id: "air-1",
        vendor: "philips",
        kind: "air",
        name: "Bedroom purifier",
        zone: "",
        placeId: "place-1",
        model: "AC3858/50",
        firmware: "",
        state: "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: { value: "12", unit: "µg/m³" },
        stateAt: null,
        air: AIR,
        ...overrides
    };
}

const ACCOUNT = {
    id: "account-1",
    brand: "Philips",
    connection: "philips-coap",
    connectionLabel: "Philips Air+ (local network)",
    label: "Philips",
    status: "ok",
    statusNote: "",
    lastSyncedAt: null,
    settings: {},
    deviceCount: 1
};

let listed: DeviceView[] = [];
let answer: (value: { device?: DeviceView; error?: string }) => void = () => undefined;
const pressed: [string, string, unknown][] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listDevicesAction: async () => ({ devices: listed, accounts: [ACCOUNT] }),
    syncDevicesAction: async () => ({}),
    deviceHistoryAction: async () => ({ events: [] }),
    deviceUsageAction: async () => ({ used: [] }),
    operateDeviceAction: (id: string, action: string, command?: unknown) => {
        pressed.push([id, action, command]);
        return new Promise((resolve) => {
            answer = resolve;
        });
    }
}));

const { DevicesView } = await import("@polaris-app/places/src/screens/devices/devices-view");
const kinds = await import("@polaris-app/places/src/lib/device-kinds");

afterEach(() => {
    cleanup();
    pressed.length = 0;
    vi.useRealTimers();
});

async function drawn(devices: DeviceView[], canControl = true, locale?: "es-ES") {
    listed = devices;
    render(
        withMessages(<DevicesView places={[]} canControl={canControl} canManage={false} />, locale)
    );
    await screen.findByText(devices[0]!.name);
}

async function opened(device: DeviceView) {
    await drawn([device]);
    fireEvent.click(screen.getByText(device.name));
    return screen.findByRole("dialog");
}

describe("an air purifier's row", () => {
    it("draws its power, preset, fan speed, the dust in the room and a worn filter", async () => {
        await drawn([purifier()]);
        expect(
            screen.getByRole("switch", { name: "Turn Bedroom purifier on or off" })
        ).toBeTruthy();
        expect(
            screen.getByRole("combobox", { name: "Mode of Bedroom purifier" }).textContent
        ).toContain("Auto");
        // Running a preset, the speed is the preset's: the picker says so.
        expect(
            screen.getByRole("combobox", { name: "Fan speed of Bedroom purifier" }).textContent
        ).toContain("Set by mode");
        expect(screen.getByText("12 µg/m³")).toBeTruthy();
        expect(screen.getByText("Change filter soon")).toBeTruthy();
        // On, the badge says what it is running rather than "On".
        expect(screen.getAllByText("Auto").length).toBeGreaterThan(1);
        // The humidity stepper is the panel's, not the row's.
        expect(
            screen.queryByRole("group", { name: "Target humidity of Bedroom purifier" })
        ).toBeNull();
    });

    it("says nothing about filters that are fine", async () => {
        await drawn([
            purifier({
                air: { ...AIR, filters: [{ kind: "hepa", percent: 80, hours: null, state: "ok" }] }
            })
        ]);
        expect(screen.queryByText("Change filter soon")).toBeNull();
        expect(screen.queryByText("Change filter")).toBeNull();
    });

    it("is off limits, saying why, when it is not answering", async () => {
        await drawn([purifier({ online: false, state: "unknown" })]);
        const mode = screen.getByRole("combobox", {
            name: "Mode of Bedroom purifier"
        }) as HTMLButtonElement;
        expect(mode.disabled).toBe(true);
        expect(mode.closest("label")?.getAttribute("title")).toBe(
            "It is not answering, so it cannot be switched now."
        );
    });

    it("offers only the pickers the unit has", async () => {
        await drawn([purifier({ air: { ...AIR, modes: [], speeds: [] } })]);
        expect(screen.queryByRole("combobox", { name: "Mode of Bedroom purifier" })).toBeNull();
        expect(
            screen.queryByRole("combobox", { name: "Fan speed of Bedroom purifier" })
        ).toBeNull();
    });

    it("speaks Spanish", async () => {
        await drawn([purifier({ air: { ...AIR, mode: "sleep" } })], true, "es-ES");
        expect(
            screen.getByRole("combobox", { name: "Modo de Bedroom purifier" }).textContent
        ).toContain("Sueño");
        expect(screen.getByText("Filtro: cambiar pronto")).toBeTruthy();
    });
});

describe("an air purifier's panel", () => {
    it("lists what it measures and the life left in each filter", async () => {
        const dialog = await opened(purifier());
        const panel = within(dialog);
        expect(panel.getByText("Allergen index")).toBeTruthy();
        expect(panel.getByText("45%")).toBeTruthy();
        expect(panel.getByText("21°C")).toBeTruthy();
        expect(panel.getByText("HEPA filter")).toBeTruthy();
        expect(panel.getByText("12% left")).toBeTruthy();
        expect(panel.getByText("300 h left")).toBeTruthy();
        expect(panel.getByText("Replace soon")).toBeTruthy();
    });

    it("gathers presses of the humidity stepper into one change", async () => {
        const dialog = await opened(purifier());
        vi.useFakeTimers();
        const raise = within(dialog).getByRole("button", {
            name: "Raise the target humidity on Bedroom purifier"
        });
        fireEvent.click(raise);
        fireEvent.click(raise);
        expect(
            within(dialog).getByRole("group", { name: "Target humidity of Bedroom purifier" })
                .textContent
        ).toContain("70%");
        expect(pressed).toEqual([]);
        await act(async () => {
            vi.advanceTimersByTime(800);
        });
        expect(pressed).toEqual([
            ["air-1", "set-humidity", { action: "set-humidity", target: 70 }]
        ]);
    });

    it("flips a switch at once and puts it back when the unit refuses", async () => {
        const dialog = await opened(purifier());
        const lock = within(dialog).getByRole("switch", { name: "Child lock on Bedroom purifier" });
        expect(lock.getAttribute("aria-checked")).toBe("false");
        fireEvent.click(lock);
        expect(pressed).toEqual([
            ["air-1", "set-option", { action: "set-option", option: "childLock", on: true }]
        ]);
        await waitFor(() =>
            expect(
                within(dialog)
                    .getByRole("switch", { name: "Child lock on Bedroom purifier" })
                    .getAttribute("aria-checked")
            ).toBe("true")
        );
        await act(async () => answer({ error: "The air purifier did not answer." }));
        await waitFor(() =>
            expect(
                within(dialog)
                    .getByRole("switch", { name: "Child lock on Bedroom purifier" })
                    .getAttribute("aria-checked")
            ).toBe("false")
        );
        expect(within(dialog).getByRole("alert").textContent).toContain(
            "The air purifier did not answer."
        );
    });

    it("offers no humidity on a unit that does not humidify", async () => {
        const dialog = await opened(purifier({ air: { ...AIR, humidity: null } }));
        expect(
            within(dialog).queryByRole("group", { name: "Target humidity of Bedroom purifier" })
        ).toBeNull();
    });
});

describe("what an air purifier accepts", () => {
    it("refuses a preset, a speed, a switch or a humidity it does not have", () => {
        expect(kinds.airCommandIssue(AIR, { action: "set-mode", mode: "allergen" })).toBe(
            "That mode is not one this device has"
        );
        expect(kinds.airCommandIssue(AIR, { action: "set-fan", speed: "speed_3" })).toBe(
            "That fan speed is not one this device has"
        );
        expect(
            kinds.airCommandIssue(AIR, { action: "set-option", option: "humidify", on: true })
        ).toBe("That setting is not one this device has");
        expect(kinds.airCommandIssue(AIR, { action: "set-humidity", target: 55 })).toBe(
            "That humidity is not one this device accepts"
        );
        expect(kinds.airCommandIssue(AIR, { action: "set-humidity", target: 80 })).toBe(
            "That humidity is not one this device accepts"
        );
        expect(
            kinds.airCommandIssue(
                { ...AIR, humidity: null },
                { action: "set-humidity", target: 50 }
            )
        ).toBe("That device does not humidify");
        expect(kinds.airCommandIssue(AIR, { action: "set-humidity", target: 60 })).toBe(null);
        expect(kinds.airCommandIssue(AIR, { action: "set-fan", speed: "turbo" })).toBe(null);
    });

    it("never takes one kind's setting for the other's", () => {
        const target = { kind: "air", climate: null, air: AIR };
        // An air conditioner's fan word is not a purifier's speed.
        expect(kinds.commandIssue(target, { action: "set-fan", fan: "high" })).toBe(
            "That device cannot be told to do that"
        );
        expect(
            kinds.commandIssue(
                { kind: "climate", climate: null, air: null },
                { action: "set-fan", speed: "turbo" }
            )
        ).toBe("That device cannot be told to do that");
    });

    it("leaves the preset when a speed is picked, and the speed when a preset is", () => {
        expect(kinds.applyAir(AIR, { action: "set-fan", speed: "speed_2" })).toMatchObject({
            mode: null,
            speed: "speed_2"
        });
        expect(
            kinds.applyAir(
                { ...AIR, mode: null, speed: "turbo" },
                { action: "set-mode", mode: "sleep" }
            )
        ).toMatchObject({
            mode: "sleep",
            speed: null
        });
    });

    it("grades a filter on the integration's scale", () => {
        expect(kinds.filterState(5, null)).toBe("now");
        expect(kinds.filterState(15, null)).toBe("soon");
        expect(kinds.filterState(16, null)).toBe("ok");
        expect(kinds.filterState(null, 24)).toBe("now");
        expect(kinds.filterState(null, 72)).toBe("soon");
        expect(kinds.filterState(null, 73)).toBe("ok");
        expect(kinds.wornFilter(AIR)?.kind).toBe("hepa");
        expect(kinds.filterLife(AIR)).toBe(12);
    });

    it("reads a stored document only when it is whole", () => {
        expect(kinds.airSettings(AIR)).not.toBeNull();
        expect(kinds.airSettings({ ...AIR, modes: ["boost"] })).toBeNull();
        expect(
            kinds.airSettings({ ...AIR, humidity: { target: 50, min: 70, max: 40, step: 10 } })
        ).toBeNull();
        expect(kinds.airSettings(null)).toBeNull();
    });

    it("stores a document with an impossible reading or too many filters by dropping those, not the rest", () => {
        const filter = AIR.filters[0]!;
        const stored = kinds.storableAir({
            ...AIR,
            readings: { pm25: 20_000, allergen: 3, temperature: 400 },
            filters: [...Array.from({ length: 8 }, () => filter), { ...filter, hours: -1 }]
        });
        expect(stored?.mode).toBe(AIR.mode);
        expect(stored?.readings).toEqual({ allergen: 3 });
        expect(stored?.filters).toHaveLength(6);
        expect(kinds.storableAir(null)).toBeNull();
    });
});
