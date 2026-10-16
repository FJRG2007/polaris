// @vitest-environment jsdom

/**
 * A device's room, from its dialog: picked from the place's rooms, or made
 * there with a floor, and saved with the device.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls: { action: string; args: unknown[] }[] = [];

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    listRoomsAction: async (placeId: string) => {
        calls.push({ action: "list", args: [placeId] });
        return {
            rooms: [{ id: "room-1", placeId: "place-1", name: "Kitchen", floor: "Ground floor" }]
        };
    },
    saveRoomAction: async (...args: unknown[]) => {
        calls.push({ action: "room", args });
        return { room: { id: "room-2", placeId: "place-1", name: "Hall", floor: "Ground floor" } };
    },
    saveDeviceAction: async (...args: unknown[]) => {
        calls.push({ action: "device", args });
        return { device: lamp };
    }
}));

const { DeviceDialog } = await import("@polaris-app/places/src/screens/devices/device-dialog");

const lamp: DeviceView = {
    id: "lamp",
    vendor: "fixture",
    kind: "light",
    name: "Fixture lamp",
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
    stateAt: null
};

const PLACES = [{ id: "place-1", name: "Fixture place", kind: "house", address: "", cameras: 0 }];

async function painted(): Promise<void> {
    await act(async () => {
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
}

beforeEach(() => {
    calls.length = 0;
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("a device's room", () => {
    function open() {
        render(
            withMessages(
                <DeviceDialog device={lamp} places={PLACES} onClose={() => {}} onSaved={() => {}} />
            )
        );
    }

    it("is picked from the place's rooms and saved with the device", async () => {
        open();
        await painted();
        expect(calls[0]).toEqual({ action: "list", args: ["place-1"] });
        fireEvent.click(screen.getByRole("combobox", { name: "Room" }));
        fireEvent.click(await screen.findByRole("option", { name: "Kitchen - Ground floor" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        expect(calls.at(-1)).toEqual({
            action: "device",
            args: [
                "lamp",
                {
                    name: "Fixture lamp",
                    zone: "",
                    placeId: "place-1",
                    controllable: true,
                    roomId: "room-1"
                }
            ]
        });
    });

    it("can be made there, on a floor already used, and the device saved in it", async () => {
        open();
        await painted();
        fireEvent.click(screen.getByRole("combobox", { name: "Room" }));
        fireEvent.click(await screen.findByRole("option", { name: "New room" }));
        expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
            true
        );
        fireEvent.change(screen.getByLabelText("Room name"), { target: { value: " Hall " } });
        fireEvent.click(screen.getByRole("button", { name: "Ground floor" }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await painted();
        expect(calls.find((call) => call.action === "room")?.args).toEqual([
            null,
            { placeId: "place-1", name: "Hall", floor: "Ground floor" }
        ]);
        const saved = calls.at(-1)!;
        expect(saved.action).toBe("device");
        expect((saved.args[1] as { roomId: string }).roomId).toBe("room-2");
    });
});
