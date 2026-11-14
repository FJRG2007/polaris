// @vitest-environment jsdom

/**
 * What changed hands is said above the devices: a move kept whole, a connection
 * left empty with the button that removes it, and a device that left - with the
 * offer to restore it once it is back.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DeviceAccountView } from "@polaris-app/places/src/lib/device-accounts";
import {
    GoneDevices,
    HandoverNotes
} from "@polaris-app/places/src/screens/devices/handover-notes";

function account(overrides: Partial<DeviceAccountView>): DeviceAccountView {
    return {
        id: "account-1",
        brand: "Tuya",
        connection: "tuya-app",
        connectionLabel: "Smart Life / Tuya Smart app",
        label: "Home",
        status: "ok",
        statusNote: "",
        lastSyncedAt: null,
        settings: {},
        options: {},
        deviceCount: 3,
        ...overrides
    };
}

const lamp = {
    id: "device-1",
    vendor: "tuya",
    kind: "outlet",
    name: "Desk lamp",
    zone: "",
    placeId: null,
    model: "",
    firmware: "",
    state: "off",
    doorState: "none",
    batteryPercent: null,
    batteryCritical: false,
    online: false,
    controllable: true,
    reading: null,
    stateAt: null
} as DeviceView;

afterEach(cleanup);

describe("handover notes", () => {
    it("says what moved and from where, and offers to remove the empty connection", () => {
        const remove = vi.fn();
        const empty = account({
            id: "account-0",
            connection: "tuya-cloud",
            connectionLabel: "Tuya cloud project",
            deviceCount: 0,
            movedOut: { to: "Smart Life / Tuya Smart app", count: 3 }
        });
        render(
            withMessages(
                <HandoverNotes
                    accounts={[empty, account({ movedIn: [{ from: "Tuya cloud project", count: 3 }] })]}
                    canManage
                    onRemove={remove}
                />
            )
        );
        expect(screen.getByRole("status").textContent).toBe(
            "3 devices moved from Tuya cloud project to Smart Life / Tuya Smart app, with their names, rooms, automations and history."
        );
        fireEvent.click(screen.getByRole("button", { name: "Remove Home" }));
        expect(remove).toHaveBeenCalledWith(empty);
    });

    it("speaks Spanish", () => {
        render(
            withMessages(
                <HandoverNotes
                    accounts={[account({ movedIn: [{ from: "Tuya cloud project", count: 1 }] })]}
                    canManage={false}
                    onRemove={() => undefined}
                />,
                "es-ES"
            )
        );
        expect(screen.getByRole("status").textContent).toContain("1 dispositivo pasó de");
    });
});

describe("devices that left", () => {
    it("offers restore or a fresh start for one that is back, and only removal otherwise", () => {
        const settle = vi.fn(async () => undefined);
        render(
            withMessages(
                <GoneDevices
                    devices={[
                        { ...lamp, gone: "back" },
                        { ...lamp, id: "device-2", name: "Hall plug", gone: "away" }
                    ]}
                    canManage
                    onSettle={settle}
                />
            )
        );
        fireEvent.click(screen.getByRole("button", { name: "Restore" }));
        expect(settle).toHaveBeenCalledWith(expect.objectContaining({ id: "device-1" }), "restore");
        expect(screen.getByRole("button", { name: "Start afresh" })).toBeTruthy();
        expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
        expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    });

    it("shows nothing to change for somebody who may only look", () => {
        render(
            withMessages(
                <GoneDevices devices={[{ ...lamp, gone: "away" }]} canManage={false} onSettle={vi.fn()} />
            )
        );
        expect(screen.getByText("Desk lamp")).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });
});
