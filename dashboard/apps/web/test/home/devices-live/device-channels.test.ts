/**
 * The makes that push their changes are heard between the timer's passes.
 *
 * What is pinned is the channel's life, not any make's protocol: one channel
 * per account whose driver can listen and none for the rest; a burst of
 * changes is one read, and reads for pushed changes are spaced; a change
 * about nothing this account shows costs no read, and one that cannot say what
 * changed reads; a channel that drops is opened again after a wait that grows;
 * and an account that goes, or an install nobody keeps read, closes its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Changed = (externalIds: readonly string[]) => void;

const mocks = vi.hoisted(() => ({
    findFirst: vi.fn(),
    accountWithCredentials: vi.fn(),
    listen: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: { placeDevice: { findFirst: mocks.findFirst } } }));
vi.mock("@polaris-app/places/src/lib/device-accounts", () => ({
    isConnectable: (connection: string) => connection !== "gone",
    driverFor: (connection: string) =>
        connection === "home-assistant" ? { connection, listen: mocks.listen } : { connection },
    accountWithCredentials: mocks.accountWithCredentials
}));

const push = await import("@polaris-app/places/src/lib/device-push");
const { DriverError } = await import("@polaris-app/places/src/lib/drivers/contract");

const INSTALL = "install-1";
const HA = { id: "ha", connection: "home-assistant" };
const CLOUD = { id: "nuki", connection: "nuki-web" };

/** Every channel opened, with the way to push a change on it and to drop it. */
let opened: { changed: Changed; signal: AbortSignal; drop: (error?: Error) => void }[] = [];
let read = vi.fn();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-06T12:00:00.000Z"));
    vi.clearAllMocks();
    opened = [];
    read = vi.fn(async () => undefined);
    mocks.accountWithCredentials.mockResolvedValue({ credentials: { url: "http://ha.test" } });
    mocks.findFirst.mockResolvedValue({ id: "device-row" });
    mocks.listen.mockImplementation(
        (_credentials: unknown, changed: Changed, signal: AbortSignal) =>
            new Promise<void>((resolve, reject) => {
                opened.push({
                    changed,
                    signal,
                    drop: (error) => (error ? reject(error) : resolve())
                });
                signal.addEventListener("abort", () => resolve());
            })
    );
});

afterEach(() => {
    push.stopListening(INSTALL);
    vi.useRealTimers();
});

async function settle(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
}

describe("which accounts are listened to", () => {
    it("opens one channel per account whose make pushes, however often it is asked", async () => {
        push.keepListening(INSTALL, [HA, CLOUD], read);
        push.keepListening(INSTALL, [HA, CLOUD], read);
        await settle();
        expect(opened).toHaveLength(1);
        expect(push.listening(INSTALL)).toEqual(["ha"]);
    });

    it("closes the channel of an account that is gone", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        push.keepListening(INSTALL, [], read);
        expect(opened[0]?.signal.aborted).toBe(true);
        expect(push.listening(INSTALL)).toEqual([]);
    });

    it("closes every channel of an install nobody keeps read", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        push.stopListening(INSTALL);
        expect(opened[0]?.signal.aborted).toBe(true);
    });
});

describe("a change pushed", () => {
    it("reads the account once for a burst, through the one path", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.changed(["lock.front_door"]);
        opened[0]!.changed(["light.hall"]);
        opened[0]!.changed(["lock.front_door"]);
        await settle(push.PUSH_DEBOUNCE_MS);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith("ha");
        expect(mocks.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { accountId: "ha", externalId: { in: ["lock.front_door", "light.hall"] } }
            })
        );
    });

    it("spaces the reads of a chatty account", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.changed(["sensor.power"]);
        await settle(push.PUSH_DEBOUNCE_MS);
        opened[0]!.changed(["sensor.power"]);
        await settle(push.PUSH_DEBOUNCE_MS);
        expect(read).toHaveBeenCalledTimes(1);
        await settle(push.PUSH_MIN_GAP_MS);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it("costs no read when it is about nothing the account shows", async () => {
        mocks.findFirst.mockResolvedValue(null);
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.changed(["sun.sun"]);
        await settle(push.PUSH_DEBOUNCE_MS);
        expect(read).not.toHaveBeenCalled();
    });

    it("reads when it cannot say what changed", async () => {
        mocks.findFirst.mockResolvedValue(null);
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.changed([]);
        await settle(push.PUSH_DEBOUNCE_MS);
        expect(read).toHaveBeenCalledTimes(1);
        expect(mocks.findFirst).not.toHaveBeenCalled();
    });
});

describe("a channel that drops", () => {
    it("is opened again after a wait that grows with each failure", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.drop(new DriverError("The device did not answer in time.", "unreachable"));
        await settle(push.retryDelay(1) - 1);
        expect(opened).toHaveLength(1);
        await settle(1);
        expect(opened).toHaveLength(2);
        opened[1]!.drop(new DriverError("The device did not answer in time.", "unreachable"));
        await settle(push.retryDelay(1));
        expect(opened).toHaveLength(2);
        await settle(push.retryDelay(2) - push.retryDelay(1));
        expect(opened).toHaveLength(3);
        expect(push.retryDelay(2)).toBe(2 * push.retryDelay(1));
        expect(push.retryDelay(50)).toBe(push.MAX_BACKOFF_MS);
    });

    it("waits the longest after a refused sign-in", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.drop(new DriverError("Home Assistant refused the token.", "unauthorized"));
        await settle(push.MAX_BACKOFF_MS - 1);
        expect(opened).toHaveLength(1);
        await settle(1);
        expect(opened).toHaveLength(2);
    });

    it("starts over after one that had been working closes", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        await settle(10 * 60 * 1000);
        opened[0]!.drop();
        await settle(push.retryDelay(1));
        expect(opened).toHaveLength(2);
    });

    it("is not opened again once its install is let go", async () => {
        push.keepListening(INSTALL, [HA], read);
        await settle();
        opened[0]!.drop(new DriverError("The device did not answer in time.", "unreachable"));
        await settle();
        push.stopListening(INSTALL);
        await settle(push.MAX_BACKOFF_MS);
        expect(opened).toHaveLength(1);
    });
});
