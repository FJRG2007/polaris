/** Shapes shared by the Servers table, its dialogs, and the status poll. */

import type { ServerEnvironment } from "@polaris/core";

export interface ServerRow {
    /** "local" for the Polaris box, otherwise the Host id. */
    id: string;
    kind: "local" | "host";
    name: string;
    /** The SSH user for a registered host, empty for the local box - whose machine
     *  name arrives with the status poll rather than blocking the page. */
    detail: string;
    address: string;
    port: number | null;
    authMethod: string | null;
    /** Whether Polaris may act as root here, which decides whether a root shell
     *  and a root file view are offered. */
    sudo: boolean;
    /** The Host backing this row. Null for the local box until it has been enrolled;
     *  once it has, the local row carries the host it resolved to and gains
     *  everything a registered server can do. */
    hostId: string | null;
    environment: ServerEnvironment;
    /** Wildcard domain pointed at this server, empty when none is configured. */
    wildcardDomain: string;
    /** What Polaris detected, offered as the default when the environment is unset. */
    suggested: ServerEnvironment;
    /** False while the value is only Polaris's guess, not the operator's answer. */
    confirmed: boolean;
}

/** One server's reachability, as /api/servers/status reports it. */
export interface ServerStatus {
    id: string;
    state: "up" | "down";
    /** Handshake round trip in milliseconds; null for the local box. */
    latencyMs: number | null;
    detail: string | null;
}

export interface ServerStatusPayload {
    servers: ServerStatus[];
    /** What the local machine calls itself. */
    machineName: string;
}
