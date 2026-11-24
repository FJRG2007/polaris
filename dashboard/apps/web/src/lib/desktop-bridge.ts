/**
 * The Polaris desktop app, seen from the page it opens.
 *
 * The app (`clients/desktop/` at the repository root) loads this dashboard in a window of
 * its own and puts one object on the page, `window.polarisDesktop`, for the
 * things a browser tab cannot do: notices drawn by the operating system, a
 * folder zipped straight from the disk, a build pushed from the computer's own
 * Docker, a page opened in a window of its own, and the game running on the
 * computer. In a browser there is no such object, and every caller here falls
 * back to what the browser does.
 *
 * The shape is kept here as well as in `clients/desktop/src/shared/bridge.ts` - the two
 * projects share no code. Detection checks the members it uses rather than
 * trusting that something with the right name is the app.
 */

import { z } from "zod";
import type { SeasonCalendar } from "@polaris/core";
import type { AppKeyPress, AppSettingChange } from "@polaris/core/app-settings";

export type DesktopOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type DesktopFolder =
    | { readonly ok: true; readonly name: string; readonly files: number; readonly zip: Uint8Array }
    | { readonly ok: false; readonly error: string }
    | null;

/** Where this computer's tunnel stands. */
export interface DesktopVpnStatus {
    /** The server it is connected to, null when it is off. */
    readonly nodeId: string | null;
}

/** Where installing on a TV has got to, as `clients/desktop/src/shared/bridge.ts` names it. */
export type DesktopTvPhase =
    | "ready"
    | "searching"
    | "connecting"
    | "allow"
    | "checking"
    | "backup"
    | "download"
    | "install"
    | "home"
    | "control"
    | "closing"
    | "done"
    | "failed";

export interface DesktopTvState {
    readonly phase: DesktopTvPhase;
    /** Addresses on the computer's network that answer on the ADB port. */
    readonly found: readonly string[];
    /** TVs plugged into the computer by USB; null until listed. Absent on an app older than that. */
    readonly usb?: readonly { readonly id: string; readonly name: string }[] | null;
    /** Whether the USB list is being read now. Absent on an app older than that. */
    readonly usbListing?: boolean;
    /** How it ended; an app newer than this page may name one it does not know. */
    readonly outcome: string | null;
    /** Whether the TV was left on its link screen for this Polaris. Absent on older desktop apps. */
    readonly linking?: boolean | null;
    /** The folder on the computer the TV's backup was written to. */
    readonly backup: string | null;
    /** Whether network debugging refused afterwards; null until checked. */
    readonly closed: boolean | null;
    /** While the install waits on the TV: the one thing to do there. Absent on an app older than that. */
    readonly waiting?: DesktopTvWaiting | null;
    /** The name a found TV announced, by address. Absent on an app older than that. */
    readonly named?: Readonly<Record<string, string>>;
    /**
     * What installing as the TV's system got, level by level; empty for an app-only install. An app
     * newer than this page may name a level or state it does not know. Absent on older desktop apps.
     */
    readonly control?: readonly DesktopTvControl[] | null;
}

/** system: Polaris TV becomes the TV's system, with every permission it allows. app: installed, nothing else changed. */
export type DesktopTvInstallMode = "system" | "app";

/** One level of control the app tried on the TV. */
export interface DesktopTvControl {
    readonly rung: string;
    readonly state: string;
}

/** The instruction for this TV while the install waits: its menus, from the TV checker's data. */
export interface DesktopTvWaiting {
    readonly step: "debugging" | "prompt";
    /** The `id` of these steps in core's TV checker data, read in the account's language. Absent on an app older than that. */
    readonly steps?: string;
    readonly about: string;
    readonly press: string;
    readonly presses: number;
    readonly developer: string;
    readonly switches: readonly string[];
}

/** Installing on a TV from a dialog on this page, through the app. */
export interface DesktopTv {
    state(): Promise<DesktopTvState | null>;
    find(): Promise<DesktopTvState | null>;
    /** Lists TVs plugged in by USB. Absent on an app older than that. */
    findUsb?(): Promise<DesktopTvState | null>;
    /** Stops a search; an install under way runs to its end. */
    cancel(): Promise<DesktopTvState | null>;
    start(
        input:
            | {
                  readonly host: string;
                  /** Read by apps that know it; older ones read only `home`, so both are sent. */
                  readonly mode?: DesktopTvInstallMode;
                  readonly home: boolean;
                  /** The six digits the TV shows for Wireless debugging, once it asked for them. */
                  readonly code?: string;
              }
            | { readonly usb: string; readonly mode?: DesktopTvInstallMode; readonly home: boolean }
    ): Promise<boolean>;
    onState(listener: (state: DesktopTvState) => void): () => void;
}

