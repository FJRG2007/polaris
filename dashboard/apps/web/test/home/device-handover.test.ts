/**
 * The same device reached a second way is moved, not listed twice - within one
 * owner's install only - and a device that leaves the house is marked gone,
 * never deleted, with the offer to restore it if it comes back.
 *
 * The sync runs for real against an in-memory stand-in for the three tables it
 * touches, so what is asserted is the rows it leaves behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const tables: { accounts: Row[]; devices: Row[]; events: Row[] } = {
    accounts: [],
    devices: [],
    events: []
};
let seq = 0;

function same(a: unknown, b: unknown): boolean {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return (a ?? null) === (b ?? null);
}

function matches(row: Row, where: Row | undefined): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
        if (key === "OR") {
            if (!(cond as Row[]).some((each) => matches(row, each))) return false;
            continue;
        }
        if (key === "account" || key === "device") {
            const linked =
                key === "account"
                    ? tables.accounts.find((each) => each.id === row.accountId)
                    : tables.devices.find((each) => each.id === row.deviceId);
            if (!linked || !matches(linked, cond as Row)) return false;
            continue;
        }
        const value = row[key];
        if (cond === null || typeof cond !== "object" || cond instanceof Date) {
            if (!same(value, cond)) return false;
            continue;
        }
        const c = cond as Row;
        if ("in" in c && !(c.in as unknown[]).some((each) => same(each, value))) return false;
        if ("notIn" in c && (c.notIn as unknown[]).some((each) => same(each, value))) return false;
        if ("not" in c && same(value, c.not)) return false;
        if ("gte" in c && !(value instanceof Date && value >= (c.gte as Date))) return false;
    }
    return true;
}

function shaped(row: Row): Row {
    return {
        ...row,
        labels: [],
        account: tables.accounts.find((each) => each.id === row.accountId) ?? null,
        device: tables.devices.find((each) => each.id === row.deviceId) ?? null
    };
}

function unique(candidate: Row, except?: Row): void {
    const clash = tables.devices.find(
        (each) =>
            each !== except &&
            each.accountId === candidate.accountId &&
            each.externalId === candidate.externalId
    );
    if (clash) throw new Error("fixture: unique (accountId, externalId)");
}

const DEVICE_DEFAULTS = {
    zone: null,
    placeId: null,
    roomId: null,
    model: null,
    firmware: null,
    batteryLowPercent: null,
    controllable: true,
    value: null,
    unit: null,
    climate: null,
    air: null,
    light: null,
    appliance: null,
    litter: null,
    switchSettings: null,
    reach: null,
    stateAt: null,
    goneAt: null,
    returnedAt: null
};

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        placeDeviceAccount: {
            findFirst: async ({ where }: { where: Row }) =>
                tables.accounts.find((row) => matches(row, where)) ?? null
        },
        placeDevice: {
            findMany: async ({ where }: { where: Row }) =>
                tables.devices.filter((row) => matches(row, where)).map(shaped),
            findFirst: async ({ where }: { where: Row }) => {
                const row = tables.devices.find((each) => matches(each, where));
                return row ? shaped(row) : null;
            },
            updateMany: async ({ where, data }: { where: Row; data: Row }) => {
                const rows = tables.devices.filter((row) => matches(row, where));
                for (const row of rows) {
                    unique({ ...row, ...data }, row);
                    Object.assign(row, data);
                }
                return { count: rows.length };
            },
            upsert: async ({
                where,
                update,
                create
            }: {
                where: { accountId_externalId: Row };
                update: Row;
                create: Row;
            }) => {
                const found = tables.devices.find((row) =>
                    matches(row, where.accountId_externalId)
                );
                if (found) return shaped(Object.assign(found, update));
                const row = { ...DEVICE_DEFAULTS, id: `new-${(seq += 1)}`, ...create };
                unique(row);
                tables.devices.push(row);
                return shaped(row);
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const before = tables.devices.length;
                tables.devices = tables.devices.filter((row) => !matches(row, where));
                return { count: before - tables.devices.length };
            }
        },
        placeDeviceEvent: {
            create: async ({ data }: { data: Row }) => {
                tables.events.push({ id: `event-${(seq += 1)}`, ...data });
                return data;
            },
            createMany: async () => ({ count: 0 }),
            findMany: async ({ where }: { where: Row }) =>
                tables.events
                    .filter((row) => matches(row, where))
                    .sort((a, b) => (b.at as Date).getTime() - (a.at as Date).getTime())
                    .map(shaped)
        }
    }
}));

/** What the account being read answers with. */
let reading: string[] = [];
function snapshotsFor(ids: readonly string[]) {
    return ids.map((externalId) => ({
        externalId,
        kind: "outlet",
        name: `Smart Plug ${externalId}`,
        model: "",
        firmware: "",
        state: "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true
    }));
}

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    listAccounts: async (installedAppId: string) =>
        tables.accounts.filter((row) => row.installedAppId === installedAppId),
    isConnectable: () => true,
    accountWithCredentials: async (_install: string, id: string) => ({
        view: tables.accounts.find((row) => row.id === id),
        credentials: {}
    }),
    driverFor: () => ({ list: async () => snapshotsFor(reading) }),
    markSynced: async () => undefined,
    accountFailed: async () => undefined
}));

