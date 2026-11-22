/**
 * The app's icon in the season's dress: the window and taskbar button, the
 * notification-area icon and the Dock, the way Discord dresses its icon for a
 * holiday.
 *
 * The icon is one, and the app may show several Polaris hosts, each with its
 * own calendar. Wearing whatever the last page sent made the icon take turns
 * between hosts, so each page now reports its host's calendar and the dressed
 * marks it may need, and the season is settled across every window by one rule
 * (`appIconSeason` in core): Polaris's own calendar first, then a host's own
 * dates in a stable order. A page from before that sends only `{ png }`; it is
 * worn only while no host reports a calendar.
 *
 * Nothing is installed or written to disk, so it needs no reinstall and a new
 * season is one message away.
 */

import { join } from "node:path";
import { z } from "zod";
import { app, BrowserWindow, nativeImage, type NativeImage } from "electron";
import { appIconSeason } from "../../../dashboard/packages/core/src/app-icon-season";
import { SEASONS, type Season, type SeasonCalendar } from "../../../dashboard/packages/core/src/seasons";
import { setTrayImage } from "./tray";

/** A PNG drawn by the page: 256 pixels square. */
const PNG = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const MAX_PNG = 512 * 1024;
const png = z.string().max(MAX_PNG).regex(PNG);

const monthDay = z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict();
const rule = z.object({ enabled: z.boolean(), window: z.object({ from: monthDay, to: monthDay }).strict() }).strict();
const calendarSchema = z
    .object({ halloween: rule, winter: rule, newYear: rule, lunarNewYear: rule })
    .strict() satisfies z.ZodType<SeasonCalendar>;

export const appIconSchema = z
    .object({
        png: png.nullable(),
        host: z.string().max(512).optional(),
        calendar: calendarSchema.nullable().optional(),
        icons: z.partialRecord(z.enum(SEASONS), png).optional()
    })
    .strict();

export type AppIcon = z.infer<typeof appIconSchema>;

/** What one host's page last said. */
export interface Report {
    readonly host: string;
    /** Undefined for a page that predates reporting a calendar. */
    readonly calendar: SeasonCalendar | null | undefined;
    readonly icons: Partial<Record<Season, string>>;
    /** What a page that predates calendars asked for. */
    readonly legacy: string | null;
    readonly at: number;
}

/**
 * Each host's last report, by origin, kept after its window moves to another
 * Polaris: the app shows one host at a time, and forgetting the others on every
 * switch is exactly what made the icon change with the host on screen.
 */
const reports = new Map<string, Report>();
/** What is up now, so a repeat of it is not applied again. */
let shown: string | null | undefined;
let recheck: NodeJS.Timeout | null = null;

/** How often the date is looked at again, for a season that starts overnight. */
const RECHECK_MS = 30 * 60_000;
/** A host not opened for this long no longer has a say. */
const STALE_MS = 14 * 24 * 60 * 60_000;

/**
 * The PNG every window wears for these reports on `now`: the settled season's
 * mark from whichever host drew it, or - only while no host reports a calendar
 * - what a page from before that asked for. Null is the shipped icon. Pure.
 */
export function iconFor(all: readonly Report[], now: Date): string | null {
    const ordered = all
        .filter((report) => now.getTime() - report.at <= STALE_MS)
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
    const season = appIconSeason(ordered, now);
    if (season) return ordered.find((report) => report.icons[season])?.icons[season] ?? null;
    if (ordered.some((report) => report.calendar !== undefined)) return null;
    return ordered.find((report) => report.legacy)?.legacy ?? null;
}

/** What one page said, as the report it stands for; null for a page going away,
 *  which leaves its host's last word in place. */
export function reportOf(origin: string, icon: AppIcon, at: number): Report | null {
    if (!("host" in icon)) return { host: origin, calendar: undefined, icons: {}, legacy: icon.png, at };
    if (icon.calendar === undefined) return null;
    return { host: origin, calendar: icon.calendar, icons: icon.icons ?? {}, legacy: null, at };
}

/**
 * Take what a page said and put up the icon every window settles on. The host
 * is the page's origin as the app sees it, not what the page claims.
 */
export function reportAppIcon(origin: string, icon: AppIcon): void {
    const report = reportOf(origin, icon, Date.now());
    if (report) reports.set(origin, report);
    if (!recheck) {
        recheck = setInterval(settle, RECHECK_MS);
        recheck.unref?.();
        // A window opened later wears what the others do.
        app.on("browser-window-created", (_event, window) => {
            if (shown) applyAppIcon(window, { png: shown });
        });
    }
    settle();
}

function settle(): void {
    const next = iconFor([...reports.values()], new Date());
    if (next === shown) return;
    shown = next;
    for (const window of BrowserWindow.getAllWindows()) applyAppIcon(window, { png: next });
    if (BrowserWindow.getAllWindows().length === 0) applyAppIcon(null, { png: next });
}

/** The icon the app ships with, the one a null puts back. */
function shipped(): NativeImage {
    const file = process.platform === "win32" ? "icon.ico" : "icon.png";
    return nativeImage.createFromPath(join(__dirname, "..", file));
}

/**
 * The square mark inside Apple's icon grid (an 824 body on a 1024 canvas), so
 * it is the size of its neighbours in the Dock - as `build/icons.cjs` draws the
 * shipped one.
 */
function onAppleGrid(image: NativeImage): NativeImage {
    const { width, height } = image.getSize();
    const side = Math.round((width * 1024) / 824);
    const inset = Math.round((side - width) / 2);
    const source = image.toBitmap();
    const target = Buffer.alloc(side * side * 4);
    for (let y = 0; y < height; y += 1) {
        source.copy(target, ((y + inset) * side + inset) * 4, y * width * 4, (y + 1) * width * 4);
    }
    return nativeImage.createFromBitmap(target, { width: side, height: side });
}

/** Set the dressed icon; anything that goes wrong leaves the shipped one. */
export function applyAppIcon(window: BrowserWindow | null, icon: AppIcon): void {
    try {
        setIcons(window, icon);
    } catch {
        try {
            setIcons(window, { png: null });
        } catch {
            // The shipped icon is what was already up.
        }
    }
}

function setIcons(window: BrowserWindow | null, icon: AppIcon): void {
    const drawn = icon.png ? nativeImage.createFromDataURL(icon.png) : null;
    const image = drawn && !drawn.isEmpty() ? drawn : null;
    if (process.platform === "darwin") {
        // The Dock is the Mac's only icon here: the window carries none.
        if (image) app.dock?.setIcon(onAppleGrid(image));
        else app.dock?.setIcon(shipped());
        return;
    }
    if (window && !window.isDestroyed()) window.setIcon(image ?? shipped());
    setTrayImage(image);
}
