/**
 * Runtime selection: turn a stored DeployTarget into the ports (local host daemon
 * or remote SSH) and the engine driver (compose today, swarm in a later phase)
 * the deploy pipeline runs against. One place decides local-vs-remote and
 * compose-vs-swarm, so the pipeline stays engine- and location-agnostic.
 */

import { ComposeRuntime, type DeployTargetInfo, type RuntimeDriver, type RuntimePorts } from "@polaris/deploy";
import { getHostConnection } from "../host-service";
import { HostdPorts } from "./ports-hostd";
import { SshPorts } from "./ports-ssh";

/** The subset of a DeployTarget row the runtime needs. */
export interface TargetRow {
    readonly id: string;
    readonly kind: string;
    readonly hostId: string | null;
    readonly runtime: string;
    readonly proxyNetwork: string;
}

/** Ports for a target: the host daemon locally, or SSH for a remote Host. */
export async function getPorts(target: TargetRow, ownerId: string): Promise<RuntimePorts> {
    if (target.kind === "local" || !target.hostId) return new HostdPorts();
    const connection = await getHostConnection(target.hostId, ownerId);
    return new SshPorts({
        address: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        hostKey: connection.hostKey
    });
}

/** The engine driver for a target. Swarm lands in a later phase; until then every
 *  target runs on the compose runtime. */
export function getDriver(_target: TargetRow): RuntimeDriver {
    return new ComposeRuntime();
}

/** Immutable target descriptor passed into the runtime context. */
export function toTargetInfo(target: TargetRow, ip?: string): DeployTargetInfo {
    return {
        id: target.id,
        kind: target.kind === "host" ? "host" : "local",
        engine: target.runtime === "swarm" ? "swarm" : "compose",
        proxyNetwork: target.proxyNetwork,
        ip
    };
}