/** What the desktop app's voice widget draws: the call's people and the
 *  reader's own mute and deafen. */
export interface DesktopVoiceState {
    readonly participants: readonly {
        readonly id: string;
        readonly name: string;
        readonly speaking: boolean;
        readonly muted: boolean;
        readonly deafened: boolean;
        /** Their face, as a path on this Polaris. Sent only to an app that
         *  says it draws one (`voiceWidgetPictures`): an older app refuses the
         *  whole state over a field it does not know. */
        readonly picture?: string;
    }[];
    readonly selfMuted: boolean;
    readonly selfDeafened: boolean;
}

/** This computer's runner, as the desktop reports it (`clients/desktop/src/shared/bridge.ts`). */
export interface DesktopComputerState {
    readonly paired: boolean;
    readonly state: "connecting" | "online" | "offline" | "unpaired" | "outdated" | "replaced" | "stopped";
    readonly preparing: {
        readonly tool: string;
        readonly step: "download" | "verify" | "install" | "ready" | "failed";
        readonly received?: number;
        readonly total?: number;
        readonly code?: "offline" | "checksum" | "disk" | "unsupported" | "blocked" | "install";
    } | null;    /** This computer's id on the Polaris open here, once paired. Absent on an older app. */
    readonly runnerId?: string;
}

export interface DesktopComputer {
    state(): Promise<DesktopComputerState | null>;
    pair(code: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: "code" | "offline" | "storage" | "limited" | "refused" }>;
    forget(): Promise<boolean>;
    prepare(): Promise<boolean>;
    onState(listener: (state: DesktopComputerState) => void): () => void;
    /** The folders a session on this computer may work in. Absent on an older app. */
    folders?(): Promise<readonly string[]>;
    /** Choose one more in the native dialog; null when the person cancels. */
    pickFolder?(): Promise<
        | { readonly ok: true; readonly folder: string; readonly folders: readonly string[] }
        | { readonly ok: false; readonly reason: "refused" | "storage" }
        | null
    >;
    removeFolder?(folder: string): Promise<readonly string[] | null>;
}

