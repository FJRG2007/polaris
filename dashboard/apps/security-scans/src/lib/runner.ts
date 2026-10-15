/**
 * Running the one-off containers: a compose spec on any server through its
 * runtime ports, and a host action through the local daemon or over SSH.
 *
 * Server-only.
 */

import { host } from "@polaris/app-host";
import { HostdClient } from "@polaris/hostd-client";
import { openSshClient, execCommand } from "@polaris/ssh";
import { hostArgv, type HostAction } from "../model/specs";
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
const TIMEOUT_MS = 3 * 60 * 60_000;

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
 *  take it down. The project's own volumes (the caches) stay. */
export async function runOneShot(
    ports: RuntimePorts,
    spec: ComposeSpec
): Promise<{ exitCode: number; log: string }> {
    const name = spec.services[0]!.name;
    await ports.composeDown(spec.project).catch(() => undefined);
    await ports.composeUp(spec);
    const started = Date.now();
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
            if (Date.now() - started > TIMEOUT_MS) throw new ScanFailure("timeout");
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
        if (result === "busy") throw new ScanFailure("busy");
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
