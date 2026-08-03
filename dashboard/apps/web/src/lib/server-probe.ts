/**
 * What Polaris asks a server about itself, and how it reads the answer.
 *
 * Kept apart from the SSH and database work in `server-metrics-service` for one
 * practical reason: this half has no dependencies, so the script can be printed
 * and run against a real machine, and the parser can be exercised against real
 * output, without standing up Prisma or a connection.
 *
 * Everything here is best effort. A machine without `docker`, without `/proc`, or
 * with a `ps` that refuses the flags still answers with the fields it could fill
 * in - a server is not unreachable because one number is missing, and a panel that
 * says "unknown" for one value beats one that says nothing for all of them.
 */

/** Consumers are ranked and cut here rather than in the UI, so the session carries
 *  a screenful instead of every process on a busy machine. */
const CONSUMER_LIMIT = 8;

/** One thing running on the server, and what it is costing. */
export interface ServerConsumer {
    readonly name: string;
    /** A container the engine knows about, or an ordinary process. */
    readonly kind: "container" | "process";
    readonly cpuPercent: number | null;
    readonly memoryBytes: number | null;
}

export interface ServerMetrics {
    /** As the machine words it: "Ubuntu 24.04.1 LTS", "macOS 15.3". */
    readonly os: string | null;
    readonly kernel: string | null;
    readonly cpuCount: number | null;
    /** One-minute load average. Divided by `cpuCount` it is the number a person
     *  actually wants, which the UI does rather than the probe. */
    readonly loadAverage: number | null;
    readonly memoryTotalBytes: number | null;
    readonly memoryUsedBytes: number | null;
    readonly diskTotalBytes: number | null;
    readonly diskUsedBytes: number | null;
    /** Heaviest first. Containers and processes ranked together, because the
     *  question is what is eating the machine, not what kind of thing it is. */
    readonly consumers: readonly ServerConsumer[];
    readonly probedAt: string;
}

/**
 * The probe. Written as one script rather than a series of commands so the whole
 * report costs a single exec, and emitting `key=value` lines rather than JSON
 * because a shell that has to quote JSON correctly on both Linux and macOS is a
 * shell that will eventually emit something unparseable.
 */
export const PROBE = `
emit() { [ -n "$2" ] && printf '%s=%s\\n' "$1" "$2"; }

if [ -r /etc/os-release ]; then
    . /etc/os-release 2>/dev/null || true
    emit os "\${PRETTY_NAME:-\${NAME:-}}"
elif command -v sw_vers >/dev/null 2>&1; then
    emit os "$(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"
else
    emit os "$(uname -s 2>/dev/null)"
fi

emit kernel "$(uname -r 2>/dev/null)"

if command -v nproc >/dev/null 2>&1; then
    emit cpus "$(nproc 2>/dev/null)"
elif command -v sysctl >/dev/null 2>&1; then
    emit cpus "$(sysctl -n hw.ncpu 2>/dev/null)"
fi

if [ -r /proc/loadavg ]; then
    emit load "$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
elif command -v sysctl >/dev/null 2>&1; then
    # "{ 1.20 1.30 1.40 }" - the first number is the one-minute average.
    emit load "$(sysctl -n vm.loadavg 2>/dev/null | awk '{ print \$2 }')"
fi

if [ -r /proc/meminfo ]; then
    # Available, not free: free counts the page cache as gone, which reports a
    # healthy machine as nearly out of memory.
    emit mem_total "$(awk '/^MemTotal:/ { print \$2 * 1024; exit }' /proc/meminfo)"
    emit mem_available "$(awk '/^MemAvailable:/ { print \$2 * 1024; exit }' /proc/meminfo)"
elif command -v sysctl >/dev/null 2>&1; then
    emit mem_total "$(sysctl -n hw.memsize 2>/dev/null)"
    emit mem_available "$(vm_stat 2>/dev/null | awk '
        /page size of/ { size = \$8 }
        /Pages free/ { free = \$3 }
        /Pages inactive/ { inactive = \$3 }
        END { if (size) printf "%.0f", (free + inactive) * size }')"
fi

DISK=$(df -k / 2>/dev/null | awk 'NR == 2 { print \$2 " " \$3 }')
emit disk_total "$(echo "\$DISK" | awk '{ print \$1 * 1024 }')"
emit disk_used "$(echo "\$DISK" | awk '{ print \$2 * 1024 }')"

if command -v docker >/dev/null 2>&1; then
    docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' 2>/dev/null \\
        | head -${CONSUMER_LIMIT} \\
        | while IFS= read -r line; do printf 'container=%s\\n' "\$line"; done
fi

# Two spellings: GNU ps takes --sort, BSD ps (macOS) takes -r for the same thing.
{ ps -eo pcpu,rss,comm --sort=-pcpu 2>/dev/null || ps -A -o pcpu,rss,comm -r 2>/dev/null; } \\
    | awk 'NR > 1 && NR <= ${CONSUMER_LIMIT} + 1 { printf "process=%s\\t%s\\t%s\\n", \$1, \$2, \$3 }'
`;

