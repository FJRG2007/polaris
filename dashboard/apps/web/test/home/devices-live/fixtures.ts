/**
 * A device and an account as the devices screen receives them, for the live
 * tests. Plainly fixture data: ids like "device-1" and an account called Home.
 */

import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import type { DeviceAccountView } from "@polaris-app/places/src/lib/device-accounts";

export function device(overrides: Partial<DeviceView> = {}): DeviceView {
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
        stateAt: "2026-01-01T10:00:00.000Z",
        ...overrides
    };
}

export function account(overrides: Partial<DeviceAccountView> = {}): DeviceAccountView {
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
        deviceCount: 1,
        ...overrides
    };
}
