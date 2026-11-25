/**
 * The app's icon is one for every Polaris the app shows: what each page may
 * hand over, and the icon the reports settle on.
 */

import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
    app: { on: vi.fn(), dock: { setIcon: vi.fn() } },
    BrowserWindow: { getAllWindows: () => [] },
    nativeImage: { createFromDataURL: vi.fn(), createFromPath: vi.fn() },
    Menu: {},
    Tray: vi.fn()
}));

const { appIconSchema, icoOf, iconFor, markSeasonFor, readStoredReports, reportOf, squirrelAppId, storedReports } = await import("../../src/main/app-icon");
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

describe("the icon from the last launch (BUG-0034)", () => {
    const official = reportOf("https://b.example.test", { png: WINTER_PNG, host: "x", calendar: DEFAULT_SEASON_CALENDAR, icons: { winter: WINTER_PNG } }, at)!;
    const old = reportOf("https://c.example.test", { png: OLD_PNG }, at)!;

    it("reads back what was written, so the first frame wears the season", () => {
        const restored = readStoredReports(storedReports([official, old], NOW));
        expect(restored).toHaveLength(2);
        expect(iconFor(restored, NOW)).toBe(WINTER_PNG);
        // A page from before calendars stays one after the round trip.
        expect(restored.find((report) => report.host === old.host)?.calendar).toBeUndefined();
    });

    it("writes nothing new for a host that reports again within the hour", () => {
        expect(storedReports([{ ...official, at: at + 1000 }], NOW)).toBe(storedReports([official], NOW));
    });

    it("does not keep a host not opened for weeks", () => {
        const stale = { ...official, at: at - 15 * 24 * 60 * 60_000 };
        expect(readStoredReports(storedReports([stale], NOW))).toEqual([]);
    });

    it("starts plain on a file that is missing, broken or not a report", () => {
        expect(readStoredReports(null)).toEqual([]);
        expect(readStoredReports("{not json")).toEqual([]);
        expect(readStoredReports(JSON.stringify({ reports: [{ host: "h", icons: {}, legacy: "javascript:alert(1)", at }] }))).toEqual([]);
        expect(readStoredReports(JSON.stringify({ reports: [{ host: "h", icons: { spring: WINTER_PNG }, legacy: null, at }] }))).toEqual([]);
    });
});

describe("markSeasonFor: the mark on the app's own screens", () => {
    it("is the shipped calendar's season before any host has reported", () => {
        expect(markSeasonFor([], NOW)).toBe("winter");
        expect(markSeasonFor([], GAP)).toBeNull();
        expect(markSeasonFor([reportOf("https://c.example.test", { png: OLD_PNG }, at)!], NOW)).toBe("winter");
    });

    it("follows the hosts once one has said, and stays plain where seasons were switched off", () => {
        const off = reportOf("https://d.example.test", { png: null, host: "x", calendar: null }, at)!;
        expect(markSeasonFor([off], NOW)).toBeNull();
        const custom = reportOf("https://a.example.test", { png: null, host: "x", calendar: longHalloween, icons: {} }, at)!;
        expect(markSeasonFor([custom], GAP)).toBe("halloween");
    });
});

describe("icoOf: the taskbar's .ico", () => {
    it("is a header, one entry per picture, and the PNGs at the offsets it names", () => {
        const pictures = [{ side: 16, png: Buffer.from("small") }, { side: 256, png: Buffer.from("large picture") }];
        const ico = icoOf(pictures);
        expect(ico.readUInt16LE(0)).toBe(0);
        expect(ico.readUInt16LE(2)).toBe(1);
        expect(ico.readUInt16LE(4)).toBe(2);
        pictures.forEach((picture, index) => {
            const entry = 6 + 16 * index;
            expect(ico.readUInt8(entry)).toBe(picture.side === 256 ? 0 : picture.side);
            expect(ico.readUInt16LE(entry + 6)).toBe(32);
            const size = ico.readUInt32LE(entry + 8);
            const offset = ico.readUInt32LE(entry + 12);
            expect(ico.subarray(offset, offset + size).equals(picture.png)).toBe(true);
        });
        expect(ico.length).toBe(6 + 32 + 5 + 13);
    });
});

describe("squirrelAppId", () => {
    const folder = join("Users", "someone", "AppData", "Local", "polaris");
    const exe = join(folder, "app-1.2.3", "polaris.exe");

    it("is the id Electron gives a Squirrel install, so the details reach the button the window has", () => {
        expect(squirrelAppId(exe, (path) => path === join(folder, "Update.exe"))).toBe("com.squirrel.polaris.polaris");
    });

    it("is null outside a Squirrel install", () => {
        expect(squirrelAppId(exe, () => false)).toBeNull();
    });
});

describe("the app's own pages", () => {
    const renderer = join(__dirname, "../../src/renderer");

    it("dress every Polaris mark they draw in the window's season", () => {
        const pages = readdirSync(renderer).filter((name) => name.endsWith(".html") && readFileSync(join(renderer, name), "utf8").includes('src="mark.svg"'));
        expect(pages).toContain("connect.html");
        for (const page of pages) {
            const script = readFileSync(join(renderer, page.replace(/\.html$/, ".ts")), "utf8");
            expect(script, page).toMatch(/dressMark\(window\.polarisLocal\.season\)/);
        }
    });
});
