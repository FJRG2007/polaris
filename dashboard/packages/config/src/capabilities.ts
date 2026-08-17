/**
 * Edition and capability model. The dashboard renders and authorizes against a
 * Capabilities object rather than branching on the edition directly, so a single
 * code path serves both editions and features simply appear, disappear, or badge
 * themselves. The edition is "full" only when the host daemon actually answered -
 * possession of a real, reachable daemon is the proof, never an env var.
 */

export type Edition = "limited" | "full";

/** What the host daemon reports it can actually do on this machine. */
export interface HostdCapabilityReport {
    readonly hostFilesystem: boolean;
    readonly nativeMounts: boolean;
    readonly docker: boolean;
    /** Whether the daemon can build/deploy containers (its deploy endpoints).
     *  Optional so an older daemon that predates it still parses; it then falls
     *  back to the docker flag. */
    readonly deploy?: boolean;
    readonly kubernetes: boolean;
    readonly systemd: boolean;
    readonly autoUpdate: boolean;
}

/** Response shape of the daemon's GET /v1/health. */
export interface HostdHealth {
    readonly version: string;
    readonly capabilities: HostdCapabilityReport;
}

export interface Capabilities {
    readonly edition: Edition;
    readonly hostd: { readonly present: boolean; readonly version?: string };
    readonly hostFilesystem: boolean;
    readonly nativeMounts: boolean;
    readonly docker: boolean;
    readonly deploy: boolean;
    readonly kubernetes: boolean;
    readonly systemd: boolean;
    readonly autoUpdate: boolean;
}

/** The safe default: a plain container with no host privileges. */
export const LIMITED_CAPABILITIES: Capabilities = {
    edition: "limited",
    hostd: { present: false },
    hostFilesystem: false,
    nativeMounts: false,
    docker: false,
    deploy: false,
    kubernetes: false,
    systemd: false,
    autoUpdate: false
};

export interface DeriveOptions {
    /** Operator kill-switch: even a capable daemon cannot enable auto-update if false. */
    readonly autoUpdateAllowed?: boolean;
}

/**
 * Fold a daemon health probe into the capability set. A null probe (daemon
 * absent, unreachable, or unauthorized) yields the limited edition; every host
 * capability is the AND of what the daemon reports and any local policy gate.
 */
export function deriveCapabilities(
    health: HostdHealth | null,
    options: DeriveOptions = {}
): Capabilities {
    if (!health) return LIMITED_CAPABILITIES;
    const autoUpdateAllowed = options.autoUpdateAllowed ?? true;
    const reported = health.capabilities;
    return {
        edition: "full",
        hostd: { present: true, version: health.version },
        hostFilesystem: reported.hostFilesystem,
        nativeMounts: reported.nativeMounts,
        docker: reported.docker,
        // Older daemons omit `deploy`; fall back to the docker flag they do send.
        deploy: reported.deploy ?? reported.docker,
        kubernetes: reported.kubernetes,
        systemd: reported.systemd,
        autoUpdate: reported.autoUpdate && autoUpdateAllowed
    };
}

/**
 * Server-side capability holder. The health probe (in @polaris/hostd-client)
 * refreshes it on an interval; server code reads the current snapshot and the
 * client receives it through a context provider. Never trust the client copy for
 * authorization - always re-check server-side.
 *
 * Held on the process rather than in this module, and that is not a detail. The
 * bundler gives this file to whoever imports it, and the built server ends up
 * with four separate copies of it: the probe that runs at startup fills in the
 * one in the instrumentation bundle, while a route handler reads a different one
 * that still says there is no daemon and never will. Everything gated on the
 * snapshot then quietly takes the limited path on a machine where the daemon is
 * running perfectly - which is how camera stills spent a day being read over a
 * userspace SMB client instead of the kernel mount sitting right there.
 *
 * A symbol from the global registry is shared by every copy, so there is one
 * answer per process however many times this module is instantiated.
 */
const HOLDER = Symbol.for("polaris.capabilities.current");

interface Holder {
    [HOLDER]?: Capabilities;
}

export function getCapabilities(): Capabilities {
    return (globalThis as Holder)[HOLDER] ?? LIMITED_CAPABILITIES;
}

export function setCapabilities(next: Capabilities): Capabilities {
    (globalThis as Holder)[HOLDER] = next;
    return next;
}