export interface PolarisDesktop {
    readonly version: string;
    /** This computer as a runner for Polar Code. Absent on an app older than it. */
    readonly computer?: DesktopComputer;
    /** Absent on an app older than Polaris TV. */
    openTvInstall?(): Promise<boolean>;
    /** The install driven from a dialog. Absent on an app older than that. */
    readonly tv?: DesktopTv;
    readonly platform: string;
    /** This computer's VPN. Absent from an app older than the feature. */
    readonly vpn?: {
        /** What this computer calls itself on the device list. */
        deviceName(): Promise<string>;
        /** The public half of a key that stays in the app; null if it cannot make one. */
        key(): Promise<string | null>;
        up(input: {
            readonly nodeId: string;
            readonly address: string;
            readonly dns: readonly string[];
            readonly nodePublicKey: string;
            readonly endpoint: string;
            readonly port: number;
            /** A VPN from elsewhere: its own keys and what it carries. */
            readonly own?: {
                readonly privateKey: string;
                readonly presharedKey: string | null;
                readonly moreAddresses: readonly string[];
                readonly allowedIps: readonly string[];
                readonly mtu: number | null;
            };
        }): Promise<DesktopOutcome>;
        down(): Promise<DesktopOutcome>;
        status(): Promise<DesktopVpnStatus>;
        /** Signs this computer into a private network with a one-time key. */
        joinNetwork(input: {
            readonly server: string;
            readonly key: string;
        }): Promise<DesktopOutcome>;
    };
    /** What the app's notices draw beyond a title and a body. Absent from an
     *  app older than it, which draws neither. */
    readonly noticeFeatures?: readonly string[];
    notify(input: {
        readonly title: string;
        /** Ignored by an app that does not list "subtitle" in `noticeFeatures`. */
        readonly subtitle?: string;
        readonly body?: string;
        /** A path on the Polaris to a PNG or JPEG. Ignored by an app that does
         *  not list "icon" in `noticeFeatures`. */
        readonly icon?: string;
        readonly tag: string;
        readonly href?: string;
        readonly insistent?: boolean;
        /** Whether the notice rings. Only a call asks for it - see
         *  `desktop-notify`. */
        readonly sound?: boolean;
        /** A field on the notice to answer in, with this placeholder. The answer
         *  comes back through `onNoticeReply`. */
        readonly reply?: { readonly placeholder: string };
        /** Buttons on the notice. A press comes back through `onNoticeAction`. */
        readonly actions?: readonly { readonly id: string; readonly text: string }[];
    }): Promise<boolean>;
    /** Hear the answers written on notices. Absent from an app older than the
     *  feature, which then draws the notice without the field. */
    onNoticeReply?(
        listener: (reply: { readonly tag: string; readonly text: string }) => void
    ): () => void;
    /** Hear a press on a notice's button. Absent from an app older than the
     *  feature, which then draws the notice without the buttons. */
    onNoticeAction?(
        listener: (action: { readonly tag: string; readonly action: string }) => void
    ): () => void;
    closeNotice(tag: string): Promise<void>;
    pickFolder(): Promise<DesktopFolder>;
    pushLocal(input: {
        readonly serviceId: string;
        readonly name: string;
        readonly href?: string;
    }): Promise<DesktopOutcome>;
    openWindow(input: { readonly path: string; readonly title: string }): Promise<DesktopOutcome>;
    /** The game running on the computer, and whether this window is the one that
     *  reports it. Absent from an app older than game detection, which then
     *  reports nothing. */
    gameActivity?(): Promise<{ readonly game: DesktopGame | null; readonly reporter: boolean }>;
    /** Hear a game start, stop, or still run (every minute). Only the app's main
     *  window hears it. */
    onGameActivity?(listener: (game: DesktopGame | null) => void): () => void;
    /** Hand the app the programs this account added as games. */
    setCustomGames?(
        games: readonly { readonly executable: string; readonly name: string }[]
    ): Promise<boolean>;
    /** The programs running now, for picking one to add as a game. */
    runningPrograms?(): Promise<readonly string[]>;
    /** Whether somebody is at this computer: `idle` after a couple of minutes
     *  untouched, `locked` behind the lock screen. Absent from an older app,
     *  which then never says it is away. */
    systemIdle?(): Promise<"active" | "idle" | "locked" | "unknown">;
    /** What Polaris's own right-click menu asks of the app: the spelling
     *  checker, the clipboard and the picture under the pointer. Absent on an
     *  app older than it; every answer is a value, never a thrown error. */
    readonly editing?: DesktopEditing;
    /** Hear this window minimized or sent to the tray (false) and brought back
     *  (true). Absent from an older app, whose page falls back to the window's
     *  focus to tell (`lib/idle.ts`). */
    onWindowShown?(listener: (shown: boolean) => void): () => void;
    /** Hold a call's mute and deafen keys system-wide, so they work with
     *  another program in front; null lets them go. Answers which controls the
     *  system gave - a key another program holds is not taken, and the page
     *  keeps listening itself for that one. Absent from an older app. */
    setCallHotkeys?(
        input: { readonly mic: readonly string[]; readonly deafen: readonly string[] } | null
    ): Promise<{ readonly mic: boolean; readonly deafen: boolean }>;
    /** Hear one of those keys pressed. Answers the way to stop. */
    onCallHotkey?(listener: (which: "mic" | "deafen") => void): () => void;
    /** Who is in the call and who is talking, for the app's voice widget over
     *  every window; null once the call ends. Absent from an older app. */
    setVoiceState?(state: DesktopVoiceState | null): Promise<boolean>;
    /** Whether the voice widget draws faces. Absent from an app older than it. */
    readonly voiceWidgetPictures?: boolean;
    /** Hear a press on the voice widget's buttons. Answers the way to stop. */
    onVoiceAction?(listener: (action: "mic" | "deafen" | "leave") => void): () => void;
    /** Hear a device add-on's camera or screen button. Absent from an app older than add-ons. */
    onCallAction?(listener: (action: "camera" | "share") => void): () => void;
    /**
     * The device add-ons on this computer, for Settings > Device add-ons.
     * Every answer is read through `@polaris/core/device-addons`; absent from
     * an app older than them.
     */
    addons?: {
        get(): Promise<unknown>;
        refresh(): Promise<void>;
        install(id: string, accepted: readonly string[]): Promise<unknown>;
        uninstall(id: string): Promise<boolean>;
        setEnabled(id: string, enabled: boolean): Promise<boolean>;
        settings(id: string): Promise<unknown>;
        setSetting(id: string, key: string, value: unknown): Promise<unknown>;
        /** Automatic updates for one add-on, or all (`id` null). Absent from an app older than them. */
        setAutoUpdate?(id: string | null, value: boolean | null): Promise<boolean>;
        /** A call from the add-on's own view, judged by the app. Absent from an app older than views. */
        viewCall?(id: string, method: string, params: unknown): Promise<unknown>;
        /** The device's official software on this computer (look, choose, restore, launch). Absent from an app older than it. */
        official?(id: string, request: unknown): Promise<unknown>;
        onChange(listener: () => void): () => void;
        onOpen(listener: (id: string) => void): () => void;
    };
    /** The window that adds and switches servers. Absent from an older app. */
    openServers?(): Promise<void>;
    /** Windows' Default apps at Polaris, to pick it for mailto links; false
     *  off Windows. Absent from an app older than it. */
    openMailDefaults?(): Promise<boolean>;
    /** What is waiting, on the app's icon in the taskbar or Dock. Missing on a
     *  desktop app older than it. */
    setAppBadge?(input: {
        readonly label: string | null;
        readonly dot: boolean;
        readonly count: number;
        readonly overlay: string | null;
    }): Promise<boolean>;
    /** The app's window, taskbar, tray and Dock icon in the season's dress: a
     *  PNG data URL, or null for the plain icon the app ships with. Missing on
     *  a desktop app older than it, which keeps its plain icon. */
    setAppIcon?(input: {
        readonly png: string | null;
        /** From here on, an app that settles several hosts (`appIconSeason`):
         *  which host this is, its calendar (null with seasons off), and the
         *  dressed marks it may need by season. An app older than that refuses
         *  the call, and the page sends `{ png }` alone. */
        readonly host?: string;
        readonly calendar?: SeasonCalendar | null;
        readonly icons?: Partial<Record<string, string>>;
    }): Promise<boolean>;
    /** The screens and windows to share, each with a small picture, for the
     *  picker this page draws. Null where the system's own picker is the one to
     *  use (macOS). Absent from an app older than the picker, which then shows
     *  its own dialog. `thumbnails: false` answers faster, with names only; an
     *  app older than that option ignores it and sends the pictures. */
    shareSources?(input?: {
        readonly thumbnails?: boolean;
        /** One kind only, the tab on screen. An app older than this lists both. */
        readonly kind?: "screen" | "window";
    }): Promise<DesktopShareSources | null>;
    /** What the picker chose, for the `getDisplayMedia` call that follows. */
    chooseShare?(input: { readonly id: string; readonly sound: boolean }): Promise<boolean>;
    /** Draw a stroke somebody made on this browser's share over the shared
     *  display itself. False when there is nothing to draw on - a window share,
     *  or a share the app did not pick. */
    drawOnShare?(stroke: DesktopStroke): Promise<boolean>;
    /** Whether the share going out now is one `drawOnShare` can draw on.
     *  Absent from an app older than it. */
    canDrawOnShare?(): Promise<boolean>;
    /** Take the drawing off the display: the share ended. */
    stopDrawing?(): Promise<void>;
    /** The update of the app that is installed and waits for a restart, or
     *  null. Absent, with the two below, from an app older than 0.1.3, which
     *  offers the restart only from its own menu. */
    updateReady?(): Promise<DesktopUpdate | null>;
    /** Hear an update become ready. Answers the way to stop. */
    onUpdateReady?(listener: (update: DesktopUpdate | null) => void): () => void;
    /** Restart the app into the waiting update. */
    installUpdate?(): Promise<DesktopOutcome>;
    /** Ask for a newer version of the app now. Absent from an app older than
     *  0.1.14; what it answers is read with `readDesktopUpdateCheck`. */
    checkForUpdates?(): Promise<unknown>;
    /** Why this run of the app began - it restarted itself into an update, or
     *  for a restart it offered - with the note this page held of its call
     *  then, once; null for a start nobody but a person made. Read with
     *  `readDesktopRelaunch`. Absent, with `holdCall`, from an app older than
     *  0.1.70. */
    relaunched?(): Promise<unknown>;
    /** This page's own note of the call it is on now, or null for none: the
     *  app hands it back through `relaunched` after a restart it makes, and
     *  never otherwise. */
    holdCall?(note: string | null): Promise<boolean>;
    /**
     * The settings the app keeps on this computer, drawn by Settings > This app.
     * Every answer is read with `readAppSettings`. Absent from an app older than
     * 0.1.71, which keeps them on its own page only.
     */
    appSettings?: DesktopAppSettings;
}

