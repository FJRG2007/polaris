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
import { getHostConnectionUnscoped } from "@/lib/host-service";
import { RELEASE_LABEL, parseReclaimedBytes } from "@polaris/deploy";

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
    const said = await onServer(hostId, DF_ROOT);
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
 * How many bytes are free on a server's root filesystem, or null where it could
 * not be asked.
 *
 * The other half of `serverDiskFullness`, and the one a prune is measured with:
 * a proportion cannot say how much room a sweep handed back, and the number the
 * prune itself prints is not always there to read.
 */
export function freeBytesFromDf(said: string): number | null {
    const line = said
        .split("\n")
        .map((row) => row.trim())
        .filter((row) => row !== "")
        .at(-1);
    if (!line) return null;
    // device, 1024-blocks, used, available, capacity%, mount
    const available = Number(line.split(/\s+/)[3]);
    return Number.isFinite(available) ? available * 1024 : null;
}

async function serverFreeBytes(hostId: string): Promise<number | null> {
    const said = await onServer(hostId, DF_ROOT);
    return said === null ? null : freeBytesFromDf(said);
}

/**
 * Every engine a server might be running its containers with, asked in one pass.
 *
 * A machine Polaris deploys to is not necessarily a Docker machine, and until
 * this it was treated as one: the sweep ran `docker system prune` and nothing
 * else, so a host running containerd through k3s or nerdctl was swept by a
 * command it does not have. It reported nothing freed, correctly, and the disk
 * went on filling until a pull failed on a rename inside a content store nothing
 * had ever pruned.
 *
 * Each is guarded by whether it is installed, so the ones that are not cost a
 * `command -v`, and each failure is swallowed: a machine that will not prune is
 * one the caller needs "nothing freed" from rather than an exception. The line
 * every one of them is held to is the same as here and on Polaris' own box -
 * build cache and images no container is on. Never a volume: those are usually
 * the largest thing on the disk and every byte is somebody's database, save file
 * or footage.
 */
/** How the free space on a machine is asked for. `-P` for the POSIX output
 *  format, without which a long device name wraps onto its own line and the
 *  columns move. */
export const DF_ROOT = "df -P /";

/**
 * The Docker line leaves pinned release images alone. `-a` takes every image no
 * container is on, and an image kept so a service can be rolled back to it is
 * exactly that - so without the filter, every deploy's tidy-up would delete the
 * versions the deploy before it had just kept. Polaris removes those itself, one
 * by one, as they fall out of the kept window (see `release-image`).
 */
export const PRUNE_EVERY_ENGINE = [
    `if command -v docker >/dev/null 2>&1; then docker system prune -af --filter 'label!=${RELEASE_LABEL}' || true; docker builder prune -af || true; fi`,
    "if command -v nerdctl >/dev/null 2>&1; then nerdctl system prune -af || true; fi",
    // cri-tools, which is what a Kubernetes-shaped host prunes images with. k3s
    // ships it as a subcommand rather than on the path, so both spellings are
    // tried and neither is required.
    "if command -v crictl >/dev/null 2>&1; then crictl rmi --prune || true; elif command -v k3s >/dev/null 2>&1; then k3s crictl rmi --prune || true; fi"
].join("; ");

/**
 * Hand back the room nothing is using on a server.
 *
 * Measured with `df` on either side rather than read off what the prune printed.
 * Only some of these engines print a total at all - `crictl` lists the images it
 * removed and says nothing about bytes - so a sweep that worked would have
 * reported freeing nothing, which is the answer that decides whether a failed
 * deploy is worth trying again. What the disk says is true whichever ran.
 *
 * Null means the server could not be reached at all, which is a different answer
 * from "nothing to free" and must never be read as one.
 */
export async function reclaimServerSpace(hostId: string): Promise<number | null> {
    const before = await serverFreeBytes(hostId);
    const said = await onServer(hostId, PRUNE_EVERY_ENGINE);
    if (said === null) return null;
    const after = await serverFreeBytes(hostId);
    if (before !== null && after !== null && after > before) return after - before;
    // No `df` on this machine, or a disk that moved under the measurement. What
    // the prune printed, where it printed anything.
    return parseReclaimedBytes(said);
}