vi.mock("@polaris-app/places/src/lib/device-live", () => ({
    announceDevices: () => undefined,
    announceAccounts: () => undefined,
    hasListeners: () => false
}));
vi.mock("@polaris-app/places/src/lib/litter-alerts", () => ({
    previousLitter: async () => new Map(),
    tellLitter: async () => undefined
}));
vi.mock("@polaris-app/places/src/lib/automation-runtime", () => ({ observeDevices: vi.fn() }));
const dropGrantsFor = vi.fn(async () => undefined);
vi.mock("@polaris/app-host", () => ({ host: { accessGrants: { dropGrantsFor } } }));

const devices = await import("@polaris-app/places/src/lib/devices");
const handover = await import("@polaris-app/places/src/lib/device-handover");

const MINE = "install-mine";
const THEIRS = "install-theirs";

function account(id: string, connection: string, at: number, install = MINE, status = "ok"): Row {
    const row = {
        id,
        installedAppId: install,
        brand: "Tuya",
        connection,
        label: "Home",
        status,
        createdAt: new Date(at)
    };
    tables.accounts.push(row);
    return row;
}

function device(id: string, accountId: string, externalId: string, overrides: Row = {}): Row {
    const owner = tables.accounts.find((row) => row.id === accountId)!;
    const row = {
        ...DEVICE_DEFAULTS,
        id,
        installedAppId: owner.installedAppId,
        accountId,
        vendor: "tuya",
        kind: "outlet",
        externalId,
        name: "Desk lamp",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        createdAt: new Date(0),
        ...overrides
    };
    tables.devices.push(row);
    return row;
}

/** One account read, listing these Tuya device ids. */
async function sync(accountId: string, ...ids: string[]): Promise<void> {
    reading = ids;
    const install = tables.accounts.find((row) => row.id === accountId)!.installedAppId as string;
    const result = await devices.syncDevices(install, { only: [accountId] });
    expect(result.error).toBeNull();
}

const rowsOf = (externalId: string) => tables.devices.filter((row) => row.externalId === externalId);

beforeEach(() => {
    tables.accounts = [];
    tables.devices = [];
    tables.events = [];
    reading = [];
    dropGrantsFor.mockClear();
});

