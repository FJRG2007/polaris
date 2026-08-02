/**
 * Docker driver. A thin, typed wrapper over the Engine API for the operations
 * the Containers app needs: an overview of host/container consumption, a
 * container listing with live CPU/memory stats, lifecycle and removal, recent
 * logs, a one-shot exec (which is how the file browser lists and reads), and an
 * interactive exec for the console. It speaks to whatever transport it is given,
 * so socket, SSH, and TCP hosts all behave identically.
 *
 * Every read is bounded: a log is tail-limited, a one-shot exec is size-capped.
 * The interactive exec is the only open-ended stream, and it needs a transport
 * that can hijack its connection - `canAttach` says whether this one can.
 */

import type { Duplex } from "node:stream";
import type { DockerRpc } from "./rpc.js";

export interface DockerInfo {
    readonly name: string;
    readonly serverVersion: string;
    readonly containers: number;
    readonly containersRunning: number;
    readonly containersStopped: number;
    readonly images: number;
    readonly ncpu: number;
    readonly memTotal: number;
}

export interface ContainerSummary {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly state: string;
    readonly status: string;
}

export interface ContainerStats {
    readonly cpuPercent: number;
    readonly memUsage: number;
    readonly memLimit: number;
    readonly memPercent: number;
}

/** The parts of a container inspect the details panel shows. */
export interface ContainerDetail {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly state: string;
    readonly status: string;
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly restartCount: number;
    readonly command: string;
    readonly ports: ReadonlyArray<{ readonly container: string; readonly host: string | null }>;
    readonly mounts: ReadonlyArray<{ readonly source: string; readonly destination: string; readonly rw: boolean }>;
    readonly networks: readonly string[];
    readonly env: readonly string[];
    /** The compose project this container belongs to, when it has one. */
    readonly composeProject: string | null;
}

/** What a one-shot exec reported. `code` is null when the engine did not give
 *  one back, which a caller treats as a failure rather than as success. */
export interface ExecResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** An open interactive exec: the duplex carries the session both ways. */
export interface AttachedExec {
    readonly stream: Duplex;
    resize(cols: number, rows: number): Promise<void>;
    close(): void;
}

/** Cap on what a one-shot exec may report back. The file browser's `ls` and a
 *  previewed file are both well under this; a runaway command is truncated
 *  rather than buffered without limit. */
const EXEC_MAX_OUTPUT = 4 * 1024 * 1024;

export class DockerDriver {
    public constructor(private readonly rpc: DockerRpc) {}

    /** Whether this connection can open an interactive exec. A daemon-brokered
     *  local host cannot; every direct byte-stream transport can. */
    public get canAttach(): boolean {
        return typeof this.rpc.hijack === "function";
    }

    private async request(method: string, path: string, body?: string): Promise<{ status: number; bytes: Buffer; body: string }> {
        return this.rpc.request(method, path, body);
    }

