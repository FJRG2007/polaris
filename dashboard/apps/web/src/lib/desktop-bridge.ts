/**
 * The Polaris desktop app, seen from the page it opens.
 *
 * The app (`desktop/` at the repository root) loads this dashboard in a window of
 * its own and puts one object on the page, `window.polarisDesktop`, for the
 * things a browser tab cannot do: notices drawn by the operating system, a
 * folder zipped straight from the disk, a build pushed from the computer's own
 * Docker, a page opened in a window of its own. In a browser there is no such
 * object, and every caller here falls back to what the browser does.
 *
 * The shape is kept here as well as in `desktop/src/shared/bridge.ts` - the two
 * projects share no code. Detection checks the members it uses rather than
 * trusting that something with the right name is the app.
 */

export type DesktopOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type DesktopFolder =
    | { readonly ok: true; readonly name: string; readonly files: number; readonly zip: Uint8Array }
    | { readonly ok: false; readonly error: string }
    | null;

export interface PolarisDesktop {
    readonly version: string;
    readonly platform: string;
    notify(input: {
        readonly title: string;
        readonly body?: string;
        readonly tag: string;
        readonly href?: string;
        readonly insistent?: boolean;
    }): Promise<boolean>;
    closeNotice(tag: string): Promise<void>;
    pickFolder(): Promise<DesktopFolder>;
    pushLocal(input: {
        readonly serviceId: string;
        readonly name: string;
        readonly href?: string;
    }): Promise<DesktopOutcome>;
    openWindow(input: { readonly path: string; readonly title: string }): Promise<DesktopOutcome>;
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
 *  finished, either way. The dashboard's bell still lists them as it always did. */
const DEPLOY_RESULTS = new Set(["deploy.succeeded", "deploy.failed"]);

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
