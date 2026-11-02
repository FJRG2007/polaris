/**
 * What is running directly on a machine, outside any container: the part of its
 * memory a container engine cannot explain. Read over the server's own connection,
 * which is why a machine with none simply has no such rows.
 */

import { execCommand, openSshClient } from "@polaris/ssh";
import { getHostConnectionUnscoped } from "@/lib/host-service";

/** The width is asked for: left alone, ps cuts the control group before the id. */
const LIST = "ps -ww -eo rss=,cgroup:256=,comm=";
const READ_TIMEOUT_MS = 4_000;
const MAX_PROCESSES = 8;
/** A container's processes carry its 64-character id in their control group. The
 *  engine's own service does not, so it stays listed as what it is. */
const IN_CONTAINER = /[0-9a-f]{64}|kubepods/;

export interface MachineProcess {
    readonly name: string;
    readonly bytes: number;
}

/** The heaviest programs in a `ps` listing, every copy of one added together. */
export function parseProcesses(output: string): MachineProcess[] {
    const totals = new Map<string, number>();
    for (const line of output.split("\n")) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!match || IN_CONTAINER.test(match[2] as string)) continue;
        const name = match[3] as string;
        totals.set(name, (totals.get(name) ?? 0) + Number(match[1]) * 1024);
    }
    return [...totals]
        .filter(([, bytes]) => bytes > 0)
        .map(([name, bytes]) => ({ name, bytes }))
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, MAX_PROCESSES);
}

async function list(hostId: string): Promise<string> {
    const connection = await getHostConnectionUnscoped(hostId);
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        let said = "";
        await execCommand(client, LIST, {
            onStdout: (chunk) => {
                said += chunk.toString("utf8");
            }
        });
        return said;
    } finally {
        client.end();
    }
}

/** Empty when the machine cannot be asked: the rest of the list still stands. */
export async function machineProcesses(hostId: string): Promise<MachineProcess[]> {
    const late = new Promise<string>((resolve) => {
        setTimeout(() => resolve(""), READ_TIMEOUT_MS).unref();
    });
    return parseProcesses(await Promise.race([list(hostId).catch(() => ""), late]));
}
