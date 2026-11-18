/**
 * How soon an app left open hears of a release.
 *
 * The report: a new version came out and the app said nothing until somebody
 * pressed "Check for updates" - it asked at start and then every six hours, and
 * a computer asleep runs no timers at all. It now asks every half hour, and
 * again on waking, unlocking or coming back to the app once ten minutes have
 * passed since it last asked.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, autoUpdater: {}, net: {}, powerMonitor: {} }));
vi.mock("@/main/mac-signature", () => ({ developerSigned: async () => false }));

const { AWAY_MS, EVERY_MS, dueAgain } = await import("@/main/updates");

describe("update cadence", () => {
    it("asks every half hour", () => {
        expect(EVERY_MS).toBe(30 * 60_000);
    });

    it("asks again on coming back only once ten minutes have passed", () => {
        const asked = 1_000_000;
        expect(dueAgain(asked, asked + AWAY_MS - 1)).toBe(false);
        expect(dueAgain(asked, asked + AWAY_MS)).toBe(true);
        expect(dueAgain(0, asked)).toBe(true);
    });
});