/** Turn the probe's lines into the report, ignoring anything it did not recognize. */
export function parseProbe(output: string): ServerMetrics {
    const fields = new Map<string, string>();
    const consumers: ServerConsumer[] = [];

    for (const line of output.split("\n")) {
        const separator = line.indexOf("=");
        if (separator < 1) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (!value) continue;
        if (key === "container" || key === "process") {
            const consumer = key === "container" ? containerConsumer(value) : processConsumer(value);
            if (consumer) consumers.push(consumer);
            continue;
        }
        fields.set(key, value);
    }

    const memoryTotal = numberOf(fields.get("mem_total"));
    const memoryAvailable = numberOf(fields.get("mem_available"));
    return {
        os: fields.get("os") ?? null,
        kernel: fields.get("kernel") ?? null,
        cpuCount: numberOf(fields.get("cpus")),
        loadAverage: numberOf(fields.get("load")),
        memoryTotalBytes: memoryTotal,
        memoryUsedBytes: memoryTotal !== null && memoryAvailable !== null ? memoryTotal - memoryAvailable : null,
        diskTotalBytes: numberOf(fields.get("disk_total")),
        diskUsedBytes: numberOf(fields.get("disk_used")),
        consumers: rank(consumers),
        probedAt: new Date().toISOString()
    };
}

/** `name<TAB>12.34%<TAB>128MiB / 1.94GiB`, as `docker stats` formats it. */
function containerConsumer(value: string): ServerConsumer | null {
    const [name, cpu, memory] = value.split("\t");
    if (!name) return null;
    return {
        name,
        kind: "container",
        cpuPercent: numberOf(cpu?.replace("%", "")),
        memoryBytes: memorySize(memory?.split("/")[0]?.trim())
    };
}

/** `pcpu<TAB>rss<TAB>comm`, where rss is in KiB on both `ps` dialects. */
function processConsumer(value: string): ServerConsumer | null {
    const [cpu, rss, name] = value.split("\t");
    if (!name) return null;
    const resident = numberOf(rss);
    return {
        name,
        kind: "process",
        cpuPercent: numberOf(cpu),
        memoryBytes: resident === null ? null : resident * 1024
    };
}

/** Heaviest first, by CPU and then by memory, cut to what a panel can show. */
function rank(consumers: ServerConsumer[]): ServerConsumer[] {
    return consumers
        .sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) || (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
        .slice(0, CONSUMER_LIMIT);
}

const UNITS: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4
};

/** "128MiB" into bytes. Docker writes the unit onto the number, and which unit it
 *  picks depends on the size, so both spellings of every scale are accepted. */
function memorySize(value: string | undefined): number | null {
    if (!value) return null;
    const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)?$/.exec(value);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * (UNITS[(match[2] ?? "b").toLowerCase()] ?? 1));
}

/** A number the machine printed, or null - never NaN, which formats as "NaN". */
function numberOf(value: string | undefined): number | null {
    if (value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
