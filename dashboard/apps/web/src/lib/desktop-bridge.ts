/**
 * The Polaris desktop app, seen from the page it opens.
 *
 * The app (`desktop/` at the repository root) loads this dashboard in a window of
 * its own and puts one object on the page, `window.polarisDesktop`, for the
 * things a browser tab cannot do: notices drawn by the operating system, a
 * folder zipped straight from the disk, a build pushed from the computer's own
 * Docker, a page opened in a window of its own, and the game running on the
 * computer. In a browser there is no such object, and every caller here falls
 * back to what the browser does.
 *
 * The shape is kept here as well as in `desktop/src/shared/bridge.ts` - the two
 * projects share no code. Detection checks the members it uses rather than
 * trusting that something with the right name is the app.
 */

import { z } from "zod";

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

/** Where installing on a TV has got to, as `desktop/src/shared/bridge.ts` names it. */
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

export interface PolarisDesktop {
    readonly version: string;
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
    /** The screens and windows to share, each with a small picture, for the
     *  picker this page draws. Null where the system's own picker is the one to
     *  use (macOS). Absent from an app older than the picker, which then shows
     *  its own dialog. `thumbnails: false` answers faster, with names only; an
     *  app older than that option ignores it and sends the pictures. */
    shareSources?(input?: { readonly thumbnails?: boolean }): Promise<DesktopShareSources | null>;
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
 *  finished, either way, and an agent session that needs its owner or ended on
 *  its own. The dashboard's bell still lists them as it always did. */
const DEPLOY_RESULTS = new Set(["deploy.succeeded", "deploy.failed", "agent.waiting", "agent.ended"]);

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
