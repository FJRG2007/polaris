/**
 * The two bridges this app puts into its pages, and the channels behind them.
 *
 * `window.polarisDesktop` is what the dashboard sees when it runs inside this
 * app (its detection is `dashboard/apps/web/src/lib/desktop-bridge.ts`, which
 * keeps its own copy of this shape - the two projects share no code). Everything
 * on it is a request the main process checks again: the page is the dashboard,
 * but the dashboard renders text other people wrote.
 *
 * `window.polarisLocal` is for the few pages this app draws itself - the first
 * run's address form, the API key form and the push window.
 *
 * Failures come back as values rather than as thrown errors: an error thrown
 * across IPC arrives wrapped in "Error invoking remote method", which is not a
 * sentence anybody should be shown.
 */

import type { StrokeInput } from "./annotate";
import type { ServerRow } from "./servers";
import type { InstallRequest, InstallResult } from "./install-tools";
import type { UpdateReady } from "./update-ready";
import type { UpdateCheck } from "./update-check";

export type Outcome = { readonly ok: true; } | { readonly ok: false; readonly error: string; };

/** What the live check found about a typed address: whether it is a Polaris
 *  that can be opened, and the line to show. Null when it was cancelled by a
 *  newer address. */
export type AddressCheck = { readonly ok: boolean; readonly message: string | null; };

export interface NoticeInput {
    readonly title: string;
    /** Where it was said - the conversation, "Mail" - drawn under the title on
     *  macOS and beside it elsewhere. Ignored by an app older than it. */
    readonly subtitle?: string;
    readonly body?: string;
    /** A path on the Polaris to a PNG or JPEG for the notice's picture: the
     *  sender's face. The app's mark when absent or unreadable. */
    readonly icon?: string;
    /** A field on the notice to answer in, with this placeholder: a message
     *  answered where it arrived. The answer comes back through
     *  `onNoticeReply`. */
    readonly reply?: { readonly placeholder: string; };
    /** Buttons on the notice, by id: "Mark as read". A press comes back through
     *  `onNoticeAction` with the id. */
    readonly actions?: readonly NoticeButton[];
    /** Notices sharing a tag replace each other. */
    readonly tag: string;
    /** A path on the Polaris to open when the notice is pressed. */
    readonly href?: string;
    /** Stays until it is dealt with, where the system allows it. */
    readonly insistent?: boolean;
    /**
     * Whether the notice makes a sound of its own.
     *
     * Off by default: the page chimes for what it announces, and one event with
     * two sounds is worse than either. A call asks for it, because a call is
     * announced out here precisely when the window is not the thing in front of
     * somebody - and a window nobody is looking at is one whose audio may be
     * suspended, so the page's own ring is a sound nobody hears.
     */
    readonly sound?: boolean;
}

export type NoticeFeature = "subtitle" | "icon";

export type PickedFolder =
    | { readonly ok: true; readonly name: string; readonly files: number; readonly zip: Uint8Array; }
    | { readonly ok: false; readonly error: string; }
    | null;