/** The app's own settings, as `clients/desktop/src/shared/bridge.ts` names them. */
export interface DesktopAppSettings {
    /** Every value and the facts beside them. */
    get(): Promise<unknown>;
    /** Change one; answers the snapshot after it, or null when refused. */
    set(change: AppSettingChange): Promise<unknown>;
    /** Start (true) or stop (false) taking a press as the launcher's key. */
    record(recording: boolean): Promise<void>;
    /** The press that becomes the launcher's key; answers the snapshot after it. */
    setShortcut(press: AppKeyPress): Promise<unknown>;
    /** Delete every copy the clipboard history kept. */
    clearClipboard(): Promise<void>;
    /** Start the app again, for a setting that applies then. */
    relaunch(): Promise<void>;
    /** Open where the hosts are managed: this page's Hosts when it said it draws
     *  them, else the app's own hosts window. */
    manageHosts(): Promise<void>;
    /** Say this page draws the settings, so the tray and menus open them here,
     *  and which of `DESKTOP_SETTINGS_FEATURES` it draws as well. An app older
     *  than hosts ignores the argument. */
    announce(features?: readonly DesktopSettingsFeature[]): Promise<void>;
    /** The hosts the app keeps, managed here. Absent from an app older than that,
     *  which manages them in its own window (`manageHosts`). */
    hosts?: DesktopHosts;
    /** Put the voice widget back as it first came; answers the snapshot after it. Absent in older apps. */
    resetOverlay?(): Promise<unknown>;
    /** A press becomes the overlay's lock key; null puts back the default keys. Answers the snapshot. Absent in older apps. */
    setOverlayShortcut?(press: AppKeyPress | null): Promise<unknown>;
    /** Turn the overlay on or off for one game. Answers the snapshot. Absent in older apps. */
    setOverlayGame?(key: string, on: boolean): Promise<unknown>;
    /** Hear that a value changed anywhere. Answers the way to stop. */
    onChange(listener: () => void): () => void;
    /** Hear the app asking to show a category. Answers the way to stop. */
    onOpen(listener: (category: string) => void): () => void;
}

