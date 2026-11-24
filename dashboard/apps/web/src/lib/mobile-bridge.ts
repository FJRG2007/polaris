/**
 * What the Polaris phone app adds to the page it hosts (`window.polarisMobile`,
 * `mobile/android/.../PageBridge.java`). Every method is optional: an older app
 * has fewer of them, and a browser has none.
 *
 * Client-only.
 */

import * as core from "@polaris/core/app-settings";
import type { DesktopHosts, DesktopOutcome, DesktopVpnStatus, PolarisDesktop } from "@/lib/desktop-bridge";

interface PolarisMobileBridge {
    platform?(): string;
    version?(): string;
    /** "camera" or "gallery" for the file the last picker returned, else "". */
    lastPickSource?(): string;
    /** The phone's gallery for chat's "+" sheet; used through `lib/mobile-media.ts`. */
    canMedia?(): boolean;
    mediaCall?(id: string, op: string, args: string): void;
    canViewOnce?(): boolean;
    openViewOnce?(attachmentId: string): void;
    /** Keep the screen out of screenshots and recordings while on: Android's
     *  secure window; iOS blanks the page while the screen is being recorded or
     *  mirrored. Absent from an app older than the feature. */
    protectScreen?(on: boolean): void;
    /** Hand a web or mail address to the phone's browser or mail app. */
    openExternal?(url: string): void;
    /** The VPN, run by the app itself. Absent from an app older than the feature. */
    canVpn?(): boolean;
    vpnDeviceName?(): string;
    vpnKey?(): string;
    /** Answers later, through `window.__polarisMobileVpn(id, error)`. */
    vpnUp?(id: string, input: string): void;
    vpnDown?(id: string): void;
    vpnStatus?(): string;
    /** Whether the screen has a back of its own; the app hands its back gesture to
     *  the page while it does. Called by useSwipeBack in `@polaris/ui`. */
    swipeBack?(available: boolean): void;
    /** The app's own settings: its servers, notifications, language, version. */
    changeServer?(): void;
    /** What Settings > This app draws, as JSON (`readPhoneAppSettings`). Absent
     *  from an app older than the feature, which keeps its own screen only. */
    appSettings?(): string;
    /** Open one of the screens its General category lists (`APP_PHONE_ACTIONS`). */
    appSettingsAction?(action: string): void;
    /** The servers the app keeps, managed in Settings > This app > Hosts: `op`
     *  is list, check, add, switch, edit, remove, status, link, copy, export or
     *  import. Answers later, through `window.__polarisMobileHosts(id, json)`,
     *  shaped as the desktop app's. Absent from an app that manages them in its
     *  own screen only. */
    hostsCall?(id: string, op: string, args: string): void;
    /** A check for a newer build; answers later, through
     *  `window.__polarisMobileUpdate(id, json)`. */
    checkForUpdates?(id: string): void;
    /** Live location run by the app's own foreground service until the given
     *  moment (epoch ms), so it keeps moving with the page closed. */
    startLiveLocation?(untilMs: number): void;
    stopLiveLocation?(): void;
    /** The season the page decorates with ("" for none): the app's launcher
     *  icon wears it. Absent from an app older than the feature. */
    setSeasonIcon?(season: string): void;
    /** The same, with whether the season is Polaris's own calendar's: the app
     *  keeps one per server and settles them by `appIconSeason`'s rule, so two
     *  servers never take turns on the icon. Absent from an older app. */
    reportSeasonIcon?(season: string, official: boolean): void;
}

/**
 * Name the season the page decorates with to the phone app, which dresses its
 * launcher icon in it; null asks for the plain icon. Does nothing in a browser
 * or in an app too old to, which keeps its plain icon.
 */
export function phoneSeasonIcon(season: string | null, official = false): void {
    const app = bridge();
    try {
        if (typeof app?.reportSeasonIcon === "function") app.reportSeasonIcon(season ?? "", official);
        else if (typeof app?.setSeasonIcon === "function") app.setSeasonIcon(season ?? "");
    } catch {
        // The app keeps the icon it has.
    }
}