export interface PolarisDesktop {
    /** This app's version. */
    readonly version: string;
    readonly platform: string;
    /** What this app's notices draw beyond a title and a body. Absent from an
     *  app older than it, which then draws neither, so the page keeps the words
     *  in the title itself. */
    readonly noticeFeatures?: readonly NoticeFeature[];
    /** Show a notice drawn by the operating system. Resolves false when it cannot. */
    notify(input: NoticeInput): Promise<boolean>;
    /** Take back the notice with this tag. */
    closeNotice(tag: string): Promise<void>;
    /** Hear what is written in a notice's answer field. Answers the way to stop. */
    onNoticeReply(listener: (reply: NoticeReply) => void): () => void;
    /** Hear a press on one of a notice's buttons. Answers the way to stop. */
    onNoticeAction(listener: (action: NoticeAction) => void): () => void;
    /** A folder picked with the system's own dialog, zipped for "Upload a folder".
     *  Null when the dialog was dismissed. */
    pickFolder(): Promise<PickedFolder>;
    /** Build a service here with this computer's Docker and deploy the image. */
    pushLocal(input: { readonly serviceId: string; readonly name: string; readonly href?: string; }): Promise<Outcome>;
    /** Open a path of the Polaris in a window of its own - a service's logs. */
    openWindow(input: { readonly path: string; readonly title: string; }): Promise<Outcome>;
    /** The game running on this computer now, and whether this window is the one
     *  that reports it - only the main window does, so two windows open on the
     *  Polaris do not both tell it. */
    gameActivity(): Promise<{ readonly game: GameActivity | null; readonly reporter: boolean; }>;
    /** Hear the game start, stop, and - every minute while it runs - that it is
     *  still running. Only the main window hears it. Answers the way to stop. */
    onGameActivity(listener: (game: GameActivity | null) => void): () => void;
    /** The programs somebody added as games in the dashboard. */
    setCustomGames(games: readonly CustomGameInput[]): Promise<boolean>;
    /** The names of the programs running now, for picking one to add as a game.
     *  Only ever handed to the page that asked, on a press. */
    runningPrograms(): Promise<readonly string[]>;
    /** Install a tool on this computer, after the app has asked in a dialog of
     *  its own. A cancelled confirmation is a failure with no sentence. */
    installTool(input: InstallRequest): Promise<InstallResult>;
    /** Opens the window that installs Polaris TV on a set on this network. */
    openTvInstall(): Promise<boolean>;
    /** The same install, driven from a dialog on the page instead of a window. */
    readonly tv: TvInstallBridge;
    /** The system's default browser, by a name of ours, or null. */
    defaultBrowser(): Promise<string | null>;
    /** Whether somebody is at this computer: `idle` once nothing has been
     *  typed or moved for a couple of minutes, `locked` behind the lock
     *  screen. The dashboard lets a browser elsewhere make the sounds while
     *  nobody is here. */
    systemIdle(): Promise<SystemIdle>;
    /** Open the app's window for adding and switching servers. */
    openServers(): Promise<void>;
    /** Show what is waiting on the app's own icon - the taskbar button, the
     *  Dock - the way a browser shows it on the tab's icon. */
    setAppBadge(input: {
        readonly label: string | null;
        readonly dot: boolean;
        readonly count: number;
        readonly overlay: string | null;
    }): Promise<boolean>;
    /** The screens and windows to share, each with a small picture, for the
     *  page's own picker. Null where the system's picker is the one to use.
     *  `thumbnails: false` answers faster, with names only. */
    shareSources(input?: { readonly thumbnails?: boolean; }): Promise<ShareSources | null>;
    /** What the page's picker chose, for the `getDisplayMedia` that follows. */
    chooseShare(input: { readonly id: string; readonly sound: boolean; }): Promise<boolean>;
    /** Draw a stroke somebody made on this computer's share over the shared
     *  display. False when there is nothing to draw on: a window share, or a
     *  share this app did not pick. */
    drawOnShare(stroke: StrokeInput): Promise<boolean>;
    /** Whether the share going out now is one `drawOnShare` can draw on. */
    canDrawOnShare(): Promise<boolean>;
    /** Take the drawing off the display: the share ended. */
    stopDrawing(): Promise<void>;
    /** The update of this app that is installed and waits for a restart, or
     *  null. */
    updateReady(): Promise<UpdateReady>;
    /** Hear an update become ready (or stop being). Answers the way to stop.
     *  Listening is how a page says it draws the restart button; while none of
     *  the focused window's listeners are left the app announces the update
     *  with a notice of its own. */
    onUpdateReady(listener: (update: UpdateReady) => void): () => void;
    /** Restart into the waiting update. */
    installUpdate(): Promise<Outcome>;
    /** Ask for a newer version of this app now and say what was found. Newer
     *  than `installUpdate`: a page feature-detects it. */
    checkForUpdates?(): Promise<UpdateCheck>;
    /** This computer's VPN. A refusal's `error` is a word, for the page to say. */
    readonly vpn: {
        deviceName(): Promise<string>;
        /** The public half of a key the service holds; null without a service. */
        key(): Promise<string | null>;
        up(input: VpnConnection): Promise<Outcome>;
        down(): Promise<Outcome>;
        status(): Promise<{ readonly nodeId: string | null }>;
        joinNetwork(input: { readonly server: string; readonly key: string }): Promise<Outcome>;
    };
}