/** What a page that draws the settings can say it draws besides them. */
export const DESKTOP_SETTINGS_FEATURES = ["hosts"] as const;

export type DesktopSettingsFeature = (typeof DESKTOP_SETTINGS_FEATURES)[number];

/**
 * The hosts the desktop app keeps, as `clients/desktop/src/shared/bridge.ts` names them.
 * Every address is checked by the app with the same schema and probe as its own
 * hosts window; every answer is read here with the `readDesktopHost*` readers.
 */
export interface DesktopHosts {
    list(): Promise<unknown>;
    /** Whether a typed address is a Polaris, asked while it is typed. */
    check(address: string): Promise<unknown>;
    /** Keep a host after checking it; the windows stay where they are. */
    add(address: string, name: string): Promise<unknown>;
    /** Open a listed host in the windows. */
    switchTo(origin: string): Promise<unknown>;
    /** Change a listed host's address and name together. */
    edit(origin: string, address: string, name: string): Promise<unknown>;
    /** Take a host off the list; removing the one in use closes its windows. */
    remove(origin: string): Promise<unknown>;
    status(origin: string): Promise<unknown>;
    /** The list as a `polaris://hosts` link, for a QR another device scans. */
    link(): Promise<unknown>;
    /** Put the list on the clipboard as a code. */
    copy(): Promise<unknown>;
    /** Write the list to a file somebody picks. */
    exportFile(): Promise<unknown>;
    /** Take in a list from a file somebody picks. */
    importFile(): Promise<unknown>;
    /** Take in a list from a pasted or scanned code. */
    importText(text: string): Promise<unknown>;
}

