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
    /** When the oldest of the usage figures was sampled. Null while any running
     *  container is still unsampled - the listing is on screen, the totals do
     *  not add up yet and the reading is on its way. An instant rather than an
     *  age, so it stays true in a snapshot held between visits. */
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

/** One volume a part of Polaris keeps its data in. */
export interface FootprintVolume {
    readonly name: string;
    /** Where the container sees it, which is what was measured. */
    readonly path: string;
    /** Null when it could not be measured: a stopped container has nothing to ask. */
    readonly usedBytes: number | null;
}

/** One part of Polaris and what it is using. */
export interface FootprintPart {
    readonly id: string;
    readonly name: string;
    readonly label: string;
    readonly summary: string;
    readonly image: string;
    readonly state: string;
    /** Null for a part that is not running, which uses neither. */
    readonly cpuPercent: number | null;
    readonly memUsedBytes: number | null;
    /** What it has written since it started, on top of its image. */
    readonly writableBytes: number | null;
    /** What its image occupies. Shared between containers of the same image, so
     *  the total below counts each image once rather than once per container. */
    readonly imageBytes: number | null;
    readonly volumes: readonly FootprintVolume[];
}

/** Polaris' whole footprint on the machine it runs on, as /api/polaris/footprint
 *  answers. Measured by `lib/polaris-footprint`; the shape lives here because the
 *  card that renders it runs in the browser, and that module reaches the Docker
 *  engine. */
export interface PolarisFootprint {
    readonly parts: readonly FootprintPart[];
    /** Memory the running parts hold right now, and what the machine has. */
    readonly memUsedBytes: number;
    readonly memTotalBytes: number | null;
    readonly cpuPercent: number;
    /** Disk, split the three ways it is actually spent. Images are counted once
     *  each however many containers run them. */
    readonly imageBytes: number;
    readonly writableBytes: number;
    readonly volumeBytes: number;
    /** Whether every volume answered. False means the disk figures are a floor
     *  rather than a total, and the panel says so rather than quietly under-
     *  reporting. */
    readonly diskComplete: boolean;
    readonly at: string;
}

/** Everything Polaris occupies on disk, which is the three figures added up. */
export function footprintDiskBytes(footprint: PolarisFootprint): number {
    return footprint.imageBytes + footprint.writableBytes + footprint.volumeBytes;
}
