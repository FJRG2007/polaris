// @vitest-environment jsdom

/**
 * A device's low-battery line, from its dialog: offered only on a device that
 * reports a battery, checked as it is typed, and saved with the device.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls: { action: string; args: unknown[] }[] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listRoomsAction: async () => ({ rooms: [] }),
    saveRoomAction: async () => ({}),
    saveDeviceAction: async (...args: unknown[]) => {
        calls.push({ action: "device", args });
        return { device: lock };
    }
}));

const { DeviceDialog } = await import("@polaris-app/places/src/screens/devices/device-dialog");

const lock: DeviceView = {
    id: "lock",
    vendor: "nuki",
    kind: "lock",
    name: "Fixture lock",
    zone: "",
    placeId: null,
    model: "",
    firmware: "",
    state: "locked",
    doorState: "none",
    batteryPercent: 64,
    batteryCritical: false,
    online: true,
    controllable: true,
    reading: null,
    stateAt: null
};

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    calls.length = 0;
});
afterEach(cleanup);

function open(device: DeviceView) {
    render(
        withMessages(
            <DeviceDialog device={device} places={[]} onClose={() => {}} onSaved={() => {}} />
        )
    );
}

const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("a device's low-battery line", () => {
    it("shows the kind's default and the maker's own flag", async () => {
        open(lock);
        await painted();
        const field = screen.getByLabelText("Low battery at") as HTMLInputElement;
        expect(field.placeholder).toBe("30");
        expect(screen.getByText(/Leave it empty to use 30%/)).toBeTruthy();
        expect(screen.getByText(/also reports a low battery itself/)).toBeTruthy();
    });

    it("refuses a share outside 1-99 and saves one inside it", async () => {
        open(lock);
        await painted();
        const field = screen.getByLabelText("Low battery at");
        fireEvent.change(field, { target: { value: "0" } });
        expect(screen.getByText("Between 1 and 99")).toBeTruthy();
        expect(save().disabled).toBe(true);
        fireEvent.change(field, { target: { value: "40" } });
        expect(save().disabled).toBe(false);
        fireEvent.click(save());
        await painted();
        expect((calls.at(-1)!.args[1] as { batteryLowPercent: number }).batteryLowPercent).toBe(40);
    });

    it("clears a set line back to the kind's", async () => {
        open({ ...lock, batteryLowPercent: 45 });
        await painted();
        const field = screen.getByLabelText("Low battery at");
        expect((field as HTMLInputElement).value).toBe("45");
        fireEvent.change(field, { target: { value: "" } });
        fireEvent.click(save());
        await painted();
        expect(
            (calls.at(-1)!.args[1] as { batteryLowPercent: number | null }).batteryLowPercent
        ).toBeNull();
    });

    it("is not asked of a device with no battery", async () => {
        open({ ...lock, batteryPercent: null });
        await painted();
        expect(screen.queryByLabelText("Low battery at")).toBeNull();
    });
});
