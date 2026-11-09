/**
 * The container engine a container session lives on.
 *
 * A container session (`place: "local"`) used to mean "on this box": every call
 * reached the host daemon. Placement now spreads them over the servers an
 * administrator gave Polar Code (see `session-placement`), and the server is
 * stored on the session as `hostId`. No `hostId` is still this box.
 *
 * The server is read without an owner check for the reason `startOnHost` gives:
 * where a session runs was settled when it was placed, against the pool the
 * administrators chose, and asking again here would be checking the row
 * against itself.
 */

import { SshPorts } from "@/lib/deploy/ports-ssh";
import type { RuntimePorts } from "@polaris/deploy";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { getHostConnectionUnscoped } from "@/lib/host-service";

/** The engine for a container on `hostId`, or on this box when there is none. */
export async function containerPorts(hostId: string | null): Promise<RuntimePorts> {
    if (!hostId) return new HostdPorts();
    const host = await getHostConnectionUnscoped(hostId);
    return new SshPorts({
        address: host.address,
        port: host.port,
        username: host.username,
        auth: host.auth,
        hostKey: host.hostKey,
        hostId
    });
}

/** Run `work` against that engine and let go of its connection afterwards. */
export async function withContainerPorts<T>(
    hostId: string | null,
    work: (ports: RuntimePorts) => Promise<T>
): Promise<T> {
    const ports = await containerPorts(hostId);
    try {
        return await work(ports);
    } finally {
        await Promise.resolve(ports.dispose?.()).catch(() => undefined);
    }
}

/** Whether a session's container is running, stopped or gone, on either
 *  engine. Both answer it; the shared interface does not name it. */
export function containerState(
    ports: RuntimePorts,
    ref: string
): Promise<"running" | "stopped" | "gone"> {
    const engine = ports as Partial<Pick<HostdPorts, "containerState">>;
    if (typeof engine.containerState === "function") return engine.containerState(ref);
    throw new Error("This engine cannot say whether a container is running.");
}
