/**
 * What the NVIDIA cards in a machine are doing, and which containers are using
 * them.
 *
 * One script answers both, read the same way on every machine: over SSH as part
 * of a server's probe, and through the host daemon for the machine Polaris runs
 * on (`crates/polaris-hostd/src/gpu.rs` carries the same script word for word,
 * and a test fails when the two drift). It prints nothing at all on a machine
 * without `nvidia-smi`, so a server with no card costs one `command -v` and
 * shows no GPU section.
 *
 * Each `nvidia-smi` call is cut off after ten seconds where `timeout` exists: a
 * wedged driver hangs it, and the probe around it has no deadline of its own.
 *
 * Only NVIDIA is read. AMD and Intel cards report through other tools with
 * other fields, and are left out rather than shown as an NVIDIA card would be.
 *
 * Lines rather than JSON, the same as the rest of the probe:
 *   gpu=<index>, <uuid>, <util %>, <mem used MiB>, <mem total MiB>, <temp C>, <power W>, <name>
 *   gpuproc=<gpu uuid>,<pid>,<used MiB>,<container id or empty>
 * The name goes last because it is the one field that may hold a comma.
 */

/** Most cards and processes a reading keeps, so a strange machine cannot
 *  produce an unbounded report. */
export const MAX_GPUS = 16;
export const MAX_GPU_PROCESSES = 256;

export const GPU_SCRIPT = `if command -v nvidia-smi >/dev/null 2>&1; then
t=; command -v timeout >/dev/null 2>&1 && t="timeout 10"
$t nvidia-smi --query-gpu=index,uuid,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,name --format=csv,noheader,nounits </dev/null 2>/dev/null | head -n 16 | while IFS= read -r line; do printf 'gpu=%s\\n' "$line"; done
$t nvidia-smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits </dev/null 2>/dev/null | head -n 256 | while IFS=', ' read -r uuid pid mem; do cid=$(grep -o -E '[0-9a-f]{64}' "/proc/$pid/cgroup" 2>/dev/null | head -n 1); printf 'gpuproc=%s,%s,%s,%s\\n' "$uuid" "$pid" "$mem" "$cid"; done
fi
`;

const MIB = 1024 * 1024;

/** One card, as `nvidia-smi` reports it. Every reading may be missing: a card
 *  answers `[N/A]` or `[Not Supported]` for what it cannot measure. */
export interface GpuReading {
    readonly index: number;
    readonly uuid: string;
    readonly name: string;
    readonly utilizationPercent: number | null;
    readonly memoryUsedBytes: number | null;
    readonly memoryTotalBytes: number | null;
    readonly temperatureC: number | null;
    readonly powerWatts: number | null;
}

/** A process holding memory on a card, and the container it runs in, if any. */
export interface GpuProcess {
    readonly gpuUuid: string;
    readonly pid: number;
    readonly memoryUsedBytes: number | null;
    /** Full 64-character container id, or null for a process on the host. */
    readonly containerId: string | null;
}

export interface GpuReport {
    readonly gpus: readonly GpuReading[];
    readonly processes: readonly GpuProcess[];
}

/** What a container is using, added up over every card it holds memory on. */
export interface ContainerGpuUsage {
    readonly memoryUsedBytes: number;
    /** The cards it is on, by uuid, in the order the machine numbers them. */
    readonly gpuUuids: readonly string[];
}

/** A reading `nvidia-smi` could not take is `[N/A]`, `[Not Supported]`, or
 *  nothing at all; every one of those is a missing number, never a zero. */
