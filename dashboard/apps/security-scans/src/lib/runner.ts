/**
 * Running the one-off containers: a compose spec on any server through its
 * runtime ports, and a host action through the local daemon or over SSH.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { HostdClient } from "@polaris/hostd-client";
import { openSshClient, execCommand } from "@polaris/ssh";
import {
    exportArgv,
    hasRoom,
    hostArgv,
    LIST_EXPORTS_ARGV,
    parseDfFree,
    type HostAction
} from "../model/specs";
import { parseContainerState, quoteArgv, type ComposeSpec, type RuntimePorts } from "@polaris/deploy";

/** The server a scan runs on, as the runtime needs it. */
export interface ScanTarget {
    readonly id: string;
    readonly ownerId: string;
    readonly kind: string;
    readonly hostId: string | null;
    readonly runtime: string;
    readonly proxyNetwork: string;
}

/** Most of a container's output that is read. A large inventory is a few MB. */
const MAX_LOG = 64 * 1024 * 1024;
const POLL_MS = 3_000;
/** A scan that has not ended in this long is stopped and failed. */
export const TIMEOUT_MS = 3 * 60 * 60_000;

export class ScanFailure extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

export async function portsFor(target: ScanTarget): Promise<RuntimePorts> {
    return host.deployRuntime.getPorts(target, target.ownerId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function logsOf(ports: RuntimePorts, name: string): Promise<string> {
    const parts: Buffer[] = [];
    let size = 0;
    await ports
        .logs(name, (chunk) => {
            const buffer = Buffer.from(chunk);
            if (size >= MAX_LOG) return;
            size += buffer.length;
            parts.push(buffer);
        })
        .catch(() => undefined);
    return Buffer.concat(parts).toString("utf8");
}

/** Bring a one-off container up, wait for it to exit, read what it printed and
 *  take it down. The project's own volumes (the caches) stay. A container
 *  still running at `deadline` (epoch ms) is stopped and the scan failed. */
export async function runOneShot(
    ports: RuntimePorts,
    spec: ComposeSpec,
    deadline = Date.now() + TIMEOUT_MS
): Promise<{ exitCode: number; log: string }> {
    const name = spec.services[0]!.name;
    await ports.composeDown(spec.project).catch(() => undefined);
    await ports.composeUp(spec);
    let missing = 0;
    try {
        for (;;) {
            await sleep(POLL_MS);
            const state = parseContainerState(await ports.inspect(name).catch(() => null));
            if (state.status === "exited" || state.status === "dead") {
                return { exitCode: state.exitCode ?? -1, log: await logsOf(ports, name) };
            }
            if (state.status === "unknown" && ++missing >= 5) throw new ScanFailure("lost");
            if (state.status !== "unknown") missing = 0;
            if (Date.now() > deadline) throw new ScanFailure("timeout");
        }
    } finally {
        await ports.composeDown(spec.project).catch(() => undefined);
    }
}

/** Run a host action on a server: the local daemon's fixed endpoint, or the
 *  same `docker run` over SSH as an argument list quoted word by word. */
export async function runHostAction(
    target: ScanTarget,
    action: HostAction
): Promise<{ exitCode: number; output: string }> {
    if (target.kind === "local" || !target.hostId) {
        const result = await new HostdClient().hostSecurity(action);
        if (result === null) throw new ScanFailure("daemonOutdated");
        if (result === "busy" || result === "timeout") throw new ScanFailure(result);
        return result;
    }
    const connection = await host.hostService.getHostConnection(target.hostId, target.ownerId);
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        const parts: Buffer[] = [];
        let size = 0;
        const result = await execCommand(client, quoteArgv(hostArgv(action)), {
            onStdout: (chunk) => {
                if (size >= MAX_LOG) return;
                size += chunk.length;
                parts.push(chunk);
            }
        });
        return { exitCode: result.code, output: Buffer.concat(parts).toString("utf8") };
    } finally {
        client.end();
    }
}

type SshClient = Awaited<ReturnType<typeof openSshClient>>;

/** Run one command over an open SSH client, keeping what it printed. */
async function sshRun(client: SshClient, command: string): Promise<{ code: number; output: string }> {
    const parts: Buffer[] = [];
    const result = await execCommand(client, command, {
        onStdout: (chunk) => void parts.push(chunk)
    });
    return { code: result.code, output: Buffer.concat(parts).toString("utf8") };
}

async function withSsh<T>(target: ScanTarget, work: (client: SshClient) => Promise<T>): Promise<T> {
    const connection = await host.hostService.getHostConnection(target.hostId!, target.ownerId);
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        return await work(client);
    } finally {
        client.end();
    }
}

/**
 * Save the image an app runs into `volume` as `/in/image.tar`, after checking
 * the disk has room for it. Locally the daemon does it; over SSH the same
 * commands run, each an argument list quoted word by word.
 */
export async function exportImage(target: ScanTarget, image: string, volume: string): Promise<void> {
    if (target.kind === "local" || !target.hostId) {
        const result = await new HostdClient().hostImageExport(image, volume);
        if (result === null) throw new ScanFailure("daemonOutdated");
        if (typeof result === "string") throw new ScanFailure(result);
        return;
    }
    const argv = exportArgv(image, volume);
    await withSsh(target, async (client) => {
        const size = await sshRun(client, quoteArgv(argv.size));
        const bytes = Number(size.output.trim());
        if (size.code !== 0 || !Number.isSafeInteger(bytes)) throw new ScanFailure("imageMissing");
        const free = await sshRun(client, quoteArgv(argv.free));
        const room = parseDfFree(free.output);
        if (free.code !== 0 || room === null) throw new ScanFailure("scanError");
        if (!hasRoom(bytes, room)) throw new ScanFailure("noRoom");
        // A pipe's status is its last command's, so a save that failed part way
        // is caught by reading the archive back rather than by the pipe.
        const save = await sshRun(client, `${quoteArgv(argv.save)} | ${quoteArgv(argv.write)}`);
        const check = await sshRun(client, quoteArgv(argv.check));
        if (save.code !== 0 || check.code !== 0) throw new ScanFailure("scanError");
    });
}

/** The export volumes on a server; null when it cannot be asked. */
export async function listExports(target: ScanTarget): Promise<string[] | null> {
    if (target.kind === "local" || !target.hostId) return new HostdClient().hostImageExports();
    return withSsh(target, async (client) => {
        const result = await sshRun(client, quoteArgv(LIST_EXPORTS_ARGV));
        return result.code === 0 ? result.output.split("\n") : null;
    });
}

/** Remove an export volume and the archive in it. */
export async function removeExport(target: ScanTarget, volume: string): Promise<void> {
    if (target.kind === "local" || !target.hostId) {
        await new HostdClient().hostImageRemove(volume);
        return;
    }
    await withSsh(target, async (client) => {
        const result = await sshRun(client, quoteArgv(exportArgv("unused", volume).remove));
        if (result.code !== 0) throw new Error(`volume removal exited ${result.code}`);
    });
}