const desktopHostRowSchema = z.object({
    origin: z.string().url().max(2048),
    name: z.string().max(200).nullable(),
    host: z.string().max(2048),
    active: z.boolean()
});

const desktopHostsSchema = z.object({
    servers: z.array(desktopHostRowSchema).max(100),
    error: z.string().max(2000).nullable()
});

export type DesktopHostRow = z.infer<typeof desktopHostRowSchema>;
export type DesktopHostsSnapshot = z.infer<typeof desktopHostsSchema>;

/** The hosts the app answered, or null for an answer that is not one. */
export function readDesktopHosts(raw: unknown): DesktopHostsSnapshot | null {
    const parsed = desktopHostsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

const desktopOutcomeSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true) }),
    z.object({ ok: z.literal(false), error: z.string().max(2000) })
]);

/** A change the app made or refused; anything unreadable is a refusal with no words. */
export function readDesktopOutcome(raw: unknown): DesktopOutcome {
    const parsed = desktopOutcomeSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, error: "" };
}

const desktopAddressCheckSchema = z.object({ ok: z.boolean(), message: z.string().max(2000).nullable() });

/** What the app found about a typed address; null message means a newer address replaced it. */
export type DesktopAddressCheck = z.infer<typeof desktopAddressCheckSchema>;

export function readDesktopAddressCheck(raw: unknown): DesktopAddressCheck {
    const parsed = desktopAddressCheckSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, message: null };
}

const desktopHostStatusSchema = z.enum(["online", "offline", "unknown"]);

/** How a listed host answered just now; "unknown" when not asked or unreadable. */
export type DesktopHostStatus = z.infer<typeof desktopHostStatusSchema>;

export function readDesktopHostStatus(raw: unknown): DesktopHostStatus {
    const parsed = desktopHostStatusSchema.safeParse(raw);
    return parsed.success ? parsed.data : "unknown";
}

const desktopHostImportSchema = z.discriminatedUnion("ok", [
    z.object({
        ok: z.literal(true),
        added: z.number().int().min(0),
        named: z.number().int().min(0),
        skipped: z.number().int().min(0)
    }),
    z.object({ ok: z.literal(false), error: z.string().max(2000).nullable() })
]);

/** What taking in or writing out a list did. An error of null means it was cancelled. */
export type DesktopHostImport = z.infer<typeof desktopHostImportSchema>;

export function readDesktopHostImport(raw: unknown): DesktopHostImport {
    const parsed = desktopHostImportSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, error: "" };
}

const desktopHostCopySchema = z.object({ ok: z.boolean(), count: z.number().int().min(0) });

export function readDesktopHostCopy(raw: unknown): z.infer<typeof desktopHostCopySchema> {
    const parsed = desktopHostCopySchema.safeParse(raw);
    return parsed.success ? parsed.data : { ok: false, count: 0 };
}

/** The `polaris://hosts` link the app made, or null for anything else. */
export function readDesktopHostsLink(raw: unknown): string | null {
    const parsed = z.string().max(65536).startsWith("polaris://").safeParse(raw);
    return parsed.success ? parsed.data : null;
}

const desktopRelaunchSchema = z.object({
    reason: z.enum(["update", "relaunch"]),
    at: z.number().finite(),
    call: z.string().max(8192).nullable()
});

/** Why the desktop app's run began, as it says it. */
export type DesktopRelaunch = z.infer<typeof desktopRelaunchSchema>;

/** The app's answer as one: anything else is a start nobody but a person made. */
export function readDesktopRelaunch(raw: unknown): DesktopRelaunch | null {
    const parsed = desktopRelaunchSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

const updateCheckSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("current"), version: z.string().trim().min(1).max(40) }),
    z.object({ kind: z.literal("downloading"), version: z.string().trim().min(1).max(40) }),
    z.object({ kind: z.literal("ready"), version: z.string().trim().min(1).max(40) }),
    z.object({ kind: z.literal("available"), version: z.string().trim().min(1).max(40) }),
    z.object({ kind: z.literal("failed") }),
    z.object({ kind: z.literal("unsupported") })
]);

