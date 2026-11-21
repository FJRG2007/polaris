/**
 * What the Polaris phone app adds to the page it hosts (`window.polarisMobile`,
 * `mobile/android/.../PageBridge.java`). Every method is optional: an older app
 * has fewer of them, and a browser has none.
 *
 * Client-only.
 */

import type { DesktopOutcome, DesktopVpnStatus, PolarisDesktop } from "@/lib/desktop-bridge";

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
    /** Live location run by the app's own foreground service until the given
     *  moment (epoch ms), so it keeps moving with the page closed. */
    startLiveLocation?(untilMs: number): void;
    stopLiveLocation?(): void;
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
