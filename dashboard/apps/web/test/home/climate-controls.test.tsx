// @vitest-environment jsdom

/**
 * An air conditioner on the Devices screen: its power, mode, target and fan.
 *
 * Every control moves the moment it is used and moves back when the unit
 * refuses, like the switch on a socket. The stepper gathers presses into one
 * change. What a unit cannot do is never offered, and a unit that cannot be
 * operated says why.
 *
 * The whole screen is drawn, with its actions replaced, because the optimistic
 * state and its rollback live in the screen.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClimateView, DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const CLIMATE: ClimateView = {
    mode: "cool",
    modes: ["cool", "heat", "dry", "fan", "auto"],
    target: 24,
    min: 16,
    max: 30,
    step: 1,
    unit: "C",
    fan: "auto",
    fans: ["auto", "low", "medium", "high"],
    options: { swing: false, turbo: false },
    current: 27
};

function unit(overrides: Partial<DeviceView> = {}): DeviceView {
    return {
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
        reading: { value: "27", unit: "°C" },
        stateAt: null,
        climate: CLIMATE,
        ...overrides
    };
}

const ACCOUNT = {
    id: "account-1",
    brand: "Gree",
    connection: "gree-local",
    connectionLabel: "Gree+ (local network)",
    label: "Gree",
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

describe("an air conditioner's row", () => {
    it("draws its power, mode, target, fan and the room's temperature", async () => {
        await drawn([unit()]);
        expect(screen.getByRole("switch", { name: "Turn Bedroom AC on or off" })).toBeTruthy();
        expect(screen.getByRole("combobox", { name: "Mode of Bedroom AC" }).textContent).toContain(
            "Cool"
        );
        expect(
            screen.getByRole("combobox", { name: "Fan speed of Bedroom AC" }).textContent
        ).toContain("Auto");
        expect(
            screen.getByRole("group", { name: "Target temperature of Bedroom AC" }).textContent
        ).toContain("24°C");
        expect(screen.getByText("27°C")).toBeTruthy();
        // On, the badge says what it is doing rather than "On".
        expect(screen.getAllByText("Cool").length).toBeGreaterThan(1);
    });

    it("gathers presses of + into one change, shown at once", async () => {
        await drawn([unit()]);
        vi.useFakeTimers();
        const raise = screen.getByRole("button", { name: "Raise the target on Bedroom AC" });
        fireEvent.click(raise);
        fireEvent.click(raise);
        expect(
            screen.getByRole("group", { name: "Target temperature of Bedroom AC" }).textContent
        ).toContain("26°C");
        expect(pressed).toEqual([]);
        await act(async () => {
            vi.advanceTimersByTime(800);
        });
        expect(pressed).toEqual([
            ["ac-1", "set-temperature", { action: "set-temperature", target: 26 }]
        ]);
    });

    it("sends nothing when pressed back to where it was", async () => {
        await drawn([unit()]);
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole("button", { name: "Raise the target on Bedroom AC" }));
        fireEvent.click(screen.getByRole("button", { name: "Lower the target on Bedroom AC" }));
        await act(async () => {
            vi.advanceTimersByTime(800);
        });
        expect(pressed).toEqual([]);
    });

    it("stops at the unit's own range", async () => {
        await drawn([unit({ climate: { ...CLIMATE, target: 30 } })]);
        const raise = screen.getByRole("button", { name: "Raise the target on Bedroom AC" });
        expect(raise.hasAttribute("disabled")).toBe(true);
    });

    it("puts the target back, and says why, when the unit refuses", async () => {
        await drawn([unit()]);
        vi.useFakeTimers();
        fireEvent.click(screen.getByRole("button", { name: "Lower the target on Bedroom AC" }));
        await act(async () => {
            vi.advanceTimersByTime(800);
        });
        vi.useRealTimers();
        const group = () =>
            screen.getByRole("group", { name: "Target temperature of Bedroom AC" }).textContent;
        expect(group()).toContain("23°C");
        await act(async () => answer({ error: "The unit did not answer." }));
        await waitFor(() => expect(group()).toContain("24°C"));
        expect(screen.getByRole("alert").textContent).toContain("The unit did not answer.");
    });

    it("is off limits, saying why, when it is not answering", async () => {
        await drawn([unit({ online: false, state: "unknown" })]);
        expect(
            screen
                .getByRole("button", { name: "Raise the target on Bedroom AC" })
                .hasAttribute("disabled")
        ).toBe(true);
        expect(
            (screen.getByRole("combobox", { name: "Mode of Bedroom AC" }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        const group = screen.getByRole("group", { name: "Target temperature of Bedroom AC" });
        const reason = document.getElementById(group.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent).toBe("It is not answering, so it cannot be switched now.");
    });

    it("offers only the modes and fans the unit has", async () => {
        await drawn([unit({ climate: { ...CLIMATE, fans: [], modes: ["cool", "fan"] } })]);
        expect(screen.queryByRole("combobox", { name: "Fan speed of Bedroom AC" })).toBeNull();
    });

    it("speaks Spanish", async () => {
        await drawn([unit()], true, "es-ES");
        expect(screen.getByRole("combobox", { name: "Modo de Bedroom AC" }).textContent).toContain(
            "Frío"
        );
    });
});

describe("what an air conditioner accepts", () => {
    const settings = { ...CLIMATE };

    it("refuses a temperature off its range or its step", () => {
        expect(kinds.climateCommandIssue(settings, { action: "set-temperature", target: 22 })).toBe(
            null
        );
        expect(kinds.climateCommandIssue(settings, { action: "set-temperature", target: 31 })).toBe(
            "That temperature is not one this device accepts"
        );
        expect(
            kinds.climateCommandIssue(settings, { action: "set-temperature", target: 22.5 })
        ).toBe("That temperature is not one this device accepts");
        expect(
            kinds.climateCommandIssue(
                { ...settings, step: 0.5 },
                { action: "set-temperature", target: 22.5 }
            )
        ).toBe(null);
    });

    it("refuses a mode, a fan or an extra it does not have", () => {
        const narrow = { ...settings, modes: ["cool" as const], fans: ["auto" as const] };
        expect(kinds.climateCommandIssue(narrow, { action: "set-mode", mode: "heat" })).toBe(
            "That mode is not one this device has"
        );
        expect(kinds.climateCommandIssue(narrow, { action: "set-fan", fan: "high" })).toBe(
            "That fan speed is not one this device has"
        );
        expect(
            kinds.climateCommandIssue(narrow, { action: "set-option", option: "eco", on: true })
        ).toBe("That setting is not one this device has");
        expect(
            kinds.climateCommandIssue(narrow, { action: "set-option", option: "swing", on: true })
        ).toBe(null);
    });

    it("refuses anything before the unit has said what it accepts", () => {
        expect(kinds.climateCommandIssue(null, { action: "set-mode", mode: "cool" })).toBe(
            "That device has not said what it can be set to yet"
        );
    });

    it("reads a stored document only when it is whole", () => {
        expect(kinds.climateSettings({ ...settings, current: undefined })).not.toBeNull();
        expect(kinds.climateSettings({ ...settings, min: 30, max: 16 })).toBeNull();
        expect(kinds.climateSettings({ mode: "cool" })).toBeNull();
        expect(kinds.climateSettings(null)).toBeNull();
    });

    it("validates a command's shape before anything else", () => {
        expect(
            kinds.climateCommandSchema.safeParse({ action: "set-mode", mode: "freeze" }).success
        ).toBe(false);
        expect(
            kinds.climateCommandSchema.safeParse({ action: "set-temperature", target: "24" })
                .success
        ).toBe(false);
        expect(
            kinds.climateCommandSchema.safeParse({ action: "set-temperature", target: 24 }).success
        ).toBe(true);
    });
});
