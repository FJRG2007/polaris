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
 * What the hosts last said is kept in the app's data folder, so a launch wears
 * the season from its first frame instead of the plain mark until a page of the
 * dashboard has loaded - which the splash, the address form and a sign-in page
 * never do (BUG-0034). On Windows the settled icon is also written there as an
 * .ico, the file the taskbar button and the notification area read.
 *
 * A host whose page never reports - one from before pages did, or a window
 * left on a sign-in page - is still read: the app asks the host which icon it
 * serves (`served-icon.ts`) and wears that while no host reports a calendar.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { app, BrowserWindow, nativeImage, type NativeImage } from "electron";
import { appIconSeason, officialSeasonOn } from "../../../../dashboard/packages/core/src/app-icon-season";
import { SEASONS, type Season, type SeasonCalendar } from "../../../../dashboard/packages/core/src/seasons";
import { setTrayImage } from "./tray";
import { syncShortcutIcons } from "./shortcut-icon";
import { fetchServedIcon } from "./served-icon";

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
    /** The season the host's own icons were found in, when the app read them
     *  itself rather than a page reporting (`reportServedIcon`). */
    readonly served?: Season;
    readonly at: number;
}

/** The reports as they are kept on disk. A file that does not read as this is
 *  ignored, and the next report writes a good one over it. */
const storedSchema = z
    .object({
        reports: z
            .array(
                z
                    .object({
                        host: z.string().max(512),
                        // JSON has no undefined: a page from before calendars is stored without one.
                        calendar: calendarSchema.nullable().optional(),
                        icons: z.partialRecord(z.enum(SEASONS), png),
                        legacy: png.nullable(),
                        served: z.enum(SEASONS).optional(),
                        at: z.number().int().nonnegative()
                    })
                    .strict()
            )
            .max(64)
    })
    .strict();

/**
 * Each host's last report, by origin, kept after its window moves to another
 * Polaris: the app shows one host at a time, and forgetting the others on every
 * switch is exactly what made the icon change with the host on screen.
 */
const reports = new Map<string, Report>();
/** What is up now, so a repeat of it is not applied again. */
let shown: string | null | undefined;
let recheck: NodeJS.Timeout | null = null;
/** What was last written to disk, so an unchanged report is not written again. */
let written: string | null = null;

/** How often the date is looked at again, for a season that starts overnight. */
const RECHECK_MS = 30 * 60_000;
/** A host not opened for this long no longer has a say. */
const STALE_MS = 14 * 24 * 60 * 60_000;

function fresh(all: readonly Report[], now: Date): Report[] {
    return all
        .filter((report) => now.getTime() - report.at <= STALE_MS)
        .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** The first host, in the stable order, whose own icons were read in a season. */
function servedBy(ordered: readonly Report[]): (Report & { readonly served: Season; }) | null {
    const found = ordered.find((report) => report.served && report.icons[report.served]);
    return found?.served ? { ...found, served: found.served } : null;
}

/**
 * The PNG every window wears for these reports on `now`: the settled season's
 * mark from whichever host drew it, or - only while no host reports a calendar
 * - the dressed icon a host serves, then what a page from before calendars
 * asked for. Null is the shipped icon. Pure.
 */
export function iconFor(all: readonly Report[], now: Date): string | null {
    const ordered = fresh(all, now);
    const season = appIconSeason(ordered, now);
    if (season) return ordered.find((report) => report.icons[season])?.icons[season] ?? null;
    if (ordered.some((report) => report.calendar !== undefined)) return null;
    const served = servedBy(ordered);
    if (served) return served.icons[served.served] ?? null;
    return ordered.find((report) => report.legacy)?.legacy ?? null;
}

/**
 * The season the app's own screens draw the mark in (the splash, the address
 * form): the one the icon settles on, or - before any host has said what its
 * calendar is - the calendar Polaris ships with. A host that turned seasons
 * off keeps them plain. Pure.
 */
export function markSeasonFor(all: readonly Report[], now: Date): Season | null {
    const ordered = fresh(all, now);
    if (!ordered.some((report) => report.calendar !== undefined)) return servedBy(ordered)?.served ?? officialSeasonOn(now);
    return appIconSeason(ordered, now);
}

/** The season the app's own screens draw the mark in now. */
export function markSeason(): Season | null {
    return markSeasonFor([...reports.values()], new Date());
}

/** What one page said, as the report it stands for; null for a page going away,
 *  which leaves its host's last word in place. */
export function reportOf(origin: string, icon: AppIcon, at: number): Report | null {
    if (!("host" in icon)) return { host: origin, calendar: undefined, icons: {}, legacy: icon.png, at };
    if (icon.calendar === undefined) return null;
    return { host: origin, calendar: icon.calendar, icons: icon.icons ?? {}, legacy: null, at };
}

/**
 * What the app read of a host's own icons, as the report it stands for; null
 * where it changes nothing. A host whose page reported a calendar keeps that
 * report: the page knows its operator's dates, the manifest only today's. A
 * host serving the plain icon clears what was read of it before. Pure.
 */
export function servedReportOf(
    origin: string,
    existing: Report | undefined,
    served: { readonly season: Season; readonly png: string; } | null,
    at: number
): Report | null {
    if (existing && existing.calendar !== undefined) return null;
    if (!served) return existing?.served ? { ...existing, icons: {}, served: undefined, at } : null;
    return { host: origin, calendar: undefined, icons: { [served.season]: served.png }, legacy: existing?.legacy ?? null, served: served.season, at };
}

/** The reports a stored file holds; none for a file that is missing or does not read. Pure. */
export function readStoredReports(raw: string | null): Report[] {
    if (!raw) return [];
    try {
        const parsed = storedSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return [];
        return parsed.data.reports.map((report) => ({ ...report, calendar: report.calendar, served: report.served }));
    } catch {
        return [];
    }
}

/** The reports as a file, without the hosts that no longer have a say. When a
 *  host last spoke is kept to the hour, so a page that reports again and again
 *  says nothing new and is not written each time. Pure. */
export function storedReports(all: readonly Report[], now: Date): string {
    const hour = 60 * 60_000;
    const kept = fresh(all, now).slice(0, 64).map((report) => ({ ...report, at: Math.floor(report.at / hour) * hour }));
    return JSON.stringify({ reports: kept });
}

function storeFile(): string {
    return join(app.getPath("userData"), "app-icon.json");
}

/** Written beside the file and renamed over it: a crash mid-write keeps the last one. */
function writeAtomic(file: string, data: string | Buffer): void {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, data);
    renameSync(temp, file);
}

