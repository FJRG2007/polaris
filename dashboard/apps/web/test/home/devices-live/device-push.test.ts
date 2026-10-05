/**
 * A sync or a press reaches every open devices screen, and only with what
 * changed - filtered, per reader, to the place they look at and what they reach.
 *
 * The sync runs for real against a fake account and a fake table, so the test
 * is about the path from the account to the bus: the first read publishes the
 * device, a second read that found the same state publishes only that it was
 * confirmed, a changed read publishes the change, and a device the account no
 * longer has is published as removed.
 */

import { account } from "./fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    accountId: string;
    externalId: string;
    vendor: string;
    kind: string;
    name: string;
    zone: string | null;
    placeId: string | null;
    model: string | null;
    firmware: string | null;
    state: string;
    doorState: string;
    batteryPercent: number | null;
    batteryCritical: boolean;
    online: boolean;
    controllable: boolean;
    value: string | null;
    unit: string | null;
    climate: null;
    air: null;
    appliance: null;
    stateAt: Date | null;
}

const rows = new Map<string, Row>();
let snapshots: { externalId: string; state: string }[] = [];

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDevice: {
            upsert: async (args: {
                where: { accountId_externalId: { accountId: string; externalId: string } };
                update: Partial<Row>;
                create: Row;
            }) => {
                const key = args.where.accountId_externalId.externalId;
                const existing = [...rows.values()].find((row) => row.externalId === key);
                const row = existing
                    ? Object.assign(existing, args.update)
                    : { ...args.create, id: `id-${key}`, zone: null, placeId: null };
                rows.set(row.id, row as Row);
                return row;
            },
            findMany: async (args: { where: { externalId?: { notIn: string[] } } }) =>
                [...rows.values()].filter(
                    (row) => !args.where.externalId?.notIn.includes(row.externalId)
                ),
            deleteMany: async (args: { where: { id: { in: string[] } } }) => {
                for (const id of args.where.id.in) rows.delete(id);
                return { count: args.where.id.in.length };
            }
        }
    }
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    listAccounts: async () => [account()],
    isConnectable: () => true,
    accountWithCredentials: async () => ({ view: account(), credentials: {} }),
    driverFor: () => ({
        list: async () =>
            snapshots.map((snapshot) => ({
                externalId: snapshot.externalId,
                name: `Lamp ${snapshot.externalId}`,
                kind: "outlet",
                model: "",
                firmware: "",
                state: snapshot.state,
                doorState: "none",
                batteryPercent: null,
                batteryCritical: false,
                online: true
            }))
    }),
    markSynced: async () => undefined,
    markAccount: async () => undefined
}));

const dropped: string[] = [];
vi.mock("@/lib/access/grants", () => ({
    dropGrantsFor: async (_kind: string, id: string) => {
        dropped.push(id);
    }
}));

vi.mock("@polaris-app/places/src/lib/automation-runtime", () => ({
    observeDevices: async () => undefined
}));

const live = await import("@polaris-app/places/src/lib/device-live");
const { syncDevices } = await import("@polaris-app/places/src/lib/devices");

describe("a sync, as an open screen hears it", () => {
    const heard: Parameters<Parameters<typeof live.subscribeDeviceChanges>[0]>[0][] = [];
    let stop: () => void = () => undefined;

    beforeEach(() => {
        rows.clear();
        heard.length = 0;
        stop();
        stop = live.subscribeDeviceChanges((change) => heard.push(change));
    });

    it("publishes a device once, then only that it was confirmed", async () => {
        snapshots = [{ externalId: "a", state: "off" }];
        await syncDevices("install-1");
        const first = heard.find((change) => change.devices.length > 0);
        expect(first?.devices.map((device) => device.state)).toEqual(["off"]);

        heard.length = 0;
        await syncDevices("install-1");
        const devicesFrames = heard.filter((change) => !change.accounts);
        expect(devicesFrames).toHaveLength(1);
        expect(devicesFrames[0]!.devices).toEqual([]);
        expect(devicesFrames[0]!.seen?.ids).toEqual(["id-a"]);
        // The accounts follow every sync, so the "last read" chip moves too.
        expect(heard.some((change) => change.accounts?.[0]?.id === "account-1")).toBe(true);
    });

    it("publishes a change, and a device that is gone", async () => {
        snapshots = [
            { externalId: "a", state: "off" },
            { externalId: "b", state: "off" }
        ];
        await syncDevices("install-2");
        heard.length = 0;

        snapshots = [{ externalId: "a", state: "on" }];
        await syncDevices("install-2");
        const frame = heard.find((change) => !change.accounts)!;
        expect(frame.installedAppId).toBe("install-2");
        expect(frame.devices.map((device) => [device.id, device.state])).toEqual([["id-a", "on"]]);
        expect(frame.removed).toEqual(["id-b"]);
        // What was lent of it goes with it, as before.
        expect(dropped).toContain("id-b");
    });

    it("reads only the accounts it was asked to, and names the ones that failed", async () => {
        snapshots = [{ externalId: "a", state: "off" }];
        const skipped = await syncDevices("install-3", { only: ["another-account"] });
        expect(skipped).toEqual({ devices: 0, error: null, failed: [] });
        expect(heard).toEqual([]);
    });
});

describe("what one reader is sent", () => {
    const lamp = {
        id: "lamp",
        placeId: "place-1"
    } as unknown as import("@polaris-app/places/src/lib/device-kinds").DeviceView;
    const door = { ...lamp, id: "door", placeId: null };
    const shed = { ...lamp, id: "shed", placeId: "place-2" };
    const change = {
        devices: [lamp, door, shed],
        removed: ["gone"],
        seen: { ids: ["lamp", "door", "shed"], at: "2026-01-01T00:00:00.000Z" },
        accounts: [account()]
    };
    const resident = { everything: true, cameras: new Map(), devices: new Map() };
    const visitor = {
        everything: false,
        cameras: new Map(),
        devices: new Map([["door", "grant-1"]])
    };

    it("is the place they look at and what is not placed, the rest by id", () => {
        const frame = live.frameFor(change, resident, "place-1")!;
        expect(frame.devices.map((device) => device.id)).toEqual(["lamp", "door"]);
        expect(frame.removed).toEqual(["gone", "shed"]);
        expect(frame.accounts).toHaveLength(1);
    });

    it("is only the lent door for a visitor, and never the accounts", () => {
        const frame = live.frameFor(change, visitor, "place-1")!;
        expect(frame.devices.map((device) => device.id)).toEqual(["door"]);
        expect(frame.removed).toEqual([]);
        expect(frame.seen?.ids).toEqual(["door"]);
        expect(frame).not.toHaveProperty("accounts");
    });

    it("is nothing when none of it is theirs", () => {
        expect(
            live.frameFor(
                { devices: [shed], removed: [], seen: null, accounts: [account()] },
                visitor,
                "place-1"
            )
        ).toBeNull();
    });
});
