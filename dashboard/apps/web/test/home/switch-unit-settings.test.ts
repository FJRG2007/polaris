/**
 * A setting the whole wall switch shares - child lock, power-on, indicator -
 * changed from one gang's row lands on every gang's row of the same unit, and a
 * gang's own timer stays on that gang.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const act = vi.fn();
const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
const findMany = vi.fn();
const announced: { id: string }[][] = [];

const SETTINGS = {
    powerOn: "last",
    indicator: "status",
    indicators: ["off", "status", "position"],
    childLock: false,
    countdown: 0
};

function rowOf(id: string, externalId: string) {
    return {
        id,
        externalId,
        accountId: "account-1",
        vendor: "tuya",
        kind: "switch",
        name: `Hallway ${id}`,
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
        value: null,
        unit: null,
        climate: null,
        air: null,
        light: null,
        appliance: null,
        litter: null,
        switchSettings: SETTINGS,
        reach: "local",
        stateAt: null
    };
}

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDevice: {
            findFirst: async () => rowOf("gang-1", "bf2gang#switch_1"),
            findMany: async (args: unknown) => findMany(args),
            update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
                updates.push(args);
                return { ...rowOf(args.where.id, "unused"), ...args.data };
            }
        },
        placeDeviceEvent: { create: vi.fn() }
    }
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    accountWithCredentials: async () => ({ view: { connection: "tuya-app" }, credentials: {} }),
    driverFor: () => ({ act, history: true })
}));

vi.mock("@polaris-app/places/src/lib/device-live", () => ({
    announceDevices: (_app: string, views: { id: string }[]) => announced.push(views)
}));
vi.mock("@polaris-app/places/src/lib/automation-runtime", () => ({ observeDevices: vi.fn() }));
vi.mock("@polaris-app/places/src/lib/device-watch", () => ({ requestFollowUps: vi.fn() }));

const { actOnDevice } = await import("@polaris-app/places/src/lib/devices");

beforeEach(() => {
    act.mockReset();
    findMany.mockReset();
    findMany.mockResolvedValue([rowOf("gang-2", "bf2gang#switch_2")]);
    updates.length = 0;
    announced.length = 0;
});

describe("a setting on a switch with several gangs", () => {
    it("puts the unit's child lock on every gang of the same device", async () => {
        await actOnDevice("app", "gang-1", "set-option", "", {
            action: "set-option",
            setting: "child-lock",
            on: true
        });
        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    accountId: "account-1",
                    id: { not: "gang-1" },
                    externalId: { startsWith: "bf2gang#" }
                })
            })
        );
        expect(updates.map((entry) => entry.where.id)).toEqual(["gang-1", "gang-2"]);
        expect(updates[1]!.data.switchSettings).toMatchObject({ childLock: true });
        expect(announced[0]!.map((view) => view.id)).toEqual(["gang-1", "gang-2"]);
    });

    it("keeps a gang's timer on that gang", async () => {
        await actOnDevice("app", "gang-1", "set-option", "", {
            action: "set-option",
            setting: "countdown",
            seconds: 300
        });
        expect(findMany).not.toHaveBeenCalled();
        expect(updates.map((entry) => entry.where.id)).toEqual(["gang-1"]);
    });
});