function persist(): void {
    const next = storedReports([...reports.values()], new Date());
    if (next === written) return;
    try {
        writeAtomic(storeFile(), next);
        written = next;
    } catch {
        // Only the next launch's first frame depends on it.
    }
}

function watch(): void {
    if (recheck) return;
    recheck = setInterval(settle, RECHECK_MS);
    recheck.unref?.();
    // A window opened later wears what the others do.
    app.on("browser-window-created", (_event, window) => {
        if (shown) applyAppIcon(window, { png: shown });
    });
}

/**
 * Put back what the hosts said last time, before the first window opens, so
 * it opens in the season's dress. Call once the app is ready.
 */
export function restoreAppIcon(): void {
    let raw: string | null = null;
    try {
        raw = readFileSync(storeFile(), "utf8");
    } catch {
        // A first launch, or a folder that cannot be read: the shipped icon.
    }
    for (const report of readStoredReports(raw)) if (!reports.has(report.host)) reports.set(report.host, report);
    written = raw;
    watch();
    settle();
}

/**
 * Take what a page said and put up the icon every window settles on. The host
 * is the page's origin as the app sees it, not what the page claims.
 */
export function reportAppIcon(origin: string, icon: AppIcon): void {
    const report = reportOf(origin, icon, Date.now());
    if (report) reports.set(origin, report);
    watch();
    settle();
    persist();
}

/**
 * Ask a host which icon it serves and wear it while no page of it reports a
 * calendar. A host that cannot be reached, or answers with something that is
 * not its manifest, changes nothing.
 */
export async function learnServedIcon(fetcher: (url: string, init: RequestInit) => Promise<Response>, origin: string): Promise<void> {
    const served = await fetchServedIcon(fetcher, origin);
    if (served === undefined) return;
    let png: string | null = null;
    if (served) {
        const image = nativeImage.createFromBuffer(served.png);
        if (image.isEmpty()) return;
        const dataUrl = image.resize({ width: 256, height: 256, quality: "best" }).toDataURL();
        if (!appIconSchema.shape.png.safeParse(dataUrl).success) return;
        png = dataUrl;
    }
    const report = servedReportOf(origin, reports.get(origin), served && png ? { season: served.season, png } : null, Date.now());
    if (!report) return;
    reports.set(origin, report);
    watch();
    settle();
    persist();
}

function settle(): void {
    const next = iconFor([...reports.values()], new Date());
    if (next === shown) return;
    shown = next;
    for (const window of BrowserWindow.getAllWindows()) applyAppIcon(window, { png: next });
    if (BrowserWindow.getAllWindows().length === 0) applyAppIcon(null, { png: next });
}

/** The settled icon, decoded once per picture. */
let dressed: { readonly png: string; readonly image: NativeImage; } | null = null;

