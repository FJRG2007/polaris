/**
 * The wait a device newly seen on an account serves before it may change what
 * protects that account.
 *
 * What is pinned here is the direction each uncertain case falls in, because
 * every one of them is a choice between inconveniencing the owner and helping
 * whoever has just taken their password:
 *
 *   - an account that asked for no wait is never held up, and pays no query it
 *     does not need;
 *   - a device with no description cannot be placed, and is held;
 *   - a session older than the register is not a new device, and is let through -
 *     the alternative locks out every account the day the feature ships;
 *   - a device that signs in again does not restart its own wait;
 *   - the device the account was opened from is never held, because there was no
 *     earlier device for a stolen password to be racing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY_MS = 24 * 60 * 60 * 1000;

const userSecurity = { findUnique: vi.fn(), upsert: vi.fn() };
const accountDevice = { findFirst: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() };
const session = { findFirst: vi.fn() };

vi.mock("@polaris/db", () => ({ prisma: { userSecurity, accountDevice, session } }));

const { accountDeviceStanding, newDeviceWaitMessage, rememberAccountDevice, sessionDeviceStanding } =
    await import("../../src/devices.js");

const CHROME = "Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Version/17.0 Safari/605.1.15";

/** An account that asks new devices to wait this many days. */
function graceOf(days: number) {
    userSecurity.findUnique.mockResolvedValue({ newDeviceGraceDays: days });
}

/** A device first seen this long ago. */
function firstSeenDaysAgo(days: number) {
    accountDevice.findUnique.mockResolvedValue({ firstSeenAt: new Date(Date.now() - days * DAY_MS) });
}

/** The browser the account was opened from. */
function openedFrom(userAgent: string) {
    accountDevice.findFirst.mockResolvedValue({ userAgent });
}

beforeEach(() => {
    vi.clearAllMocks();
    accountDevice.upsert.mockResolvedValue({});
    // Unless a test says otherwise, the account was opened from some other
    // machine - so the device under test is being judged on its own age.
    openedFrom(SAFARI);
});

describe("accountDeviceStanding", () => {
    it("settles everything for an account that asked for no wait", async () => {
        graceOf(0);
        const standing = await accountDeviceStanding("user-1", CHROME);
        expect(standing.settled).toBe(true);
        // And does not go looking for a device it would not have used.
        expect(accountDevice.findUnique).not.toHaveBeenCalled();
        expect(accountDevice.findFirst).not.toHaveBeenCalled();
    });

    it("holds a device that has not served the wait", async () => {
        graceOf(7);
        firstSeenDaysAgo(2);
        const standing = await accountDeviceStanding("user-1", CHROME);
        expect(standing.settled).toBe(false);
        expect(standing.graceDays).toBe(7);
        expect(standing.settlesAt?.getTime()).toBeGreaterThan(Date.now());
    });

    it("releases a device once the wait is behind it", async () => {
        graceOf(7);
        firstSeenDaysAgo(8);
        expect((await accountDeviceStanding("user-1", CHROME)).settled).toBe(true);
    });

    it("releases a device on the exact day its wait ends", async () => {
        graceOf(7);
        firstSeenDaysAgo(7);
        expect((await accountDeviceStanding("user-1", CHROME)).settled).toBe(true);
    });

    it("holds a session that never said what it was", async () => {
        graceOf(7);
        const standing = await accountDeviceStanding("user-1", null);
        expect(standing.settled).toBe(false);
        expect(standing.settlesAt).toBeNull();
        expect(accountDevice.findUnique).not.toHaveBeenCalled();
    });

    it("never holds the device the account was opened from", async () => {
        // The account was created here minutes ago and the wait turned on from
        // this very browser. Holding it would lock the owner out of Security on
        // their own first act, and there is no earlier device to protect.
        graceOf(7);
        openedFrom(CHROME);
        firstSeenDaysAgo(0);
        const standing = await accountDeviceStanding("user-1", CHROME);
        expect(standing.settled).toBe(true);
        // Nothing to count down to: it was never waiting.
        expect(standing.settlesAt).toBeNull();
        expect(standing.graceDays).toBe(7);
    });

    it("still holds the second device on an account opened minutes ago", async () => {
        // The exemption is for the one browser that opened the account, not for
        // every browser that turns up while the account is new - which is exactly
        // the window a freshly stolen password is used in.
        graceOf(7);
        openedFrom(SAFARI);
        firstSeenDaysAgo(0);
        expect((await accountDeviceStanding("user-1", CHROME)).settled).toBe(false);
    });

    it("does not treat a session older than the register as a new device", async () => {
        // Nothing wrote a row before this existed, and every sign-in since has.
        // Reading absence as "new" would hold every account the day it ships.
        graceOf(7);
        accountDevice.findUnique.mockResolvedValue(null);
        expect((await accountDeviceStanding("user-1", CHROME)).settled).toBe(true);
    });
});

describe("sessionDeviceStanding", () => {
    it("judges the device the session was opened with, not the request in hand", async () => {
        graceOf(7);
        firstSeenDaysAgo(1);
        session.findFirst.mockResolvedValue({ userAgent: "stale", state: { userAgent: CHROME } });

        expect((await sessionDeviceStanding("user-1", "session-1")).settled).toBe(false);
        // Polaris's own copy wins over better-auth's, which is written once and
        // never followed - and neither comes from the caller's headers.
        expect(accountDevice.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId_userAgent: { userId: "user-1", userAgent: CHROME } } })
        );
    });

    it("holds a session that is not there, when the account asked for a wait", async () => {
        graceOf(7);
        session.findFirst.mockResolvedValue(null);
        expect((await sessionDeviceStanding("user-1", "session-1")).settled).toBe(false);
    });
});

describe("rememberAccountDevice", () => {
    it("keeps the first sighting and only moves the last", async () => {
        // A device that could restart its own wait by signing in again would be
        // serving no wait at all.
        await rememberAccountDevice("user-1", { userAgent: CHROME, ip: "203.0.113.7" });
        const [args] = accountDevice.upsert.mock.calls[0] as [{ update: Record<string, unknown> }];
        expect(Object.keys(args.update)).toEqual(["lastSeenAt"]);
    });

    it("records nothing for a browser that said nothing", async () => {
        await rememberAccountDevice("user-1", { ip: "203.0.113.7" });
        expect(accountDevice.upsert).not.toHaveBeenCalled();
    });

    it("never fails the sign-in it runs inside", async () => {
        accountDevice.upsert.mockRejectedValue(new Error("database is down"));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await expect(rememberAccountDevice("user-1", { userAgent: CHROME })).resolves.toBeUndefined();
    });
});

describe("newDeviceWaitMessage", () => {
    it("says how much of the wait is left", async () => {
        graceOf(7);
        firstSeenDaysAgo(2);
        const message = newDeviceWaitMessage(await accountDeviceStanding("user-1", CHROME));
        expect(message).toContain("7 days");
        expect(message).toContain("5 days");
    });

    it("says nothing about a device that is free to act", async () => {
        graceOf(0);
        expect(newDeviceWaitMessage(await accountDeviceStanding("user-1", CHROME))).toBe("");
    });
});