/**
 * Hand live location to the phone app, which keeps sending it with the screen
 * off. Null stops it. Answers false in a browser and in an app too old to, where
 * the page sends it itself while it is open.
 */
export function phoneLiveLocation(untilMs: number | null): boolean {
    const app = bridge();
    if (!app?.startLiveLocation || !app.stopLiveLocation) return false;
    try {
        if (untilMs === null) app.stopLiveLocation();
        else app.startLiveLocation(untilMs);
        return true;
    } catch {
        return false;
    }
}

/** The VPN the same shape the desktop app gives it, so the VPN page has one way to connect. */
export type PhoneVpn = NonNullable<PolarisDesktop["vpn"]>;

function bridge(): PolarisMobileBridge | null {
    if (typeof window === "undefined") return null;
    const found = (window as unknown as { polarisMobile?: PolarisMobileBridge }).polarisMobile;
    return found ?? null;
}

/** Whether this page runs inside the phone app. */
export function inPhoneApp(): boolean {
    return bridge() !== null;
}

/** Whether this app can open a view-once file. False in a browser and in an app too old to. */
export function canViewOnce(): boolean {
    try {
        return bridge()?.canViewOnce?.() === true;
    } catch {
        return false;
    }
}

/** Open a view-once file in the app's own protected screen. */
export function openViewOnce(attachmentId: string): boolean {
    const found = bridge();
    if (!found?.openViewOnce || !canViewOnce()) return false;
    found.openViewOnce(attachmentId);
    return true;
}

/** How many screens asked for protection: two open viewers, one closed, keep it on. */
let protecting = 0;

/**
 * Ask the phone app to keep the screen out of screenshots and recordings for as
 * long as something private is open (a profile photo shown full size). Returns
 * the release. Does nothing in a browser, where no page can stop a screenshot,
 * and in an app too old to.
 */
export function protectScreen(): () => void {
    const found = bridge();
    if (typeof found?.protectScreen !== "function") return () => undefined;
    protecting += 1;
    if (protecting === 1) {
        try {
            found.protectScreen(true);
        } catch {
            // An app that cannot: the photo still opens.
        }
    }
    let released = false;
    return () => {
        if (released) return;
        released = true;
        protecting -= 1;
        if (protecting > 0) return;
        try {
            found.protectScreen?.(false);
        } catch {
            // Gone with the page.
        }
    };
}

/**
 * Open an outside address in the phone's own browser or mail app. False in a
 * browser and in an app too old to, so the caller opens it the web's way.
 */
export function openExternal(url: string): boolean {
    const found = bridge();
    if (typeof found?.openExternal !== "function") return false;
    try {
        found.openExternal(url);
        return true;
    } catch {
        return false;
    }
}

/** Where the last picked file came from, when the app knows. */
export function lastPickSource(): "camera" | "gallery" | null {
    try {
        const source = bridge()?.lastPickSource?.();
        return source === "camera" || source === "gallery" ? source : null;
    } catch {
        return null;
    }
}

/** How long a connect may take before the page stops waiting: the app waits up to 12 s for the server. */
const VPN_WAIT_MS = 60_000;
const VPN_EVENT = "polaris-mobile-vpn";

type VpnWindow = Window & { __polarisMobileVpn?: (id: string, error: string) => void };

const waiting = new Map<string, (outcome: DesktopOutcome) => void>();
let requests = 0;