/** What the tunnel needs, as Polaris answered it. */
export interface VpnConnection {
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
}

/** A screen or a window that can be shared. */
export interface ShareSource {
    readonly id: string;
    readonly name: string;
    readonly kind: "screen" | "window";
    /** A JPEG data URL, or null when the system gave no picture. */
    readonly thumbnail: string | null;
    /** The program's icon as a PNG data URL, for a window. */
    readonly icon: string | null;
}

export interface ShareSources {
    readonly sources: readonly ShareSource[];
    /** Whether this computer's sound can go with a share. */
    readonly sound: boolean;
}

/** A game running on this computer, as the dashboard is told it. */
export interface GameActivity {
    /** The program, lowercased, without its folder. */
    readonly key: string;
    readonly name: string;
    /** When this app first saw it, as an ISO moment. */
    readonly startedAt: string;
}

/** A program somebody said is a game. */
export interface CustomGameInput {
    readonly executable: string;
    readonly name: string;
}

/** Where a push is. */
export type PushPhase = "ready" | "checking" | "building" | "saving" | "sending" | "deploying" | "done" | "failed" | "cancelled";

export interface PushState {
    readonly service: string;
    readonly server: string;
    readonly folder: string;
    readonly platform: string;
    readonly phase: PushPhase;
}

export type PushEvent =
    | { readonly kind: "state"; readonly state: PushState; }
    | { readonly kind: "line"; readonly text: string; }
    | { readonly kind: "progress"; readonly sent: number; readonly total: number; }
    | { readonly kind: "result"; readonly ok: boolean; readonly message: string; };

/** The program's own settings, as the settings window shows them. */
export interface Preferences {
    readonly openAtLogin: boolean;
    /** The choice kept, which is the one the next start uses. */
    readonly hardwareAcceleration: boolean;
    /** True when the kept choice differs from the one this run started with. */
    readonly restartPending: boolean;
    readonly version: string;
}

export interface PolarisLocal {
    readonly connect: {
        /** The address in use, why it could not be opened if it could not, and
         *  every server kept. */
        state(): Promise<{ readonly address: string | null; readonly error: string | null; readonly servers: readonly ServerRow[]; }>;
        /** Open an address, adding it to the list with the name given, if any. */
        submit(address: string, name?: string): Promise<Outcome>;
        /** Whether a typed address is a Polaris, asked while it is typed. */
        check(address: string): Promise<AddressCheck>;
        /** Open a server from the list. */
        switchTo(origin: string): Promise<Outcome>;
        rename(origin: string, name: string): Promise<Outcome>;
        remove(origin: string): Promise<Outcome>;
        /** The program's own settings, kept with the servers. */
        preferences(): Promise<Preferences | null>;
        /** Whether it took: the switch goes back when it did not. */
        setOpenAtLogin(open: boolean): Promise<boolean>;
        /** Keep whether the graphics card is used. It applies from the next start. */
        setHardwareAcceleration(on: boolean): Promise<boolean>;
        /** Close and open the app again, so a setting read at start applies. */
        relaunch(): Promise<Outcome>;
        /** Put the settings away. */
        close(): Promise<void>;
        /** Ask for a newer version of this app now and say what was found. */
        checkForUpdates(): Promise<UpdateCheck>;
        /** Restart into the version that is installed and waiting. */
        restartToUpdate(): Promise<Outcome>;
        /** Open the download page of the version found; false when there is none. */
        openUpdatePage(): Promise<boolean>;
    };
    readonly apiKey: {
        state(): Promise<{ readonly server: string; readonly canKeep: boolean; }>;
        submit(key: string): Promise<Outcome>;
        cancel(): Promise<void>;
        /** Open Account > API keys in the main window. */
        openKeys(): Promise<void>;
    };
    readonly push: {
        state(): Promise<PushState>;
        chooseFolder(): Promise<string | null>;
        start(input: { readonly platform: string; }): Promise<Outcome>;
        cancel(): Promise<void>;
        openService(): Promise<void>;
        onEvent(listener: (event: PushEvent) => void): () => void;
    };
    readonly tv: TvInstallBridge;
    readonly overlay: {
        onStroke(listener: (stroke: StrokeInput) => void): () => void;
    };
}

