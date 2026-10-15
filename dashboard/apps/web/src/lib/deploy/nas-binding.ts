/**
 * What a running service's NAS volumes are really bound to, read from inside it.
 *
 * A container's bind resolves once, when it starts. So after a share is mounted
 * again on the machine, a service started earlier is in one of three states, and
 * only two of them need a restart:
 *
 * - `share`: bound to the share and answering. It keeps the mount it started
 *   with, which is still alive - the case after an update recreated the host
 *   daemon, or after a session blip the kernel reconnected by itself. Restarting
 *   it would be downtime for nothing.
 * - `dead`: bound to a mount that no longer answers ("Host is down").
 * - `local`: not on a network filesystem at all - started while the share was
 *   not mounted, so it is writing into a folder on the machine's own disk.
 *
 * `unknown` is a service whose image cannot be asked (no `cat`, no `ls`); callers
 * treat it the way they did before this existed.
 */

import { withTimeout } from "@polaris/core";
import type { RuntimePorts } from "@polaris/deploy";

export type NasBinding = "share" | "dead" | "local" | "unknown";

/** What a path on a mount that died answers, in the words of the tools inside a
 *  container (coreutils and busybox) and of the kernel. */
export const DEAD_MOUNT =
    /host is down|stale file handle|transport endpoint is not connected|input\/output error|no such device|ehostdown|estale|enotconn/i;

/** Filesystem types a NAS share is mounted as. */
const NETWORK_FS = /^(cifs|smb3|smbfs|nfs|nfs4)$/;

const LOOK_WAIT_MS = 20_000;

function trimmed(path: string): string {
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The filesystem type mounted at each of `paths` in a `/proc/self/mountinfo`
 * table, or null where nothing is mounted at that exact path. The last line for a
 * path wins: it is the mount on top.
 */
export function mountTypes(table: string, paths: readonly string[]): Map<string, string | null> {
    const wanted = new Set(paths.map(trimmed));
    const types = new Map<string, string | null>([...wanted].map((path) => [path, null]));
    for (const line of table.split("\n")) {
        const fields = line.split(" ");
        const point = fields[4]?.replace(/\\040/g, " ");
        if (point === undefined || !wanted.has(point)) continue;
        const separator = fields.indexOf("-");
        const type = separator >= 0 ? fields[separator + 1] : undefined;
        if (type) types.set(point, type);
    }
    return types;
}

/** Whether a table says every path is bound to a network filesystem. */
export function boundToShare(table: string, paths: readonly string[]): boolean {
    for (const type of mountTypes(table, paths).values()) {
        if (type === null || !NETWORK_FS.test(type)) return false;
    }
    return true;
}

/** Ask a running service where its NAS volumes are. Never throws. */
export async function nasBinding(
    ports: Pick<RuntimePorts, "runIn">,
    container: string,
    paths: readonly string[]
): Promise<NasBinding> {
    if (paths.length === 0) return "share";
    let table: string | null = null;
    try {
        const result = await withTimeout(
            ports.runIn(container, ["cat", "/proc/self/mountinfo"]),
            LOOK_WAIT_MS,
            "the service did not answer in time"
        );
        if (result.code === 0) table = result.output;
    } catch {
        // No `cat`, or the service is not running: not an answer either way.
    }
    if (table !== null && !boundToShare(table, paths)) return "local";
    try {
        const result = await withTimeout(
            ports.runIn(container, ["ls", "-d", ...paths]),
            LOOK_WAIT_MS,
            "the service did not answer in time"
        );
        if (result.code !== 0 && DEAD_MOUNT.test(result.output)) return "dead";
        return table === null ? "unknown" : "share";
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (DEAD_MOUNT.test(message)) return "dead";
        return table === null ? "unknown" : "share";
    }
}
