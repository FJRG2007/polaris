/**
 * A setting rides only on the action that takes one.
 *
 * A command attached to on or off would otherwise be dropped on its way to the
 * driver and still be written to the row and the history as if it had landed.
 */

import { describe, expect, it, vi } from "vitest";

const accountWithCredentials = vi.fn();

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDevice: {
            findFirst: async () => ({
                id: "ac",
                externalId: "living-room",
                accountId: "account-1",
                vendor: "gree",
                kind: "climate",
                name: "Living room AC",
                zone: null,
                placeId: null,
                model: null,
                firmware: null,
                state: "off",
                doorState: "none",
                batteryPercent: null,
                batteryCritical: false,
                online: true,
                controllable: true,
                value: null,
                unit: null,
                climate: {
                    mode: "cool",
                    modes: ["cool", "heat"],
                    target: 22,
                    min: 16,
                    max: 30,
                    step: 1,
                    unit: "C",
                    fan: null,
                    fans: [],
                    options: {}
                },
                stateAt: null
            }),
            update: vi.fn()
        },
        placeDeviceEvent: { create: vi.fn() }
    }
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    accountWithCredentials,
    driverFor: vi.fn()
}));

const { actOnDevice } = await import("@polaris-app/places/src/lib/devices");

describe("a command on an air conditioner", () => {
    it.each(["turn-on", "turn-off"] as const)(
        "is refused on %s, before anything is sent",
        async (action) => {
            await expect(
                actOnDevice("app", "ac", action, "", { action: "set-mode", mode: "heat" })
            ).rejects.toThrow("Say what to set it to");
            expect(accountWithCredentials).not.toHaveBeenCalled();
        }
    );
});
