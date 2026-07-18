/**
 * Docker driver. A thin, typed wrapper over the Engine API for the operations
 * the Containers app needs: an overview of host/container consumption, a
 * container listing with live CPU/memory stats, and start/stop/restart controls.
 * It speaks to whatever transport it is given, so socket, SSH, and TCP hosts all
 * behave identically. Only non-streaming endpoints are used.
 */

import { httpOverStream } from "./http.js";
import type { DockerTransportConn } from "./transports.js";

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

export class DockerDriver {
    public constructor(private readonly conn: DockerTransportConn) {}

    private async request(method: string, path: string): Promise<{ status: number; body: string }> {
        const stream = await this.conn.stream();
        return httpOverStream(stream, { method, path });
    }

    private async json<T>(method: string, path: string): Promise<T> {
        const response = await this.request(method, path);
        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Docker API ${method} ${path} -> ${response.status}: ${response.body.slice(0, 200)}`);
        }
        return JSON.parse(response.body) as T;
    }

    public async dispose(): Promise<void> {
        await this.conn.close();
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
