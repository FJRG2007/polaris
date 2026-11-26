/**
 * Which Polaris app a request comes from, and whether it is too old for sealed
 * chat (docs/chat-e2ee-mls.md, "Client readiness"; owner decision 5 in
 * docs/chat-e2ee-proposal.md section 13: no plaintext copy for old clients -
 * an app that has not been updated says "update" instead).
 *
 * Every Polaris app draws chat from this dashboard's own page, so the page an
 * old app shows is already new; what the app itself adds is the native key
 * store that seals the account key's device lock (docs/chat-e2ee-phase1.md,
 * "Native key stores"). An app from before it would keep that lock in the
 * WebView's profile only, so it is held back from sealed chat rather than
 * quietly run weaker.
 *
 * Read from the User-Agent, the one thing every app already sends on every
 * request: the Android and iOS apps append `PolarisMobile/<version> (Android)`
 * or `(iOS)` (`AppAgent.java`, `WebViewController.swift`), and the desktop
 * app keeps Electron's default agent, which names the app and its version
 * (`Polaris/<version> ... Electron/<version>`). Anything else - a browser, an
 * agent this cannot read - is not an app and is never held back: a guess
 * never locks anybody out.
 */

export type PolarisApp = "desktop" | "android" | "ios";

/**
 * The first version of each app that carries what sealed chat needs from it.
 * Sourced from the release history, not chosen: the native key store landed in
 * commit caa836866b (2026-11-23), first shipped in `desktop-v0.1.56` and
 * `android-v0.1.15`; the iOS app was at 0.1.3 then, so its first build with it
 * is 0.1.4 (not yet in the App Store). A later client change that sealed chat
 * comes to depend on raises its row here, and nowhere else.
 */
export const SEALED_CHAT_MINIMUM: Readonly<Record<PolarisApp, string>> = {
    desktop: "0.1.56",
    android: "0.1.15",
    ios: "0.1.4"
};

export interface PolarisAppVersion {
    readonly app: PolarisApp;
    readonly version: string;
}

export interface OutdatedApp extends PolarisAppVersion {
    readonly minimum: string;
}

/** Longer than any agent a Polaris app sends; the rest is not read. */
const AGENT_MOST = 1024;
const VERSION = "(\\d{1,6}(?:\\.\\d{1,6}){0,3})";
const MOBILE = new RegExp(String.raw`(?:^|\s)PolarisMobile/${VERSION}(?:\s+\((Android|iOS)\))?`);
const DESKTOP = new RegExp(String.raw`(?:^|\s)Polaris/${VERSION}\s`);
const ELECTRON = /(?:^|\s)Electron\/\d/;

/** The Polaris app named by a User-Agent, or null for anything that is not one. */
export function polarisAppOf(userAgent: string | null | undefined): PolarisAppVersion | null {
    if (!userAgent) return null;
    const agent = userAgent.slice(0, AGENT_MOST);
    const mobile = MOBILE.exec(agent);
    // An Android build from before the platform was named in the agent sent the bare token.
    if (mobile?.[1]) return { app: mobile[2] === "iOS" ? "ios" : "android", version: mobile[1] };
    const desktop = ELECTRON.test(agent) ? DESKTOP.exec(agent) : null;
    if (desktop?.[1]) return { app: "desktop", version: desktop[1] };
    return null;
}

/** Numeric, part by part; a missing part is 0, so "0.1" equals "0.1.0". */
export function compareVersions(left: string, right: string): number {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

/** The app behind this agent when it is older than sealed chat needs, else null. */
export function sealedAppOutdated(userAgent: string | null | undefined): OutdatedApp | null {
    const found = polarisAppOf(userAgent);
    if (!found) return null;
    const minimum = SEALED_CHAT_MINIMUM[found.app];
    return compareVersions(found.version, minimum) < 0 ? { ...found, minimum } : null;
}