/** What "Check for updates" found, as the desktop app answers it. */
export type DesktopUpdateCheck = z.infer<typeof updateCheckSchema>;

/** The app's answer as one of the known ones; anything else is a failed check.
 *  The app's own reason is English-only and is not shown on the page. */
export function readDesktopUpdateCheck(raw: unknown): DesktopUpdateCheck {
    const parsed = updateCheckSchema.safeParse(raw);
    return parsed.success ? parsed.data : { kind: "failed" };
}

/** The desktop app's editing help (its `EditingBridge`). */
export interface DesktopEditing {
    spelling(word: string): { readonly misspelled: boolean; readonly suggestions: readonly string[] };
    addToDictionary(word: string): Promise<boolean>;
    readClipboard(): Promise<string | null>;
    writeClipboard(text: string): Promise<boolean>;
    /** The picture at a point of the page, in CSS pixels. */
    copyImageAt(x: number, y: number): Promise<boolean>;
    saveImage(url: string): Promise<boolean>;
}

/** An update of the desktop app that waits for a restart. */
export interface DesktopUpdate {
    readonly version: string;
}

const desktopUpdateSchema = z.object({ version: z.string().trim().min(1).max(64) });

/** What the app said about its update, as one: anything else is no update. */
export function readDesktopUpdate(raw: unknown): DesktopUpdate | null {
    const parsed = desktopUpdateSchema.safeParse(raw);
    return parsed.success ? { version: parsed.data.version } : null;
}

/** Points of a stroke, as fractions of the shared picture. */
export interface DesktopStroke {
    readonly key: string;
    readonly color: string;
    readonly points: readonly (readonly [number, number])[];
    readonly end: boolean;
}

/** A screen or a window the desktop app can share. */
export interface DesktopShareSource {
    readonly id: string;
    readonly name: string;
    readonly kind: "screen" | "window";
    /** A small picture as a data URL, or null when the system gave none. */
    readonly thumbnail: string | null;
    /** The program's icon as a data URL, for a window. */
    readonly icon: string | null;
}

export interface DesktopShareSources {
    readonly sources: readonly DesktopShareSource[];
    /** Whether this computer's sound can go with a share. */
    readonly sound: boolean;
}

/** A game the desktop app saw running, as it reports it. */
export interface DesktopGame {
    readonly key: string;
    readonly name: string;
    readonly startedAt: string;
    /** The store's id for the game (`steam:252950`), sent by desktop apps that know it. */
    readonly store?: string;
}

const METHODS = ["notify", "closeNotice", "pickFolder", "pushLocal", "openWindow"] as const;

/** Whether a value is the desktop app's bridge. */
export function isDesktopBridge(value: unknown): value is PolarisDesktop {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return (
        typeof candidate.version === "string" &&
        METHODS.every((name) => typeof candidate[name] === "function")
    );
}

/** The desktop app's bridge when this page runs inside the app, otherwise null. */
export function desktopBridge(): PolarisDesktop | null {
    if (typeof window === "undefined") return null;
    const value = (window as { polarisDesktop?: unknown }).polarisDesktop;
    return isDesktopBridge(value) ? value : null;
}

/** The alerts the desktop app raises a notice for as they arrive: a deploy that
 *  finished, either way, and an agent session that needs its owner, ended on
 *  its own, or whose pull request failed its checks, became ready or merged. The dashboard's bell still lists them as it always did. */
const DEPLOY_RESULTS = new Set([
    "deploy.succeeded",
    "deploy.failed",
    "agent.waiting",
    "agent.ended",
    "agent.ci.failed",
    "agent.pr.ready",
    "agent.pr.merged"
]);

interface FeedRow {
    readonly id: string;
    readonly type: string;
    readonly read: boolean;
}

/**
 * The deploy results in a feed update that are new to this page - read before
 * the update is recorded as seen, so a result already on screen when the page
 * opened, or one already read elsewhere, never raises a notice.
 */
export function arrivedDeployResults<T extends FeedRow>(
    seen: ReadonlySet<string>,
    rows: readonly T[]
): T[] {
    return rows.filter((row) => !seen.has(row.id) && !row.read && DEPLOY_RESULTS.has(row.type));
}
