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
 */
let current: Capabilities = LIMITED_CAPABILITIES;

export function getCapabilities(): Capabilities {
    return current;
}

export function setCapabilities(next: Capabilities): Capabilities {
    current = next;
    return current;
}
