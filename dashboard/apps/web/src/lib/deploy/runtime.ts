/**
 * Runtime selection: turn a stored DeployTarget into the ports (local host daemon
 * or remote SSH) and the engine driver (compose today, swarm in a later phase)
 * the deploy pipeline runs against. One place decides local-vs-remote and
 * compose-vs-swarm, so the pipeline stays engine- and location-agnostic.
 */

import { SshPorts } from "./ports-ssh";
import { HostdPorts } from "./ports-hostd";
import { getHostConnection } from "../host-service";
import { ComposeRuntime, SwarmRuntime, type DeployTargetInfo, type RuntimeDriver, type RuntimePorts } from "@polaris/deploy";

/** The subset of a DeployTarget row the runtime needs. */
export interface TargetRow {
    readonly id: string;
    readonly kind: string;
    readonly hostId: string | null;
    readonly runtime: string;
    readonly proxyNetwork: string;
}

/**
 * Ports for a target: the host daemon locally, or SSH for a remote Host.
 *
 * `signal` binds them to the lifetime of whatever they are serving, so a cancelled
 * deploy stops the command it was running instead of only recording that it stopped.
 * Both backends carry it the same way: the work runs on the other side of a
 * connection, and that side ends the command when the connection does.
 */
export async function getPorts(target: TargetRow, ownerId: string, signal?: AbortSignal): Promise<RuntimePorts> {
    if (target.kind === "local" || !target.hostId) return new HostdPorts(signal);
    const connection = await getHostConnection(target.hostId, ownerId);
    return new SshPorts(
        {
            address: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            hostKey: connection.hostKey
        },
        signal
    );
}

/** The engine driver for a target: swarm where the target opted into it, else the
 *  plain-compose runtime. Both satisfy the same interface. */
export function getDriver(target: TargetRow): RuntimeDriver {
    return target.runtime === "swarm" ? new SwarmRuntime() : new ComposeRuntime();
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
