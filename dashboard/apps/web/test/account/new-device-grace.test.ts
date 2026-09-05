/**
 * The wait a browser serves before it can change what protects an account.
 *
 * It exists for the hours after a password is taken: whoever has it signs in and
 * the first thing worth doing is shutting the owner out - the recovery address,
 * the questions, the sessions that would have noticed. Making a device the
 * account has never seen wait leaves those doors open.
 *
 * The case that brought this test into being is the opposite one. A browser
 * writes a new version into its user-agent every few weeks on its own, and the
 * register keyed on that raw string - so the owner, on the machine they had used
 * all year, was told their device was new, and told it again after the next
 * update. A gate that only ever fires on the person it is protecting is not a
 * gate; the wait is served once by the device, not once by each version of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHROME_131 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
const CHROME_132 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.6834.83 Safari/537.36";
const FIREFOX_ON_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);

/** What the account asks a new device to wait. */
let graceDays = 7;
/** The register, oldest first - which is also how the founding device is read. */
let devices: { userAgent: string; firstSeenAt: Date }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        userSecurity: { findUnique: async () => ({ newDeviceGraceDays: graceDays }) },
        accountDevice: {
            findMany: async () => devices,
            findFirst: async () => devices[0] ?? null
        }
    }
}));

const { accountDeviceStanding } = await import("@polaris/auth");

beforeEach(() => {
    vi.clearAllMocks();
    graceDays = 7;
    devices = [];
});

describe("a browser that has updated itself", () => {
    it("keeps the standing the device already had", () => {
        // The whole bug: an account whose oldest device is this same browser,
        // now one version later, was being told it was new.
        devices = [{ userAgent: CHROME_131, firstSeenAt: ago(300) }];
        return expect(accountDeviceStanding("ada", CHROME_132)).resolves.toMatchObject({ settled: true });
    });

    it("is dated from the first time the device was seen, not the first time this version was", async () => {
        devices = [
            { userAgent: FIREFOX_ON_MAC, firstSeenAt: ago(400) },
            { userAgent: CHROME_131, firstSeenAt: ago(30) },
            { userAgent: CHROME_132, firstSeenAt: ago(1) }
        ];
        const standing = await accountDeviceStanding("ada", CHROME_132);
        expect(standing.settled).toBe(true);
        expect(standing.firstSeenAt?.getTime()).toBe(devices[1]!.firstSeenAt.getTime());
    });
});

describe("a device the account really has not seen", () => {
    it("serves the wait", async () => {
        devices = [
            { userAgent: FIREFOX_ON_MAC, firstSeenAt: ago(400) },
            { userAgent: CHROME_131, firstSeenAt: ago(2) }
        ];
        const standing = await accountDeviceStanding("ada", CHROME_131);
        expect(standing.settled).toBe(false);
        expect(standing.graceDays).toBe(7);
    });

    it("is let through once the wait is over", async () => {
        devices = [
            { userAgent: FIREFOX_ON_MAC, firstSeenAt: ago(400) },
            { userAgent: CHROME_131, firstSeenAt: ago(9) }
        ];
        expect((await accountDeviceStanding("ada", CHROME_131)).settled).toBe(true);
    });
});

describe("the browser the account was opened from", () => {
    it("never waits, however new the account is", async () => {
        // Turning the setting on and being locked out of Security by your own
        // first act is not a protection anybody asked for.
        devices = [{ userAgent: CHROME_131, firstSeenAt: ago(0) }];
        expect((await accountDeviceStanding("ada", CHROME_131)).settled).toBe(true);
    });

    it("is still recognised after it updates", async () => {
        devices = [{ userAgent: CHROME_131, firstSeenAt: ago(0) }];
        expect((await accountDeviceStanding("ada", CHROME_132)).settled).toBe(true);
    });
});

describe("what the wait does not depend on", () => {
    it("lets everybody through when the account asks for no wait", async () => {
        graceDays = 0;
        devices = [{ userAgent: FIREFOX_ON_MAC, firstSeenAt: ago(400) }];
        expect((await accountDeviceStanding("ada", CHROME_131)).settled).toBe(true);
    });

    it("refuses a session that did not say what it is", async () => {
        // "We could not tell" is not evidence that the device has served
        // anything, and the account asked for this wait.
        devices = [{ userAgent: CHROME_131, firstSeenAt: ago(400) }];
        expect((await accountDeviceStanding("ada", null)).settled).toBe(false);
    });

    it("lets through a session older than the register itself", async () => {
        // An account that predates the register has no rows, and a session that
        // predates it is not a new device.
        devices = [];
        expect((await accountDeviceStanding("ada", CHROME_131)).settled).toBe(true);
    });
});
