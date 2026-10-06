/**
 * The devices read with nobody looking, and read again after a command.
 *
 * What is pinned is Home Assistant's coordinator: every install with a device
 * account is read in the background from boot, at half the pace of an open
 * screen; a command is followed by reads a couple of seconds apart that stop
 * once the device has stopped moving; a reader that cannot wait gets a read
 * now, bounded; and however many of those ask at once, the account is read
 * once. All of it through `syncDevices`, quietly - never a probe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    listAccounts: vi.fn(),
    installsWithAccounts: vi.fn(),
    syncDevices: vi.fn(),
    getDevice: vi.fn(),
    keepListening: vi.fn(),
    stopListening: vi.fn()
}));

vi.mock("@polaris-app/places/src/lib/device-push", () => ({
    keepListening: mocks.keepListening,
    stopListening: mocks.stopListening
}));

vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    listAccounts: mocks.listAccounts,
    installsWithAccounts: mocks.installsWithAccounts,
    isConnectable: (connection: string) => connection !== "philips-tv"
}));
vi.mock("@polaris-app/places/src/lib/device-connections", () => ({
    deviceConnection: (connection: string) => ({
        reach: connection.endsWith("-local") ? "same-network" : "cloud"
    })
}));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    syncDevices: mocks.syncDevices,
    getDevice: mocks.getDevice
}));

const watch = await import("@polaris-app/places/src/lib/device-watch");

const INSTALL = "install-1";
let syncedAt: string | null = null;

/** Let the timers that are due run, and what they started settle. */
async function advance(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-06T12:00:00.000Z"));
    vi.clearAllMocks();
    syncedAt = null;
    mocks.installsWithAccounts.mockResolvedValue([INSTALL]);
    mocks.listAccounts.mockImplementation(async () => [
        { id: "nuki", connection: "nuki-web", lastSyncedAt: syncedAt }
    ]);
    mocks.syncDevices.mockImplementation(async () => {
        syncedAt = new Date().toISOString();
        return { devices: 1, error: null, failed: [] };
    });
    mocks.getDevice.mockResolvedValue({ id: "door", state: "locked" });
});

afterEach(() => {
    watch.stopDeviceCoordinator();
    vi.useRealTimers();
});

describe("the cadence with nobody looking", () => {
    it("is half the pace of an open screen, and keeps SwitchBot well inside its quota", () => {
        expect(watch.pollInterval("nuki-web", false)).toBe(2 * watch.CLOUD_POLL_MS);
        expect(watch.pollInterval("shelly-local", false)).toBe(2 * watch.LOCAL_POLL_MS);
        const daily = (24 * 60 * 60 * 1000) / watch.pollInterval("switchbot-cloud", false);
        expect(daily).toBeLessThanOrEqual(1000);
    });

    it("reads a follow-up when it is due however recently the account was read", () => {
        const now = Date.now();
        const plan = watch.dueAccounts(
            [
                {
                    id: "nuki",
                    connection: "nuki-web",
                    lastSyncedAt: new Date(now - 1000).toISOString()
                }
            ],
            new Map(),
            now,
            { watched: false, followUps: new Map([["nuki", now]]) }
        );
        expect(plan.due).toEqual(["nuki"]);
        const later = watch.dueAccounts(
            [
                {
                    id: "nuki",
                    connection: "nuki-web",
                    lastSyncedAt: new Date(now - 1000).toISOString()
                }
            ],
            new Map(),
            now,
            { watched: false, followUps: new Map([["nuki", now + 4000]]) }
        );
        expect(later).toEqual({ due: [], nextInMs: 4000 });
    });
});

describe("the background coordinator", () => {
    it("reads every install with accounts from boot, quietly, with no screen open", async () => {
        watch.startDeviceCoordinator();
        await advance(0);
        expect(mocks.syncDevices).toHaveBeenCalledWith(INSTALL, { probe: false, only: ["nuki"] });
        await advance(2 * watch.CLOUD_POLL_MS - 1000);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
        await advance(1000);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(2);
    });

    it("runs once however often it is started, and stops cleanly", async () => {
        watch.startDeviceCoordinator();
        watch.startDeviceCoordinator();
        await advance(0);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
        watch.stopDeviceCoordinator();
        await advance(10 * watch.CLOUD_POLL_MS);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
    });

    it("keeps an open screen's faster pace, and its own after the screen closes", async () => {
        watch.startDeviceCoordinator();
        await advance(0);
        const release = watch.watchDevices(INSTALL);
        await advance(watch.CLOUD_POLL_MS);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(2);
        release();
        await advance(watch.CLOUD_POLL_MS);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(2);
        await advance(watch.CLOUD_POLL_MS);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(3);
    });
});