/** Installing on a TV, as the TV window and the dashboard's dialog both drive it. */
export interface TvInstallBridge {
    state(): Promise<TvInstallState>;
    find(): Promise<TvInstallState>;
    /** Lists the TVs plugged into this computer by USB with USB debugging on. */
    findUsb(): Promise<TvInstallState>;
    /** Stops a search; an install already under way runs to its end. */
    cancel(): Promise<TvInstallState>;
    /** `host` for a TV on the network, `usb` for one from `TvInstallState.usb`. */
    start(input: { readonly host: string; readonly home: boolean } | { readonly usb: string; readonly home: boolean }): Promise<boolean>;
    onState(listener: (state: TvInstallState) => void): () => void;
}

/** Where installing on a TV has got to. */
export type TvPhase =
    | "ready"
    | "searching"
    | "connecting"
    | "allow"
    | "checking"
    | "backup"
    | "download"
    | "install"
    | "home"
    | "closing"
    | "done"
    | "failed";

/** How it ended. */
export type TvOutcome =
    | "installed"
    | "installed-home"
    | "installed-home-refused"
    | "installed-home-unknown"
    | "adb-off"
    | "not-allowed"
    | "unreachable"
    | "not-android-tv"
    | "too-old"
    | "not-released"
    | "download-failed"
    | "key-failed"
    | "connection-lost"
    | "backup-failed"
    | "sideload-refused"
    | "install-failed"
    | "install-interrupted"
    | "usb-busy"
    | "usb-gone";

/** A TV plugged in by USB that offers ADB. */
export interface TvUsbDevice {
    readonly id: string;
    readonly name: string;
}

export interface TvInstallState {
    readonly phase: TvPhase;
    /** Addresses on this network that answer on the ADB port. */
    readonly found: readonly string[];
    /** TVs plugged in by USB; null until somebody looked. Present only on apps that install over USB. */
    readonly usb: readonly TvUsbDevice[] | null;
    /** Whether the USB list is being read now. */
    readonly usbListing: boolean;
    readonly outcome: TvOutcome | null;
    /** The folder the TV's backup was written to. */
    readonly backup: string | null;
    /** Whether the port refused afterwards; null until that was checked. */
    readonly closed: boolean | null;
}

/** What the main process asks of the hidden page that holds a TV's USB connection. */
export type UsbRequest =
    | { readonly id: number; readonly op: "list"; }
    | { readonly id: number; readonly op: "open"; readonly device: string; }
    | { readonly id: number; readonly op: "close"; };

/** Its answer. `busy`: another program holds the device, or Windows has no driver
 *  for it; `gone`: it is no longer plugged in. */
export type UsbReply =
    | { readonly id: number; readonly ok: true; readonly devices?: readonly TvUsbDevice[]; }
    | { readonly id: number; readonly ok: false; readonly error: "busy" | "gone"; };

/** `window.polarisUsb`, on that page only. */
export interface UsbBridge {
    onRequest(listener: (request: UsbRequest) => void): void;
    reply(reply: UsbReply): void;
    /** One packet to send: header and payload, as two transfers. */
    onOut(listener: (header: Uint8Array, data: Uint8Array) => void): void;
    /** One packet read from the TV, header and payload together. */
    received(bytes: Uint8Array): void;
    /** The open device went away. */
    lost(): void;
}

