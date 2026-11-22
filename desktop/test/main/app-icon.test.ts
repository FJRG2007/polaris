/**
 * The app's icon is one for every Polaris the app shows: what each page may
 * hand over, and the icon the reports settle on.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: { on: vi.fn(), dock: { setIcon: vi.fn() } },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromDataURL: vi.fn(), createFromPath: vi.fn() },
    Menu: {},
    Tray: vi.fn()
}));

const { appIconSchema, iconFor, reportOf } = await import("../../src/main/app-icon");
const { DEFAULT_SEASON_CALENDAR } = await import("../../../dashboard/packages/core/src/seasons");

const WINTER_PNG = "data:image/png;base64,V0lOVEVS";
const HALLOWEEN_PNG = "data:image/png;base64,SEFMTE9XRUVO";
const OLD_PNG = "data:image/png;base64,T0xE";
const NOW = new Date(2026, 10, 22, 12);
const GAP = new Date(2026, 10, 10, 12);
const at = NOW.getTime();

const longHalloween = {
    ...DEFAULT_SEASON_CALENDAR,
    halloween: { enabled: true, window: { from: { month: 11, day: 3 }, to: { month: 11, day: 30 } } },
    winter: { enabled: true, window: { from: { month: 12, day: 1 }, to: { month: 1, day: 9 } } }
};

describe("appIconSchema", () => {
    it("takes a page from before calendars, and one that reports its host", () => {
        expect(appIconSchema.safeParse({ png: OLD_PNG }).success).toBe(true);
        expect(
            appIconSchema.safeParse({
                png: WINTER_PNG,
                host: "https://a.example.test",
                calendar: DEFAULT_SEASON_CALENDAR,
                icons: { winter: WINTER_PNG }
            }).success
        ).toBe(true);
        expect(appIconSchema.safeParse({ png: null, host: "https://a.example.test", calendar: null }).success).toBe(true);
    });

    it("refuses a malformed calendar, an unknown season and a picture that is not a PNG", () => {
        expect(appIconSchema.safeParse({ png: null, host: "h", calendar: { winter: {} } }).success).toBe(false);
        expect(appIconSchema.safeParse({ png: null, host: "h", icons: { spring: WINTER_PNG } }).success).toBe(false);
        expect(appIconSchema.safeParse({ png: "javascript:alert(1)" }).success).toBe(false);
    });
});

describe("iconFor", () => {
    const official = reportOf("https://b.example.test", { png: WINTER_PNG, host: "x", calendar: DEFAULT_SEASON_CALENDAR, icons: { winter: WINTER_PNG } }, at)!;
    const custom = reportOf(
        "https://a.example.test",
        { png: WINTER_PNG, host: "x", calendar: longHalloween, icons: { winter: WINTER_PNG, halloween: HALLOWEEN_PNG } },
        at
    )!;

    it("wears the official season over another host's custom one, whichever spoke last", () => {
        expect(iconFor([official, custom], NOW)).toBe(WINTER_PNG);
        expect(iconFor([custom, official], NOW)).toBe(WINTER_PNG);
    });

    it("keeps a stable host order between custom seasons", () => {
        const a = reportOf("https://a.example.test", { png: null, host: "x", calendar: { ...DEFAULT_SEASON_CALENDAR, halloween: { enabled: true, window: { from: { month: 11, day: 3 }, to: { month: 11, day: 14 } } } }, icons: { halloween: HALLOWEEN_PNG } }, at)!;
        const b = reportOf("https://b.example.test", { png: null, host: "x", calendar: { ...DEFAULT_SEASON_CALENDAR, winter: { enabled: true, window: { from: { month: 11, day: 5 }, to: { month: 1, day: 9 } } } }, icons: { winter: WINTER_PNG } }, at)!;
        expect(iconFor([b, a], GAP)).toBe(HALLOWEEN_PNG);
        expect(iconFor([a, b], GAP)).toBe(HALLOWEEN_PNG);
    });

    it("wears an old page's picture only while no host reports a calendar", () => {
        const old = reportOf("https://c.example.test", { png: OLD_PNG }, at)!;
        expect(iconFor([old], NOW)).toBe(OLD_PNG);
        expect(iconFor([old, official], NOW)).toBe(WINTER_PNG);
        const off = reportOf("https://d.example.test", { png: null, host: "x", calendar: null }, at)!;
        expect(iconFor([old, off], NOW)).toBeNull();
    });

    it("is the shipped icon with no reports, and forgets a host not opened for weeks", () => {
        expect(iconFor([], NOW)).toBeNull();
        const stale = { ...official, at: at - 15 * 24 * 60 * 60_000 };
        expect(iconFor([stale], NOW)).toBeNull();
    });

    it("keeps a host's last word when its page goes away", () => {
        expect(reportOf("https://a.example.test", { png: null, host: "x" }, at)).toBeNull();
    });
});