describe("the same owner switching connections", () => {
    it("moves the Tuya cloud project's device onto the Smart Life one, row and all", async () => {
        account("cloud", "tuya-cloud", 1, MINE, "lapsed");
        account("app", "tuya-app", 2);
        device("lamp", "cloud", "bf01", { name: "Warehouse lamp", roomId: "room-1" });
        tables.events.push({ id: "e1", deviceId: "lamp", action: "turn-on", at: new Date(5) });

        await sync("app", "bf01");

        expect(rowsOf("bf01")).toHaveLength(1);
        const moved = rowsOf("bf01")[0]!;
        expect(moved).toMatchObject({
            id: "lamp",
            accountId: "app",
            name: "Warehouse lamp",
            roomId: "room-1",
            state: "on"
        });
        // Its history is still its own, with the move written into it.
        expect(tables.events.map((event) => [event.deviceId, event.action])).toEqual([
            ["lamp", "turn-on"],
            ["lamp", "moved"]
        ]);
        // Nothing is left on the old connection for removing it to take.
        expect(tables.devices.filter((row) => row.accountId === "cloud")).toEqual([]);
        const [summary] = await handover.recentHandovers(MINE);
        expect(summary).toEqual({ from: "cloud", to: "app", count: 1 });
    });

    it("is idempotent, and never trades the device back and forth while both work", async () => {
        account("cloud", "tuya-cloud", 1);
        account("app", "tuya-app", 2);
        device("lamp", "cloud", "bf01");

        await sync("app", "bf01");
        await sync("app", "bf01");
        // The older connection, still working, reads the same device: left alone.
        await sync("cloud", "bf01");
        await sync("app", "bf01");

        expect(rowsOf("bf01")).toEqual([expect.objectContaining({ id: "lamp", accountId: "app" })]);
        expect(tables.events.filter((event) => event.action === "moved")).toHaveLength(1);
    });

    it("gives the device back to the older connection when the newer one stops working", async () => {
        account("cloud", "tuya-cloud", 1);
        const app = account("app", "tuya-app", 2);
        device("lamp", "app", "bf01");
        app.status = "unauthorized";

        await sync("cloud", "bf01");

        expect(rowsOf("bf01")).toEqual([expect.objectContaining({ id: "lamp", accountId: "cloud" })]);
    });

    it("never matches across connections whose ids are not the make's own", async () => {
        account("bridge-a", "hue-bridge", 1);
        account("bridge-b", "hue-bridge", 2);
        device("light-a", "bridge-a", "1");

        await sync("bridge-b", "1");

        expect(rowsOf("1").map((row) => row.accountId).sort()).toEqual(["bridge-a", "bridge-b"]);
    });

    it("leaves two rows made before this existed as they are rather than merging them", async () => {
        account("cloud", "tuya-cloud", 1, MINE, "lapsed");
        account("app", "tuya-app", 2);
        device("old", "cloud", "bf01");
        device("dup", "app", "bf01");

        await sync("app", "bf01");

        expect(rowsOf("bf01").map((row) => row.id).sort()).toEqual(["dup", "old"]);
    });
});