/** The mark in the season's dress while the app icon wears it, else null. */
export function dressedMark(): NativeImage | null {
    if (!shown) return null;
    if (dressed?.png !== shown) dressed = { png: shown, image: nativeImage.createFromDataURL(shown) };
    return dressed.image.isEmpty() ? null : dressed.image;
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

/** The sizes the Windows shell asks an .ico for, at every display scale. */
export const ICO_SIDES = [16, 24, 32, 48, 64, 256] as const;

/**
 * An .ico holding each PNG as is, which Windows reads since Vista. A side of
 * 256 is written as 0, as the format has it. Pure.
 */
export function icoOf(images: readonly { readonly side: number; readonly png: Buffer; }[]): Buffer {
    const header = Buffer.alloc(6 + 16 * images.length);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(images.length, 4);
    let offset = header.length;
    images.forEach((image, index) => {
        const entry = 6 + 16 * index;
        const side = image.side >= 256 ? 0 : image.side;
        header.writeUInt8(side, entry);
        header.writeUInt8(side, entry + 1);
        header.writeUInt8(0, entry + 2);
        header.writeUInt8(0, entry + 3);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(image.png.length, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += image.png.length;
    });
    return Buffer.concat([header, ...images.map((image) => image.png)]);
}

/**
 * The app user model id Electron gives a Squirrel install
 * (`<package>/app-<version>/<exe>` beside `<package>/Update.exe`):
 * `com.squirrel.<package>.<exe>`, as `shell/browser/app_package.cc` derives
 * it, so the taskbar details set here belong to the button the window already
 * has. Null when the app is not a Squirrel install. Pure but for `exists`.
 */
export function squirrelAppId(execPath: string, exists: (path: string) => boolean): string | null {
    const folder = dirname(dirname(execPath));
    if (!exists(join(folder, "Update.exe"))) return null;
    const exe = basename(execPath).replace(/\.exe$/i, "");
    const strip = (value: string) => value.replace(/\s+/g, "");
    return `com.squirrel.${strip(basename(folder))}.${strip(exe)}`;
}

/** What the taskbar button is told about the app, or null where it is not told. */
function taskbarDetails(icon: string): Electron.AppDetailsOptions | null {
    if (process.platform !== "win32") return null;
    const appId = app.isPackaged ? squirrelAppId(process.execPath, existsSync) : process.execPath;
    if (!appId) return null;
    // A Squirrel install starts from the stub beside Update.exe, as its shortcuts do.
    const stub = join(dirname(dirname(process.execPath)), basename(process.execPath));
    const command = app.isPackaged && existsSync(stub) ? stub : process.execPath;
    return {
        appId,
        appIconPath: icon,
        appIconIndex: 0,
        relaunchCommand: `"${command}"`,
        relaunchDisplayName: app.getName()
    };
}

/**
 * The icon as a file the Windows shell can read, at one path that is rewritten
 * every season - so a button pinned in December is plain again in February -
 * or null when it could not be written.
 */
function writeTaskbarIcon(image: NativeImage | null): string | null {
    try {
        const file = join(app.getPath("userData"), "taskbar-icon.ico");
        const data = image
            ? icoOf(ICO_SIDES.map((side) => ({ side, png: image.resize({ width: side, height: side, quality: "best" }).toPNG() })))
            : readFileSync(join(__dirname, "..", "icon.ico"));
        writeAtomic(file, data);
        return file;
    } catch {
        return null;
    }
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

/** The .ico last written, and for which picture, so every window shares one write. */
let ico: { readonly png: string | null; readonly file: string | null; } | null = null;

function setIcons(window: BrowserWindow | null, icon: AppIcon): void {
    const drawn = icon.png ? nativeImage.createFromDataURL(icon.png) : null;
    const image = drawn && !drawn.isEmpty() ? drawn : null;
    if (process.platform === "darwin") {
        // The Dock is the Mac's only icon here: the window carries none.
        if (image) app.dock?.setIcon(onAppleGrid(image));
        else app.dock?.setIcon(shipped());
        return;
    }
    if (process.platform === "win32") {
        const key = image ? icon.png! : null;
        if (!ico || ico.png !== key) {
            ico = { png: key, file: writeTaskbarIcon(image) };
            // The button of a window that carries the app's id is drawn from the
            // shortcut that carries it, so the shortcuts wear the season too.
            syncShortcutIcons(image ? ico.file : null);
        }
    }
    const file = process.platform === "win32" ? ico?.file ?? null : null;
    if (window && !window.isDestroyed()) {
        window.setIcon(image ?? shipped());
        const details = file ? taskbarDetails(file) : null;
        if (details) window.setAppDetails(details);
    }
    setTrayImage(image, file);
}
