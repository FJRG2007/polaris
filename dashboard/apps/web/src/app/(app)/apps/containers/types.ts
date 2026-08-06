/** Client-safe shapes for the Containers view. */

import type { DockerTransport } from "@polaris/docker/schema";

export interface DockerConnectionSummary {
    id: string;
    name: string;
    transport: DockerTransport;
    status: string;
    /** The auto-provisioned local host (brokered by hostd). Not deletable. */
    local?: boolean;
    /** A global Host (managed in the Servers app), reached over SSH. Not
     *  deletable from here. */
    host?: boolean;
}

/** Why the auto-provisioned local Docker host is not available, shown to admins
 *  so a missing local host is diagnosable instead of a silent empty state. */
export interface LocalHostDiagnostic {
    edition: string;
    hostdPresent: boolean;
    hostdVersion?: string;
    dockerReported: boolean;
    /** Human-readable cause + remedy. */
    reason: string;
}

export interface ContainerRow {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    cpuPercent: number | null;
    memUsage: number | null;
    memPercent: number | null;
    /** When the usage on this row was sampled. Null for a container nothing has
     *  sampled yet, and for one that is not running. */
    statsAt: number | null;
}

/** What /api/containers answers with for one host. `canAttach` is whether this
 *  connection can open an interactive console at all. */
export interface HostSnapshot {
    overview: OverviewData;
    containers: ContainerRow[];
    canAttach: boolean;
    /** When the usage figures were sampled. Null when none has been taken yet -
     *  the listing is on screen and the first sample is on its way. An instant
     *  rather than an age, so it stays true in a snapshot held between visits. */
    statsAt: number | null;
}

/** What /api/containers/stats answers with: one sample and when it was taken.
 *  Both null for a container that is not running. */
export interface ContainerUsageReply {
    stats: ContainerUsage | null;
    at: number | null;
}

/** What /api/containers/host answers with: the engine, named, and nothing about
 *  its containers. The counts and totals are the same shape the listing uses;
 *  the two aggregate fields are zero here because nothing was sampled. */
export interface HostInfo {
    overview: OverviewData;
    canAttach: boolean;
}

/** One live sample for one container, as /api/containers/stats answers. The
 *  byte counters are cumulative since the container started, not rates. */
export interface ContainerUsage {
    cpuPercent: number;
    memUsage: number;
    memLimit: number;
    memPercent: number;
    netRx: number;
    netTx: number;
    blockRead: number;
    blockWrite: number;
}

/** Everything one container's page shows about how it was set up. `sizeRw` and
 *  `sizeRootFs` are present only when the inspect asked for them. */
export interface ContainerDetailData {
    id: string;
    name: string;
    image: string;
    state: string;
    createdAt: string;
    startedAt: string | null;
    restartCount: number;
    command: string;
    ports: Array<{ container: string; host: string | null }>;
    mounts: Array<{ source: string; destination: string; rw: boolean }>;
    networks: string[];
    env: string[];
    composeProject: string | null;
    sizeRw: number | null;
    sizeRootFs: number | null;
}

export interface OverviewData {
    name: string;
    serverVersion: string;
    containers: number;
    running: number;
    stopped: number;
    images: number;
    ncpu: number;
    memTotal: number;
    aggregateCpuPercent: number;
    aggregateMemUsage: number;
}
