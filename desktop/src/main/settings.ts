/**
 * What this app remembers between runs: the Polaris it opens, the other ones it
 * has opened (`shared/servers`), and for each service pushed from here the
 * folder and platform used last time.
 *
 * A JSON file in the app's own data folder. It holds nothing secret - the API
 * key lives in `api-key-store`, encrypted by the operating system - and it is
 * read through a schema, so a file a newer or older build wrote, or one edited
 * by hand, falls back to defaults instead of breaking the app.
 */

import { z } from "zod";
import { app } from "electron";
import { join } from "node:path";
import { readServerAddress } from "@/shared/server-address";
import type { WindowPlace } from "@/shared/window-place";
import { readServers, withServer, type SavedServer } from "@/shared/servers";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** A platform `docker build --platform` takes, or "" for this computer's own. */
export const PUSH_PLATFORMS = ["", "linux/amd64", "linux/arm64"] as const;

export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

const pushSchema = z.object({
    folder: z.string().max(4096),
    platform: z.enum(PUSH_PLATFORMS).catch("")
});

export type PushChoice = z.infer<typeof pushSchema>;

const placeSchema = z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    maximized: z.boolean()
});

const settingsSchema = z.object({
    server: z.unknown().transform(readServerAddress).catch(null),
    servers: z.unknown().transform(readServers).catch([]),
    pushes: z.record(z.string().uuid(), pushSchema).catch({}),
    updateAttempted: z.string().max(64).nullable().catch(null),
    windowPlace: placeSchema.nullable().catch(null),
    // On unless somebody turned it off, which reaches installs from before it existed.
    openAtLogin: z.boolean().catch(true),
    // On unless somebody turned it off: a file without it, or with anything but a
    // boolean, keeps the graphics card in use.
    hardwareAcceleration: z.boolean().catch(true),
    // On unless somebody turned it off: closing the window keeps Polaris in the
    // tray, so calls and notifications carry on.
    minimizeToTray: z.boolean().catch(true),
    // Off unless somebody turned it on: opened with the computer, it stays in
    // the tray instead of putting a window in front of everything.
    startMinimized: z.boolean().catch(false),
    // On unless somebody turned it off: the call's people over every window
    // while a call is on.
    voiceWidget: z.boolean().catch(true),
    // Off unless somebody turned it on: the widget only while a game runs.
    voiceWidgetGameOnly: z.boolean().catch(false),
    // Where the widget was dragged to, or null for its corner.
    voiceWidgetPlace: z.object({ x: z.number().int(), y: z.number().int() }).nullable().catch(null)
});

type Settings = z.infer<typeof settingsSchema>;

const EMPTY: Settings = {
    server: null,
    servers: [],
    pushes: {},
    updateAttempted: null,
    windowPlace: null,
    openAtLogin: true,
    hardwareAcceleration: true,
    minimizeToTray: true,
    startMinimized: false,
    voiceWidget: true,
    voiceWidgetGameOnly: false,
    voiceWidgetPlace: null
};

function file(): string {
    return join(app.getPath("userData"), "settings.json");
}

function load(): Settings {
    try {
        const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file(), "utf8")));
        return parsed.success ? parsed.data : { ...EMPTY };
    } catch {
        return { ...EMPTY };
    }
}

/** Written beside the file and renamed over it, so a crash mid-write leaves the
 *  previous settings rather than an empty file. */
function save(settings: Settings): void {
    const temp = `${file()}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(settings, null, 4), { mode: 0o600 });
    renameSync(temp, file());
}

/** The Polaris this app opens, or null before the first run has asked. */
export function serverAddress(): string | null {
    return load().server;
}

/** Open this server from now on, and keep it in the list. */
export function setServerAddress(origin: string | null): void {
    const settings = load();
    save({ ...settings, server: origin, servers: origin ? withServer(knownServers(settings), origin) : settings.servers });
}

/**
 * Every server this app has opened, the one in use included. A settings file
 * written before the list existed has only the one address, which becomes the
 * list's first entry.
 */
export function savedServers(): SavedServer[] {
    return knownServers(load());
}

function knownServers(settings: Settings): SavedServer[] {
    return settings.server ? withServer(settings.servers, settings.server) : settings.servers;
}

/** Replace the list. The server in use stays in it whatever the list says. */
export function setSavedServers(servers: readonly SavedServer[]): void {
    const settings = load();
    save({ ...settings, servers: knownServers({ ...settings, servers: [...servers] }) });
}

/** The version a start last held the app back for, whether or not it took. */
export function updateAttempted(): string | null {
    return load().updateAttempted;
}

export function setUpdateAttempted(version: string): void {
    save({ ...load(), updateAttempted: version });
}

/** Where the main window was when it last moved. */
export function windowPlace(): WindowPlace | null {
    return load().windowPlace;
}

export function setWindowPlace(place: WindowPlace): void {
    save({ ...load(), windowPlace: place });
}

export function openAtLogin(): boolean {
    return load().openAtLogin;
}

export function rememberOpenAtLogin(open: boolean): void {
    save({ ...load(), openAtLogin: open });
}

/**
 * Whether Chromium may use the graphics card. Read once at start, before the app
 * is ready, since that is the only moment Electron takes it.
 */
export function hardwareAcceleration(): boolean {
    return load().hardwareAcceleration;
}

export function rememberHardwareAcceleration(on: boolean): void {
    save({ ...load(), hardwareAcceleration: on });
}

/** The switches kept as they are and read when they matter. */
export const TOGGLES = ["minimizeToTray", "startMinimized", "voiceWidget", "voiceWidgetGameOnly"] as const;

export type Toggle = (typeof TOGGLES)[number];

export function toggle(name: Toggle): boolean {
    return load()[name];
}

export function rememberToggle(name: Toggle, on: boolean): void {
    save({ ...load(), [name]: on });
}

/** Where the voice widget was dragged to, or null for its corner. */
export function voiceWidgetPlace(): { x: number; y: number } | null {
    return load().voiceWidgetPlace;
}

export function rememberVoiceWidgetPlace(place: { x: number; y: number }): void {
    save({ ...load(), voiceWidgetPlace: place });
}

/** What was used the last time this service was pushed from here. */
export function pushChoice(serviceId: string): PushChoice | null {
    return load().pushes[serviceId] ?? null;
}

export function rememberPushChoice(serviceId: string, choice: PushChoice): void {
    const settings = load();
    save({ ...settings, pushes: { ...settings.pushes, [serviceId]: choice } });
}