function vpnRequest(send: (id: string) => void): Promise<DesktopOutcome> {
    const target = window as VpnWindow;
    target.__polarisMobileVpn ??= (id, error) => {
        const resolve = waiting.get(id);
        waiting.delete(id);
        resolve?.(error ? { ok: false, error } : { ok: true });
    };
    requests += 1;
    const id = `vpn-${requests}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            waiting.delete(id);
            resolve({ ok: false, error: "failed" });
        }, VPN_WAIT_MS);
        waiting.set(id, (outcome) => {
            window.clearTimeout(timer);
            resolve(outcome);
        });
        try {
            send(id);
        } catch {
            waiting.delete(id);
            window.clearTimeout(timer);
            resolve({ ok: false, error: "failed" });
        }
    });
}

function vpnStatus(found: PolarisMobileBridge): DesktopVpnStatus {
    try {
        const parsed = JSON.parse(found.vpnStatus?.() ?? "{}") as { nodeId?: unknown };
        return { nodeId: typeof parsed.nodeId === "string" ? parsed.nodeId : null };
    } catch {
        return { nodeId: null };
    }
}

/** This phone's VPN, or null in a browser and in an app too old to run one. */
export function phoneVpn(): PhoneVpn | null {
    const found = bridge();
    try {
        if (!found?.canVpn?.() || !found.vpnUp || !found.vpnDown || !found.vpnKey) return null;
    } catch {
        return null;
    }
    const app = found as Required<PolarisMobileBridge>;
    return {
        deviceName: async () => app.vpnDeviceName(),
        key: async () => app.vpnKey() || null,
        up: (input) => vpnRequest((id) => app.vpnUp(id, JSON.stringify(input))),
        down: () => vpnRequest((id) => app.vpnDown(id)),
        status: async () => vpnStatus(app),
        // Private networks are joined from a computer.
        joinNetwork: async () => ({ ok: false, error: "unsupported" })
    };
}

/** Calls `listener` whenever the phone's tunnel goes up or down, the Quick Settings tile included. */
export function onPhoneVpnChange(listener: () => void): () => void {
    if (typeof window === "undefined") return () => undefined;
    window.addEventListener(VPN_EVENT, listener);
    return () => window.removeEventListener(VPN_EVENT, listener);
}

/** Whether this app has a settings screen of its own to open. */
export function hasAppSettings(): boolean {
    return typeof bridge()?.changeServer === "function";
}

/** Open the app's own settings screen. False in a browser. */
export function openAppSettings(): boolean {
    const found = bridge();
    if (typeof found?.changeServer !== "function") return false;
    try {
        found.changeServer();
        return true;
    } catch {
        return false;
    }
}

/**
 * The phone app's own settings as Settings > This app reads them: every read
 * is the app's answer from the phone (no network), every action a screen of
 * the app or of the phone. Null in a browser and in an app too old to.
 */
export interface PhoneAppSettings {
    read(): core.AppPhoneSnapshot | null;
    open(action: core.AppPhoneAction): boolean;
    /** The app's own screen for its servers, where they are added and changed. */
    manageHosts(): boolean;
    checkForUpdates(): Promise<core.AppPhoneUpdateCheck>;
}

/** Whether this app draws its settings in Settings > This app. */
export function hasPhoneAppSettings(): boolean {
    return typeof bridge()?.appSettings === "function";
}

/** How long a check may take before the page stops waiting: the app gives up on the releases after 10 s. */
const UPDATE_WAIT_MS = 30_000;

type UpdateWindow = Window & { __polarisMobileUpdate?: (id: string, json: string) => void };

const checking = new Map<string, (answer: core.AppPhoneUpdateCheck) => void>();

function updateRequest(found: PolarisMobileBridge): Promise<core.AppPhoneUpdateCheck> {
    const target = window as UpdateWindow;
    target.__polarisMobileUpdate ??= (id, json) => {
        const resolve = checking.get(id);
        checking.delete(id);
        resolve?.(core.readPhoneUpdateCheck(json));
    };
    requests += 1;
    const id = `update-${requests}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            checking.delete(id);
            resolve({ kind: "failed" });
        }, UPDATE_WAIT_MS);
        checking.set(id, (answer) => {
            window.clearTimeout(timer);
            resolve(answer);
        });
        try {
            found.checkForUpdates?.(id);
        } catch {
            checking.delete(id);
            window.clearTimeout(timer);
            resolve({ kind: "failed" });
        }
    });
}

