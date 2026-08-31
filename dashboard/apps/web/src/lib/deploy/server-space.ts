/**
 * Keeping an ENROLLED SERVER's disk from filling, the way Polaris already keeps
 * its own from filling.
 *
 * `host-space.ts` next door does this for the box Polaris runs on, through the
 * host daemon. It takes no host argument and never could: every call in it goes
 * to the local daemon. So for as long as it has existed, a machine somebody
 * connected to Polaris and deploys to has been pruned by nothing, ever - while
 * the same deployments pull a new `:latest` on every release and leave the layers
 * of the one they replaced behind.
 *
 * The end of that is a pull that fails on a rename inside the content store,
 * which is the single least legible way a disk can tell you it is full, followed
 * by a message asking the operator to go and tidy the machine themselves. That is
 * the chore-with-a-deadline this module exists to abolish, one machine further
 * out than the module that already abolished it here.
 *
 * Same line as the local sweep, drawn for the same reason: build cache and images
 * no container is on. Never volumes - they are usually the largest thing on the
 * disk and every byte is somebody's database, save file or footage.
 *
 * Server-only. Safe to re-run.
 */

import { prisma } from "@polaris/db";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { parseReclaimedBytes } from "@polaris/deploy";
import { getHostConnectionUnscoped } from "@/lib/host-service";

/** How much of a command's output is kept. A prune prints a line per layer it
 *  removes, and only the total at the end is read. */
const MAX_OUTPUT = 200_000;

/** A server Polaris deploys to, and therefore one whose disk is partly Polaris's
 *  doing. */
export interface DeployServer {
    readonly id: string;
    readonly name: string;
}

/**
 * The servers worth sweeping: the ones something is actually deployed to.
 *
 * A machine enrolled for a terminal or for Drive holds none of Polaris's images
 * and has no business being pruned by it - what is on that disk is the operator's
 * own, and a housekeeping pass that reached it would be Polaris tidying somebody
 * else's house.
 */
export async function serversWithDeployments(): Promise<DeployServer[]> {
    const targets = await prisma.deployTarget.findMany({
        where: { kind: "host", hostId: { not: null } },
        select: { hostId: true },
        distinct: ["hostId"]
    });
    const ids = targets.map((target) => target.hostId as string);
    if (ids.length === 0) return [];
    const hosts = await prisma.host.findMany({
        where: { id: { in: ids }, status: "active" },
        select: { id: true, name: true }
    });
    return hosts;
}

/** Run one command on a server, keeping what it printed. Null when the machine
 *  could not be reached at all, which is a different answer from "it said
 *  nothing" and must not be read as a disk with no room on it. */
async function onServer(hostId: string, command: string): Promise<string | null> {
    let connection;
    try {
        connection = await getHostConnectionUnscoped(hostId);
    } catch {
        return null;
    }
    let lease;
    try {
        lease = await borrowSsh("exec", connection.id, {
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey
        });
    } catch {
        return null;
    }
    try {
        let said = "";
        const keep = (chunk: Buffer): void => {
            if (said.length < MAX_OUTPUT) said += chunk.toString("utf8");
        };
        await execCommand(lease.client, command, { onStdout: keep, onStderr: keep });
        return said;
    } catch {
        return null;
    } finally {
        lease.release();
    }
}

/**
 * How full a server's disk is, 0 to 1, or null where it could not be asked.
 *
 * Read at the filesystem root rather than at the container store's own path.
 * Which path that is depends on the engine - `/var/lib/docker` for Docker,
 * `/var/lib/containerd` for containerd, somewhere else again for a machine with
 * a separate volume for it - and on almost every one of these they are the same
 * filesystem anyway. Asking about the root is the question that has an answer on
 * all of them.
 *
 * `-P` for the POSIX output format: without it a long device name wraps onto its
 * own line and the columns move.
 */
export async function serverDiskFullness(hostId: string): Promise<number | null> {
    const said = await onServer(hostId, "df -P /");
    if (!said) return null;
    const line = said
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== "")
        .at(-1);
    if (!line) return null;
    const columns = line.split(/\s+/);
    // device, 1024-blocks, used, available, capacity%, mount
    const used = Number(columns[2]);
    const available = Number(columns[3]);
    if (!Number.isFinite(used) || !Number.isFinite(available)) return null;
    const total = used + available;
    return total > 0 ? used / total : null;
}

/**
 * Hand back the room nothing is using on a server.
 *
 * Both prunes run even when the first frees nothing - they hold different things
 * - and neither failing is fatal: this is called because a disk is tight, and a
 * machine that will not prune is one the caller needs "nothing freed" from rather
 * than an exception. Null means the server could not be reached at all.
 */
export async function reclaimServerSpace(hostId: string): Promise<number | null> {
    const said = await onServer(hostId, "docker builder prune -f; docker image prune -af");
    return said === null ? null : parseReclaimedBytes(said);
}
