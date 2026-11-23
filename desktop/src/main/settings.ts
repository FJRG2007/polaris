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
import { DEFAULT_TEXT_SIZE, readTextSize, type TextSize } from "@/shared/text-size";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_LAUNCHER_BINDING } from "@/shared/launcher-hotkey";
import { SEARCH_ENGINE_IDS, type SearchEngine } from "@/shared/launcher";
import { CLIPBOARD_KEEP_IDS, DEFAULT_CLIPBOARD_KEEP, clipboardOn, type ClipboardKeep } from "@/shared/clipboard-store";

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
    // On unless somebody turned it off: opened with the computer, it stays in
    // the tray and says so once, instead of putting a window in front of
    // everything. A file that has the key keeps what it says.
    startMinimized: z.boolean().catch(true),
    // On unless somebody turned it off: the call's people over every window
    // while a call is on.
    voiceWidget: z.boolean().catch(true),
    // Off unless somebody turned it on: the widget only while a game runs.
    voiceWidgetGameOnly: z.boolean().catch(false),
    // On unless somebody turned it off: the launcher's key goes to the game
    // while one, or anything full screen, is in front.
    launcherGameMode: z.boolean().catch(true),
    // Where the widget was dragged to, or null for its corner.
    voiceWidgetPlace: z.object({ x: z.number().int(), y: z.number().int() }).nullable().catch(null),
    // The account's text size last seen in the Polaris window, or null before one was.
    textSize: z.unknown().transform(readTextSize).catch(null),
    // On unless somebody turned it off: the launcher opens with its key from anywhere.
    launcher: z.boolean().catch(true),
    // The launcher's key in the dashboard's spelling; a file without one uses the default.
    launcherBinding: z.string().max(40).catch(DEFAULT_LAUNCHER_BINDING),
    // On unless somebody turned it off (see `launcherClipboardChosen`): the
    // launcher keeps what was copied.
    launcherClipboard: z.boolean().catch(true),
    // Whether `launcherClipboard` is somebody's own choice. Files from before
    // the history was on by default carry `false` there for everyone who saved
    // any setting, chosen or not, so only a value set with this marker counts.
    launcherClipboardChosen: z.boolean().catch(false),
    // How long the clipboard history keeps a copy.
    launcherClipboardKeep: z.enum(CLIPBOARD_KEEP_IDS).catch(DEFAULT_CLIPBOARD_KEEP),
    // Where a web search from the launcher goes.
    launcherEngine: z.enum(SEARCH_ENGINE_IDS).catch("duckduckgo")
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
    startMinimized: true,
    voiceWidget: true,
    voiceWidgetGameOnly: false,
    launcherGameMode: true,
    voiceWidgetPlace: null,
    textSize: null,
    launcher: true,
    launcherBinding: DEFAULT_LAUNCHER_BINDING,
    launcherClipboard: true,
    launcherClipboardChosen: false,
    launcherClipboardKeep: DEFAULT_CLIPBOARD_KEEP,
    launcherEngine: "duckduckgo"
};

function file(): string {
    return join(app.getPath("userData"), "settings.json");
}

/** A stored value that nobody chose gives way to today's default. */
function withDefaults(settings: Settings): Settings {
    return { ...settings, launcherClipboard: clipboardOn(settings.launcherClipboard, settings.launcherClipboardChosen) };
}

function load(): Settings {
    try {
        const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file(), "utf8")));
        return parsed.success ? withDefaults(parsed.data) : { ...EMPTY };
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
export const TOGGLES = ["minimizeToTray", "startMinimized", "voiceWidget", "voiceWidgetGameOnly", "launcher", "launcherClipboard", "launcherGameMode"] as const;

export type Toggle = (typeof TOGGLES)[number];

export function toggle(name: Toggle): boolean {
    return load()[name];
}

export function rememberToggle(name: Toggle, on: boolean): void {
    save({ ...load(), [name]: on, ...(name === "launcherClipboard" ? { launcherClipboardChosen: true } : {}) });
}

/** How long the clipboard history keeps a copy. */
export function launcherClipboardKeep(): ClipboardKeep {
    return load().launcherClipboardKeep;
}

export function rememberLauncherClipboardKeep(keep: ClipboardKeep): void {
    save({ ...load(), launcherClipboardKeep: keep });
}

/** Where the voice widget was dragged to, or null for its corner. */
export function voiceWidgetPlace(): { x: number; y: number } | null {
    return load().voiceWidgetPlace;
}

export function rememberVoiceWidgetPlace(place: { x: number; y: number }): void {
    save({ ...load(), voiceWidgetPlace: place });
}

/** The account's text size, as last seen in the Polaris window. */
export function textSize(): TextSize {
    return load().textSize ?? DEFAULT_TEXT_SIZE;
}

/** Keep a size seen in the Polaris window. Whether it changed. */
export function rememberTextSize(size: TextSize): boolean {
    const settings = load();
    if (settings.textSize === size) return false;
    save({ ...settings, textSize: size });
    return true;
}

/** What was used the last time this service was pushed from here. */
export function pushChoice(serviceId: string): PushChoice | null {
    return load().pushes[serviceId] ?? null;
}

export function rememberPushChoice(serviceId: string, choice: PushChoice): void {
    const settings = load();
    save({ ...settings, pushes: { ...settings.pushes, [serviceId]: choice } });
}

/** The launcher's key, in the dashboard's spelling. */
export function launcherBinding(): string {
    return load().launcherBinding;
}

export function rememberLauncherBinding(binding: string): void {
    save({ ...load(), launcherBinding: binding });
}

/** Where a web search from the launcher goes. */
export function launcherEngine(): SearchEngine {
    return load().launcherEngine;
}

export function rememberLauncherEngine(engine: SearchEngine): void {
    save({ ...load(), launcherEngine: engine });
}
