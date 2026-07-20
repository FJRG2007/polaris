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

export interface ContainerRow {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    cpuPercent: number | null;
    memUsage: number | null;
    memPercent: number | null;
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
