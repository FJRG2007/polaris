// @vitest-environment jsdom

/**
 * A switch, a socket or a light is worked by one switch, bound to where it is.
 *
 * It flips under the finger - the row moves to what it was told before the
 * answer arrives - and flips back if the answer is a refusal, with the refusal
 * on the screen. When it cannot be worked it still shows where the device is,
 * off limits, and says why. A lock keeps its buttons: it is turning, and where
 * it gets to is the vendor's to report, so there is nothing to flip ahead of it.
 *
 * The whole Devices screen is drawn, with its actions replaced, because the
 * optimistic state and its rollback live in the screen and not in the switch.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

function device(overrides: Partial<DeviceView>): DeviceView {
    return {
        id: "device-1",
        vendor: "tuya",
        kind: "outlet",
        name: "Desk lamp",
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...overrides
    };
}

/** One connected account: the list is only drawn once something is connected. */
const ACCOUNT = {
    id: "account-1",
    brand: "Tuya",
    connection: "tuya-app",
    connectionLabel: "Smart Life / Tuya Smart app",
    label: "Home",
    status: "ok",
    statusNote: "",
    lastSyncedAt: null,
    settings: {},
    deviceCount: 1
};

let listed: DeviceView[] = [];
/** The pending answer to the last press, settled by the test. */
let answer: (value: { device?: DeviceView; error?: string }) => void = () => undefined;
const pressed: [string, string][] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listDevicesAction: async () => ({ devices: listed, accounts: [ACCOUNT] }),
    syncDevicesAction: async () => ({}),
    deviceHistoryAction: async () => ({ events: [] }),
    deviceUsageAction: async () => ({ used: [] }),
    operateDeviceAction: (id: string, action: string) => {
        pressed.push([id, action]);
        return new Promise((resolve) => {
            answer = resolve;
        });
    }
}));

const { DevicesView } = await import("@polaris-app/places/src/screens/devices/devices-view");

afterEach(() => {
    cleanup();
    pressed.length = 0;
});

async function drawn(devices: DeviceView[], canControl = true, locale?: "es-ES") {
    listed = devices;
    render(withMessages(<DevicesView places={[]} canControl={canControl} canManage={false} />, locale));
    await screen.findByText(devices[0]!.name);
}

describe("a switch on a device row", () => {
    it("replaces the On and Off buttons, named after the device", async () => {
        await drawn([device({})]);
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(screen.queryByRole("button", { name: /^On$/ })).toBeNull();
        expect(screen.queryByRole("button", { name: /^Off$/ })).toBeNull();
    });

    it("flips at once, and stays where the device says it is", async () => {
        await drawn([device({})]);
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        fireEvent.click(toggle);
        expect(pressed).toEqual([["device-1", "turn-on"]]);
        // Before any answer: already on, and the badge agrees.
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
        expect(screen.getAllByText("On").length).toBeGreaterThan(0);

        await act(async () => answer({ device: device({ state: "on" }) }));
        expect(screen.getByRole("switch", { name: "Turn Desk lamp on or off" }).getAttribute("aria-checked")).toBe(
            "true"
        );
    });

    it("flips back, and says why, when the device refuses", async () => {
        await drawn([device({ state: "on" })]);
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        fireEvent.click(toggle);
        expect(pressed).toEqual([["device-1", "turn-off"]]);
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
        // Not pressed twice while the first is in flight.
        expect(toggle.hasAttribute("disabled")).toBe(true);

        await act(async () => answer({ error: "Tuya refused the request." }));
        await waitFor(() =>
            expect(
                screen.getByRole("switch", { name: "Turn Desk lamp on or off" }).getAttribute("aria-checked")
            ).toBe("true")
        );
        expect(screen.getByRole("alert").textContent).toContain("Tuya refused the request.");
    });

    it("is off limits, saying why, when the device is not answering", async () => {
        await drawn([device({ online: false, state: "unknown" })]);
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.hasAttribute("disabled")).toBe(true);
        const reason = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent).toBe("It is not answering, so it cannot be switched now.");
    });

    it("is off limits, saying why, for somebody who may only look", async () => {
        await drawn([device({ state: "on" })], false);
        const toggle = screen.getByRole("switch", { name: "Turn Desk lamp on or off" });
        expect(toggle.hasAttribute("disabled")).toBe(true);
        expect(toggle.getAttribute("aria-checked")).toBe("true");
        const reason = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent).toBe("You can see this, but not operate it.");
        fireEvent.click(toggle);
        expect(pressed).toEqual([]);
    });

    it("speaks Spanish", async () => {
        await drawn([device({ online: false })], true, "es-ES");
        const toggle = screen.getByRole("switch", { name: "Encender o apagar Desk lamp" });
        const reason = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
        expect(reason?.textContent).toBe("No responde, así que ahora no se puede cambiar.");
    });
});

describe("a lock", () => {
    it("keeps its buttons, and no switch", async () => {
        await drawn([device({ kind: "lock", name: "Front door", state: "locked" })]);
        expect(screen.queryByRole("switch")).toBeNull();
        expect(screen.getByRole("button", { name: /Unlock/ })).toBeTruthy();
    });
});