/** A button on a notice. */
export interface NoticeButton {
    readonly id: string;
    readonly text: string;
}

/** A press on a notice's button, handed back to the page that raised it. */
export interface NoticeAction {
    readonly tag: string;
    readonly action: string;
}

/** An answer written on a notice, handed back to the page that raised it. */
export interface NoticeReply {
    readonly tag: string;
    readonly text: string;
}

/** What `powerMonitor.getSystemIdleState` answers. */
export type SystemIdle = "active" | "idle" | "locked" | "unknown";

export const CHANNELS = {
    notify: "desktop:notify",
    noticeReply: "desktop:notice-reply",
    noticeAction: "desktop:notice-action",
    closeNotice: "desktop:close-notice",
    pickFolder: "desktop:pick-folder",
    pushLocal: "desktop:push-local",
    openWindow: "desktop:open-window",
    gameActivity: "desktop:game-activity",
    gameCurrent: "desktop:game-current",
    gameCustom: "desktop:game-custom",
    gamePrograms: "desktop:game-programs",
    installTool: "desktop:install-tool",
    defaultBrowser: "desktop:default-browser",
    systemIdle: "desktop:system-idle",
    openServers: "desktop:open-servers",
    appBadge: "desktop:app-badge",
    shareSources: "desktop:share-sources",
    chooseShare: "desktop:choose-share",
    drawOnShare: "desktop:draw-on-share",
    canDrawOnShare: "desktop:can-draw-on-share",
    stopDrawing: "desktop:stop-drawing",
    titleBarColors: "desktop:title-bar-colors",
    updateReady: "desktop:update-ready",
    updateCurrent: "desktop:update-current",
    installUpdate: "desktop:install-update",
    checkUpdates: "desktop:check-updates",
    vpnDeviceName: "desktop:vpn-device-name",
    vpnKey: "desktop:vpn-key",
    vpnUp: "desktop:vpn-up",
    vpnDown: "desktop:vpn-down",
    vpnStatus: "desktop:vpn-status",
    vpnJoin: "desktop:vpn-join",
    offerUpdate: "desktop:offer-update",
    overlayStroke: "desktop:overlay-stroke",
    connectState: "local:connect-state",
    connectSubmit: "local:connect-submit",
    connectPreferences: "local:connect-preferences",
    connectOpenAtLogin: "local:connect-open-at-login",
    connectHardwareAcceleration: "local:connect-hardware-acceleration",
    connectRelaunch: "local:connect-relaunch",
    connectSwitch: "local:connect-switch",
    connectRename: "local:connect-rename",
    connectRemove: "local:connect-remove",
    connectCheck: "local:connect-check",
    connectClose: "local:connect-close",
    connectCheckUpdates: "local:connect-check-updates",
    connectRestart: "local:connect-restart",
    connectUpdatePage: "local:connect-update-page",
    keyState: "local:key-state",
    keySubmit: "local:key-submit",
    keyCancel: "local:key-cancel",
    keyOpen: "local:key-open",
    pushState: "local:push-state",
    pushChoose: "local:push-choose",
    pushStart: "local:push-start",
    pushCancel: "local:push-cancel",
    pushOpenService: "local:push-open-service",
    pushEvent: "local:push-event",
    tvOpen: "desktop:tv-open",
    tvState: "local:tv-state",
    tvFind: "local:tv-find",
    tvStart: "local:tv-start",
    tvCancel: "local:tv-cancel",
    tvFindUsb: "local:tv-find-usb",
    usbRequest: "usb:request",
    usbReply: "usb:reply",
    usbOut: "usb:out",
    usbIn: "usb:in",
    usbLost: "usb:lost",
    tvEvent: "local:tv-event"
} as const;

/** The argument that carries this app's version into the dashboard's preload. */
export const VERSION_ARGUMENT = "--polaris-desktop-version=";