    private async json<T>(method: string, path: string, body?: string): Promise<T> {
        const response = await this.request(method, path, body);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Docker API ${method} ${path} -> ${response.status}: ${response.body.slice(0, 200)}`);
        }
        return JSON.parse(response.body) as T;
    }

    public async dispose(): Promise<void> {
        await this.rpc.dispose();
    }

    /** True if the Engine answers /_ping. Used to validate a new connection. */
    public async ping(): Promise<boolean> {
        try {
            const response = await this.request("GET", "/_ping");
            return response.status === 200;
        } catch {
            return false;
        }
    }

    public async info(): Promise<DockerInfo> {
        const raw = await this.json<Record<string, unknown>>("GET", "/info");
        return {
            name: String(raw.Name ?? "docker"),
            serverVersion: String(raw.ServerVersion ?? ""),
            containers: Number(raw.Containers ?? 0),
            containersRunning: Number(raw.ContainersRunning ?? 0),
            containersStopped: Number(raw.ContainersStopped ?? 0),
            images: Number(raw.Images ?? 0),
            ncpu: Number(raw.NCPU ?? 0),
            memTotal: Number(raw.MemTotal ?? 0)
        };
    }

    public async listContainers(all = true): Promise<ContainerSummary[]> {
        const raw = await this.json<Array<Record<string, unknown>>>(
            "GET",
            `/containers/json?all=${all ? 1 : 0}`
        );
        return raw.map((entry) => {
            const names = (entry.Names as string[] | undefined) ?? [];
            return {
                id: String(entry.Id ?? ""),
                name: (names[0] ?? "").replace(/^\//, "") || String(entry.Id ?? "").slice(0, 12),
                image: String(entry.Image ?? ""),
                state: String(entry.State ?? ""),
                status: String(entry.Status ?? "")
            };
        });
    }

    /** Live CPU/memory for one container (single sample, non-streaming). */
    public async stats(id: string): Promise<ContainerStats> {
        const raw = await this.json<Record<string, unknown>>(
            "GET",
            `/containers/${encodeURIComponent(id)}/stats?stream=false`
        );
        return computeStats(raw);
    }

    public async start(id: string): Promise<void> {
        await this.lifecycle(id, "start");
    }

    public async stop(id: string): Promise<void> {
        await this.lifecycle(id, "stop");
    }

    public async restart(id: string): Promise<void> {
        await this.lifecycle(id, "restart");
    }

    private async lifecycle(id: string, action: "start" | "stop" | "restart"): Promise<void> {
        const response = await this.request("POST", `/containers/${encodeURIComponent(id)}/${action}`);
        // 204 = done, 304 = already in the desired state.
        if (response.status !== 204 && response.status !== 304) {
            throw new Error(`Docker ${action} failed (${response.status}): ${response.body.slice(0, 200)}`);
        }
    }

    /** Everything a details panel shows about one container. */
    public async inspect(id: string): Promise<ContainerDetail> {
        const raw = await this.json<Record<string, any>>("GET", `/containers/${encodeURIComponent(id)}/json`);
        const state = (raw.State ?? {}) as Record<string, any>;
        const config = (raw.Config ?? {}) as Record<string, any>;
        const networks = ((raw.NetworkSettings?.Networks ?? {}) as Record<string, unknown>);
        const bindings = ((raw.NetworkSettings?.Ports ?? {}) as Record<string, Array<Record<string, string>> | null>);
        return {
            id: String(raw.Id ?? id),
            name: String(raw.Name ?? "").replace(/^\//, ""),
            image: String(config.Image ?? raw.Image ?? ""),
            state: String(state.Status ?? ""),
            status: state.Running ? "running" : String(state.Status ?? ""),
            createdAt: String(raw.Created ?? ""),
            startedAt: state.StartedAt ? String(state.StartedAt) : null,
            restartCount: Number(raw.RestartCount ?? 0),
            command: [config.Entrypoint, config.Cmd].flat().filter(Boolean).join(" "),
            ports: Object.entries(bindings).map(([container, hostBindings]) => ({
                container,
                host: hostBindings?.[0] ? `${hostBindings[0].HostIp || "0.0.0.0"}:${hostBindings[0].HostPort}` : null
            })),
            mounts: ((raw.Mounts ?? []) as Array<Record<string, unknown>>).map((mount) => ({
                source: String(mount.Source ?? mount.Name ?? ""),
                destination: String(mount.Destination ?? ""),
                rw: Boolean(mount.RW)
            })),
            networks: Object.keys(networks),
            // Values are dropped: an env list is where secrets live, and the panel
            // only needs to say which knobs a container was given.
            env: ((config.Env ?? []) as string[]).map((entry) => entry.split("=")[0] ?? entry),
            composeProject: (config.Labels ?? {})["com.docker.compose.project"] ?? null
        };
    }

    /**
     * The last `tail` lines of a container's output. Non-TTY containers frame
     * stdout and stderr into the same stream, so the reply is de-multiplexed
     * before it is handed back; a TTY container sends raw bytes and passes
     * through untouched.
     */
    public async logs(id: string, tail = 200): Promise<string> {
        const lines = Math.min(Math.max(Math.trunc(tail), 1), 5000);
        // Timestamped, to match what the host daemon's own logs endpoint returns -
        // a log that changes shape depending on which host it came from is worse
        // than one that is always a little more verbose.
        const path = `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${lines}`;
        const response = await this.request("GET", path);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Docker logs failed (${response.status}): ${response.body.slice(0, 200)}`);
        }
        return demultiplex(response.bytes).toString("utf8");
    }

    /** Remove a container. Anonymous volumes go with it only when asked. */
    public async remove(id: string, options: { force?: boolean; volumes?: boolean } = {}): Promise<void> {
        const query = `force=${options.force ? 1 : 0}&v=${options.volumes ? 1 : 0}`;
        const response = await this.request("DELETE", `/containers/${encodeURIComponent(id)}?${query}`);
        if (response.status !== 204) {
            throw new Error(`Docker remove failed (${response.status}): ${response.body.slice(0, 200)}`);
        }
    }

    /**
     * Run a command inside a container and collect what it said. Used for the
     * file browser (`ls`, `cat`), so stdout and stderr are kept apart: a listing
     * must never be polluted by a diagnostic, and a non-zero exit needs a reason.
     */
    public async exec(id: string, argv: readonly string[]): Promise<ExecResult> {
        const created = await this.json<{ Id?: string }>(
            "POST",
            `/containers/${encodeURIComponent(id)}/exec`,
            JSON.stringify({ AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: argv })
        );
        if (!created.Id) throw new Error("Docker did not create the exec");

        const started = await this.request(
            "POST",
            `/exec/${encodeURIComponent(created.Id)}/start`,
            JSON.stringify({ Detach: false, Tty: false })
        );
        if (started.status < 200 || started.status >= 300) {
            throw new Error(`Docker exec failed (${started.status}): ${started.body.slice(0, 200)}`);
        }
        const streams = demultiplexStreams(started.bytes.subarray(0, EXEC_MAX_OUTPUT));
        const inspected = await this.json<{ ExitCode?: number | null }>(
            "GET",
            `/exec/${encodeURIComponent(created.Id)}/json`
        );
        return {
            code: inspected.ExitCode ?? null,
            stdout: streams.stdout.toString("utf8"),
            stderr: streams.stderr.toString("utf8")
        };
    }

    /**
     * Open an interactive exec and hand back the duplex carrying it. Only a
     * transport that can hijack its connection supports this; the caller checks
     * `canAttach` first, because a connection without it needs an entirely
     * different route to a console rather than a degraded version of this one.
     */
    public async attach(id: string, argv: readonly string[]): Promise<AttachedExec> {
        if (!this.rpc.hijack) throw new Error("This connection cannot open an interactive session");
        const created = await this.json<{ Id?: string }>(
            "POST",
            `/containers/${encodeURIComponent(id)}/exec`,
            JSON.stringify({ AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true, Cmd: argv })
        );
        if (!created.Id) throw new Error("Docker did not create the exec");

        const execId = created.Id;
        const hijacked = await this.rpc.hijack(
            "POST",
            `/exec/${encodeURIComponent(execId)}/start`,
            JSON.stringify({ Detach: false, Tty: true })
        );
        if (hijacked.status !== 101 && hijacked.status !== 200) {
            hijacked.stream.destroy();
            throw new Error(`Docker exec start failed (${hijacked.status})`);
        }
        return {
            stream: hijacked.stream,
            resize: async (cols, rows) => {
                await this.request(
                    "POST",
                    `/exec/${encodeURIComponent(execId)}/resize?w=${Math.trunc(cols)}&h=${Math.trunc(rows)}`
                ).catch(() => undefined);
            },
            close: () => hijacked.stream.destroy()
        };
    }
}