function reading(value: string | undefined): number | null {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.startsWith("[") || /^n\/?a$/i.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function mebibytes(value: string | undefined): number | null {
    const parsed = reading(value);
    return parsed === null ? null : Math.round(parsed * MIB);
}

function gpuLine(value: string): GpuReading | null {
    const parts = value.split(",");
    if (parts.length < 8) return null;
    const index = reading(parts[0]);
    const uuid = parts[1]?.trim() ?? "";
    if (index === null || !Number.isInteger(index) || !uuid) return null;
    return {
        index,
        uuid,
        name: parts.slice(7).join(",").trim() || "GPU",
        utilizationPercent: reading(parts[2]),
        memoryUsedBytes: mebibytes(parts[3]),
        memoryTotalBytes: mebibytes(parts[4]),
        temperatureC: reading(parts[5]),
        powerWatts: reading(parts[6])
    };
}

function processLine(value: string): GpuProcess | null {
    const [uuid, pid, memory, container] = value.split(",").map((part) => part.trim());
    const parsedPid = reading(pid);
    if (!uuid || parsedPid === null || !Number.isInteger(parsedPid)) return null;
    return {
        gpuUuid: uuid,
        pid: parsedPid,
        memoryUsedBytes: mebibytes(memory),
        containerId: container && /^[0-9a-f]{64}$/.test(container) ? container : null
    };
}

/** Read the script's lines out of any output, ignoring every other line. */
export function parseGpuReport(output: string): GpuReport {
    const gpus: GpuReading[] = [];
    const processes: GpuProcess[] = [];
    for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("gpu=") && gpus.length < MAX_GPUS) {
            const gpu = gpuLine(line.slice("gpu=".length));
            if (gpu && !gpus.some((known) => known.uuid === gpu.uuid)) gpus.push(gpu);
        } else if (line.startsWith("gpuproc=") && processes.length < MAX_GPU_PROCESSES) {
            const process = processLine(line.slice("gpuproc=".length));
            if (process) processes.push(process);
        }
    }
    gpus.sort((a, b) => a.index - b.index);
    return { gpus, processes };
}

/**
 * Each container's share of the cards, keyed by the id the engine knows it by.
 *
 * `containers` is what the engine listed on that machine; a process is matched
 * by its full id, or by the short id a listing sometimes gives instead. A process
 * that belongs to no listed container (one on the host, or in a container that
 * stopped between the two reads) is left out.
 */
export function gpuUsageByContainer(
    report: GpuReport,
    containers: readonly { id: string }[]
): Map<string, ContainerGpuUsage> {
    const order = new Map(report.gpus.map((gpu) => [gpu.uuid, gpu.index]));
    const usage = new Map<string, { memory: number; uuids: Set<string> }>();
    for (const process of report.processes) {
        if (!process.containerId) continue;
        const full = process.containerId;
        const container = containers.find(
            (entry) => entry.id === full || (entry.id.length >= 12 && full.startsWith(entry.id))
        );
        if (!container) continue;
        const held = usage.get(container.id) ?? { memory: 0, uuids: new Set<string>() };
        held.memory += process.memoryUsedBytes ?? 0;
        held.uuids.add(process.gpuUuid);
        usage.set(container.id, held);
    }
    const result = new Map<string, ContainerGpuUsage>();
    for (const [id, held] of usage) {
        result.set(id, {
            memoryUsedBytes: held.memory,
            gpuUuids: [...held.uuids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
        });
    }
    return result;
}

/** The machine's cards as one row of a chart: busy on average, memory and
 *  power added up, temperature of the hottest card. Null with no card. */
export interface GpuSummary {
    readonly utilizationPercent: number | null;
    readonly memoryUsedBytes: number | null;
    readonly memoryTotalBytes: number | null;
    readonly temperatureC: number | null;
    readonly powerWatts: number | null;
}

function present(values: (number | null)[]): number[] {
    return values.filter((value): value is number => value !== null);
}

export function summarizeGpus(gpus: readonly GpuReading[]): GpuSummary | null {
    if (gpus.length === 0) return null;
    const utilization = present(gpus.map((gpu) => gpu.utilizationPercent));
    const used = present(gpus.map((gpu) => gpu.memoryUsedBytes));
    const total = present(gpus.map((gpu) => gpu.memoryTotalBytes));
    const temperature = present(gpus.map((gpu) => gpu.temperatureC));
    const power = present(gpus.map((gpu) => gpu.powerWatts));
    const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
    return {
        utilizationPercent:
            utilization.length > 0
                ? Math.round((sum(utilization) / utilization.length) * 100) / 100
                : null,
        memoryUsedBytes: used.length > 0 ? sum(used) : null,
        memoryTotalBytes: total.length > 0 ? sum(total) : null,
        temperatureC: temperature.length > 0 ? Math.max(...temperature) : null,
        powerWatts: power.length > 0 ? Math.round(sum(power) * 100) / 100 : null
    };
}