describe("the makes that push", () => {
    it("are listened to from the first pass, and let go when nothing keeps the install read", async () => {
        watch.startDeviceCoordinator();
        await advance(0);
        expect(mocks.keepListening).toHaveBeenCalledWith(
            INSTALL,
            [expect.objectContaining({ id: "nuki", connection: "nuki-web" })],
            expect.any(Function)
        );
        // What a change on a channel does: read that account through the one path.
        const read = mocks.keepListening.mock.calls[0]![2] as (id: string) => Promise<unknown>;
        mocks.syncDevices.mockClear();
        await read("nuki");
        expect(mocks.syncDevices).toHaveBeenCalledWith(INSTALL, { probe: false, only: ["nuki"] });
        watch.stopDeviceCoordinator();
        expect(mocks.stopListening).toHaveBeenCalledWith(INSTALL);
    });

    it("never stop the timer when listening fails", async () => {
        mocks.keepListening.mockImplementation(() => {
            throw new Error("no driver");
        });
        try {
            watch.startDeviceCoordinator();
            await advance(0);
            expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
        } finally {
            mocks.keepListening.mockReset();
        }
    });
});

describe("after a command", () => {
    it("reads the account again a couple of seconds later, and stops once the device settled", async () => {
        syncedAt = new Date().toISOString();
        watch.requestFollowUps(INSTALL, "nuki", "door");
        await advance(watch.FOLLOW_UP_MS[0]!);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
        // Locked by now: no more follow-ups, and nothing else is keeping it read.
        await advance(30_000);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
    });

    it("keeps reading while the device is still moving, up to the last follow-up", async () => {
        mocks.getDevice.mockResolvedValue({ id: "door", state: "moving" });
        syncedAt = new Date().toISOString();
        watch.requestFollowUps(INSTALL, "nuki", "door");
        await advance(watch.FOLLOW_UP_MS[2]!);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(3);
        await advance(60_000);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(3);
    });
});

describe("reading now", () => {
    it("reads an account once however many ask at the same moment", async () => {
        let finish: (value: unknown) => void = () => undefined;
        mocks.syncDevices.mockImplementation(
            () => new Promise((resolve) => (finish = () => resolve({ failed: [] })))
        );
        const first = watch.readAccounts(INSTALL, ["nuki"]);
        const second = watch.readAccounts(INSTALL, ["nuki"]);
        await advance(0);
        finish(undefined);
        expect(await first).toEqual([]);
        expect(await second).toEqual([]);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(1);
    });

    it("answers within its time limit and lets the read land later", async () => {
        mocks.syncDevices.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ failed: [] }), 10_000))
        );
        const asked = watch.refreshAccounts(INSTALL, ["nuki"], 4000);
        const before = Date.now() - 1;
        await advance(4000);
        expect(await asked).toBe("timeout");
        const waited = watch.waitForRead("nuki", before, 10_000);
        await advance(6000);
        expect(await waited).toBe(true);
    });

    it("never takes a read started before a command for one made after it", async () => {
        let finish: (value: unknown) => void = () => undefined;
        mocks.syncDevices.mockImplementationOnce(
            () => new Promise((resolve) => (finish = () => resolve({ failed: [] })))
        );
        const early = watch.readAccounts(INSTALL, ["garage"]);
        await advance(1000);
        const actedAt = Date.now();
        let settled = false;
        const waited = watch.waitForRead("garage", actedAt, 10_000).then((read) => {
            settled = true;
            return read;
        });
        await advance(500);
        finish(undefined);
        expect(await early).toEqual([]);
        await advance(0);
        expect(settled).toBe(false);
        const late = watch.readAccounts(INSTALL, ["garage"], new Map([["garage", actedAt]]));
        await advance(0);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(2);
        expect(await late).toEqual([]);
        expect(await waited).toBe(true);
    });

    it("starts a follow-up's own read instead of joining one from before the command", async () => {
        let finish: (value: unknown) => void = () => undefined;
        mocks.syncDevices.mockImplementationOnce(
            () => new Promise((resolve) => (finish = () => resolve({ failed: [] })))
        );
        const early = watch.readAccounts(INSTALL, ["garage"]);
        await advance(500);
        const since = Date.now();
        const late = watch.readAccounts(INSTALL, ["garage"], new Map([["garage", since]]));
        await advance(0);
        expect(mocks.syncDevices).toHaveBeenCalledTimes(2);
        expect(await late).toEqual([]);
        finish(undefined);
        expect(await early).toEqual([]);
    });

    it("says when an account refused", async () => {
        mocks.syncDevices.mockResolvedValue({ failed: ["nuki"] });
        const asked = watch.refreshAccounts(INSTALL, ["nuki"], 4000);
        await advance(0);
        expect(await asked).toBe("failed");
    });
});