/**
 * Docker frames a non-TTY stream as repeating 8-byte headers (stream id, then a
 * big-endian payload length) followed by the payload. A TTY stream has no
 * framing at all, so a buffer whose first byte is not a valid stream id is
 * passed through as-is rather than being mangled by a decoder that assumed
 * framing.
 */
function demultiplexStreams(buffer: Buffer): { stdout: Buffer; stderr: Buffer } {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const kind = buffer[offset];
        if (kind !== 0 && kind !== 1 && kind !== 2) return { stdout: buffer, stderr: Buffer.alloc(0) };
        const size = buffer.readUInt32BE(offset + 4);
        const start = offset + 8;
        const payload = buffer.subarray(start, Math.min(start + size, buffer.length));
        (kind === 2 ? stderr : stdout).push(payload);
        offset = start + size;
    }
    // Nothing consumed means the reply was never framed (a TTY container).
    if (offset === 0 && buffer.length > 0) return { stdout: buffer, stderr: Buffer.alloc(0) };
    return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

/** Both framed streams merged in arrival order, for a log view that shows what
 *  the container printed rather than which descriptor it used. */
function demultiplex(buffer: Buffer): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset + 8 <= buffer.length) {
        const kind = buffer[offset];
        if (kind !== 0 && kind !== 1 && kind !== 2) return buffer;
        const size = buffer.readUInt32BE(offset + 4);
        const start = offset + 8;
        parts.push(buffer.subarray(start, Math.min(start + size, buffer.length)));
        offset = start + size;
    }
    if (offset === 0 && buffer.length > 0) return buffer;
    return Buffer.concat(parts);
}

/** Derive CPU percent and memory usage from a raw stats sample (Docker's formula). */
function computeStats(raw: Record<string, unknown>): ContainerStats {
    const cpu = (raw.cpu_stats ?? {}) as Record<string, Record<string, number>>;
    const precpu = (raw.precpu_stats ?? {}) as Record<string, Record<string, number>>;
    const cpuDelta = (cpu.cpu_usage?.total_usage ?? 0) - (precpu.cpu_usage?.total_usage ?? 0);
    const systemDelta = (cpu.system_cpu_usage as unknown as number ?? 0) - (precpu.system_cpu_usage as unknown as number ?? 0);
    const onlineCpus =
        (cpu.online_cpus as unknown as number) ||
        (cpu.cpu_usage?.percpu_usage as unknown as number[] | undefined)?.length ||
        1;
    const cpuPercent =
        systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;

    const memory = (raw.memory_stats ?? {}) as Record<string, number> & { stats?: Record<string, number> };
    const cache = memory.stats?.cache ?? 0;
    const memUsage = Math.max(0, (memory.usage ?? 0) - cache);
    const memLimit = memory.limit ?? 0;
    const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

    return {
        cpuPercent: Math.round(cpuPercent * 100) / 100,
        memUsage,
        memLimit,
        memPercent: Math.round(memPercent * 100) / 100
    };
}
