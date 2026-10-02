/**
 * A setting sent to an air purifier: checked as the purifier's own kind before
 * anything leaves, handed to the driver as it came, and stored as it landed.
 *
 * The two kinds that take settings share action words, so a command shaped for
 * an air conditioner must never reach a purifier because "set-fan" matched.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const act = vi.fn();
const update = vi.fn();
const accountWithCredentials = vi.fn(async () => ({
    view: { connection: "philips-coap" },
    credentials: {}
}));

const AIR = {
    mode: "auto",
    modes: ["auto", "sleep"],
    speed: null,
    speeds: ["speed_1", "turbo"],
    humidity: null,
    options: { childLock: false },
    readings: { pm25: 4 },
    filters: []
};

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDevice: {
            findFirst: async () => ({
                id: "air",
                externalId: "10.0.1.40",
                accountId: "account-1",
                vendor: "philips",
                kind: "air",
                name: "Bedroom purifier",
                zone: null,
                placeId: null,
                model: null,
                firmware: null,
                state: "on",
                doorState: "none",
                batteryPercent: null,
                batteryCritical: false,
                online: true,
                controllable: true,
                value: "4",
                unit: "µg/m³",
                climate: null,
                air: AIR,
                stateAt: null
            }),
            update: (args: unknown) => {
                update(args);
                return {
                    ...(args as { data: object }).data,
                    id: "air",
                    kind: "air",
                    name: "Bedroom purifier"
                };
            }
        },
        placeDeviceEvent: { create: vi.fn() }
    }
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    accountWithCredentials,
    driverFor: () => ({ act })
}));

vi.mock("@polaris-app/places/src/lib/automation-runtime", () => ({ observeDevices: vi.fn() }));

const { actOnDevice } = await import("@polaris-app/places/src/lib/devices");

beforeEach(() => {
    act.mockReset();
    update.mockReset();
    accountWithCredentials.mockClear();
});

describe("a command on an air purifier", () => {
    it("refuses an air conditioner's setting, before anything is sent", async () => {
        await expect(
            actOnDevice("app", "air", "set-fan", "", { action: "set-fan", fan: "high" })
        ).rejects.toThrow("That device cannot be told to do that");
        expect(accountWithCredentials).not.toHaveBeenCalled();
    });

    it("refuses a speed the unit does not have", async () => {
        await expect(
            actOnDevice("app", "air", "set-fan", "", { action: "set-fan", speed: "speed_2" })
        ).rejects.toThrow("That fan speed is not one this device has");
        expect(act).not.toHaveBeenCalled();
    });

    it("sends one it has, and stores the unit as it landed", async () => {
        await actOnDevice("app", "air", "set-fan", "Ana", { action: "set-fan", speed: "turbo" });
        expect(act).toHaveBeenCalledWith(
            {},
            { externalId: "10.0.1.40", kind: "air" },
            "set-fan",
            { action: "set-fan", speed: "turbo" }
        );
        const data = (
            update.mock.calls[0]![0] as {
                data: { air: { speed: string; mode: unknown }; state?: string };
            }
        ).data;
        expect(data.air).toMatchObject({ speed: "turbo", mode: null });
        // A setting is not a change of power.
        expect(data.state).toBeUndefined();
    });
});