describe("a device that changes hands", () => {
    it("lands on the new owner's install as a new device, and nothing of the old one's travels", async () => {
        account("mine", "tuya-app", 1, MINE);
        account("theirs", "tuya-app", 2, THEIRS);
        device("lamp", "mine", "bf01", { name: "Warehouse lamp", roomId: "room-1" });
        tables.events.push({ id: "e1", deviceId: "lamp", action: "turn-on", at: new Date(5) });

        await sync("theirs", "bf01");

        const theirs = rowsOf("bf01").find((row) => row.installedAppId === THEIRS)!;
        expect(theirs.id).not.toBe("lamp");
        expect(theirs).toMatchObject({ name: "Smart Plug bf01", roomId: null });
        expect(tables.events.filter((event) => event.deviceId === theirs.id)).toEqual([]);
        // The previous owner's row is untouched by somebody else connecting it.
        expect(tables.devices.find((row) => row.id === "lamp")).toMatchObject({
            accountId: "mine",
            goneAt: null
        });
    });

    it("is marked gone on the old owner's side, kept with its history, and acts on nothing", async () => {
        account("mine", "tuya-app", 1, MINE);
        device("lamp", "mine", "bf01");
        tables.events.push({ id: "e1", deviceId: "lamp", action: "turn-on", at: new Date(5) });

        await sync("mine");

        const lamp = tables.devices.find((row) => row.id === "lamp")!;
        expect(lamp.goneAt).toBeInstanceOf(Date);
        expect(lamp.online).toBe(false);
        expect(tables.events).toHaveLength(1);
        expect(dropGrantsFor).not.toHaveBeenCalled();
        const [view] = await devices.listDevices(MINE);
        expect(view!.gone).toBe("away");
        await expect(devices.actOnDevice(MINE, "lamp", "turn-on")).rejects.toThrow(
            /no longer on any of this house's connections/
        );
        // An automation's read of it finds nothing to act on.
        const { prisma } = await import("@polaris/db");
        expect(
            await prisma.placeDevice.findFirst({
                where: { id: "lamp", installedAppId: MINE, goneAt: null }
            })
        ).toBeNull();
    });

    it("offers to restore it when it comes back, and restoring keeps its id and history", async () => {
        account("mine", "tuya-app", 1, MINE);
        device("lamp", "mine", "bf01", { name: "Warehouse lamp" });
        tables.events.push({ id: "e1", deviceId: "lamp", action: "turn-on", at: new Date(5) });
        await sync("mine");

        await sync("mine", "bf01");
        expect(rowsOf("bf01")).toHaveLength(1);
        expect((await devices.listDevices(MINE))[0]!.gone).toBe("back");
        await expect(devices.actOnDevice(MINE, "lamp", "turn-on")).rejects.toThrow();

        const restored = await devices.restoreDevice(MINE, "lamp");
        expect(restored).toMatchObject({ id: "lamp", name: "Warehouse lamp", gone: null });
        expect(tables.events.filter((event) => event.deviceId === "lamp")).toHaveLength(1);
    });

    it("comes back through another of the owner's connections as an offer, moved onto it", async () => {
        account("cloud", "tuya-cloud", 1);
        account("app", "tuya-app", 2);
        device("lamp", "cloud", "bf01");
        await sync("cloud");

        await sync("app", "bf01");

        expect(rowsOf("bf01")).toEqual([
            expect.objectContaining({ id: "lamp", accountId: "app", returnedAt: expect.any(Date) })
        ]);
    });

    it("starting afresh removes the old row, and the next read lists a new device", async () => {
        account("mine", "tuya-app", 1, MINE);
        device("lamp", "mine", "bf01");
        await sync("mine");
        await sync("mine", "bf01");

        await devices.forgetDevice(MINE, "lamp");
        expect(dropGrantsFor).toHaveBeenCalledWith("place.device", "lamp");
        await sync("mine", "bf01");

        expect(rowsOf("bf01")).toEqual([
            expect.objectContaining({ goneAt: null, name: "Smart Plug bf01" })
        ]);
        expect(rowsOf("bf01")[0]!.id).not.toBe("lamp");
    });

    it("refuses to remove for good a device that is still here", async () => {
        account("mine", "tuya-app", 1, MINE);
        device("lamp", "mine", "bf01");
        await expect(devices.forgetDevice(MINE, "lamp")).rejects.toThrow();
        expect(rowsOf("bf01")).toHaveLength(1);
    });
});

describe("who keeps a device", () => {
    it("is the newer connection between two that work, and whichever works otherwise", () => {
        const old = { createdAt: new Date(1) };
        const newer = { createdAt: new Date(2) };
        expect(handover.takesOver(newer, { ...old, status: "ok" })).toBe(true);
        expect(handover.takesOver(old, { ...newer, status: "ok" })).toBe(false);
        expect(handover.takesOver(old, { ...newer, status: "lapsed" })).toBe(true);
    });

    it("shares ids only between connections that say so", () => {
        expect(handover.connectionsSharingIds("tuya-app").sort()).toEqual([
            "tuya-app",
            "tuya-cloud"
        ]);
        expect(handover.connectionsSharingIds("hue-bridge")).toEqual([]);
    });
});