export function phoneAppSettings(): PhoneAppSettings | null {
    const found = bridge();
    if (typeof found?.appSettings !== "function") return null;
    return {
        read: () => {
            try {
                return core.readPhoneAppSettings(found.appSettings?.());
            } catch {
                return null;
            }
        },
        open: (action) => {
            if (typeof found.appSettingsAction !== "function") return false;
            try {
                found.appSettingsAction(action);
                return true;
            } catch {
                return false;
            }
        },
        manageHosts: openAppSettings,
        checkForUpdates: () =>
            typeof found.checkForUpdates === "function"
                ? updateRequest(found)
                : Promise.resolve({ kind: "failed" } as const)
    };
}

/** How long a hosts call may take before the page stops waiting: an address is probed for up to 15 s. */
const HOSTS_WAIT_MS = 45_000;
/** The largest file "Open a file" reads, as the app's own import did. */
const HOSTS_FILE_MAX = 64 * 1024;

type HostsWindow = Window & { __polarisMobileHosts?: (id: string, json: string) => void };

const hostCalls = new Map<string, (answer: unknown) => void>();

/** One hosts call; null for no answer, which the desktop readers take as a refusal. */
function hostsRequest(found: PolarisMobileBridge, op: string, args: Record<string, string> = {}): Promise<unknown> {
    const target = window as HostsWindow;
    target.__polarisMobileHosts ??= (id, json) => {
        const resolve = hostCalls.get(id);
        hostCalls.delete(id);
        try {
            resolve?.(JSON.parse(json));
        } catch {
            resolve?.(null);
        }
    };
    requests += 1;
    const id = `hosts-${requests}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            hostCalls.delete(id);
            resolve(null);
        }, HOSTS_WAIT_MS);
        hostCalls.set(id, (answer) => {
            window.clearTimeout(timer);
            resolve(answer);
        });
        try {
            found.hostsCall?.(id, op, JSON.stringify(args));
        } catch {
            hostCalls.delete(id);
            window.clearTimeout(timer);
            resolve(null);
        }
    });
}

/** A file somebody picks, read as text; null when cancelled, "" when too big or unreadable. */
function pickText(): Promise<string | null> {
    return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.addEventListener("cancel", () => resolve(null));
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            if (file.size > HOSTS_FILE_MAX) return resolve("");
            void file.text().then(resolve, () => resolve(""));
        });
        input.click();
    });
}

/**
 * The servers this phone keeps, in the desktop app's shape so Settings > This
 * app > Hosts draws both with one screen. Null in a browser and in an app that
 * manages them in its own screen only.
 */
export function phoneHosts(): DesktopHosts | null {
    const found = bridge();
    if (typeof found?.hostsCall !== "function") return null;
    // One object per bridge, so the screen does not read the list again on every render.
    if (madeHosts?.found !== found) madeHosts = { found, hosts: makePhoneHosts(found) };
    return madeHosts.hosts;
}

let madeHosts: { found: PolarisMobileBridge; hosts: DesktopHosts } | null = null;

function makePhoneHosts(found: PolarisMobileBridge): DesktopHosts {
    const call = (op: string, args?: Record<string, string>) => hostsRequest(found, op, args);
    return {
        list: () => call("list"),
        check: (address) => call("check", { address }),
        add: (address, name) => call("add", { address, name }),
        switchTo: (origin) => call("switch", { origin }),
        edit: (origin, address, name) => call("edit", { origin, address, name }),
        remove: (origin) => call("remove", { origin }),
        status: (origin) => call("status", { origin }),
        link: () => call("link"),
        copy: () => call("copy"),
        exportFile: () => call("export"),
        importFile: async () => {
            const text = await pickText();
            if (text === null) return { ok: false, error: null };
            return text ? call("import", { text }) : { ok: false, error: "" };
        },
        importText: (text) => call("import", { text })
    };
}
