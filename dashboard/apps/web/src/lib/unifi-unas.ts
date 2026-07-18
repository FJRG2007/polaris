/**
 * Native UniFi UNAS metrics over the UniFi OS console. The UNAS ships with SSH
 * off by default, so we do NOT use SSH. We log in to the console over HTTPS with
 * a local UniFi account, then read one device-state snapshot from the console's
 * system websocket (`/api/ws/system`) - the same stream the UNAS Pro dashboard
 * uses. That message carries the real storage model: the RAID pool capacity, the
 * per-slot disks (model, size, temperature, health), and system vitals. We take
 * the first `DEVICE_STATE_CHANGED` frame and close, so this stays a quick,
 * read-only snapshot. The console uses a self-signed certificate, so TLS
 * verification is relaxed for these calls only.
 *
 * Shapes verified against a UNAS Pro on firmware 4.1.7 (ucore 4.1.129).
 */

import { Agent, WebSocket, fetch } from "undici";

/** Self-signed console cert: don't verify, but only for these requests. */
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

/** How long to wait for the first device-state frame before giving up. */
const SNAPSHOT_TIMEOUT_MS = 9000;

export interface UnasDisk {
    readonly slot: number;
    readonly present: boolean;
    readonly state: string;
    readonly model: string | null;
    readonly serial: string | null;
    readonly type: string | null;
    readonly sizeBytes: number;
    readonly temperature: number | null;
    readonly healthy: boolean;
    readonly rpm: number | null;
    readonly powerOnHours: number | null;
}
export interface UnasPool {
    readonly device: string;
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly health: string;
    readonly raidLevel: string | null;
    readonly raidState: string | null;
    readonly membersPresent: number;
    readonly membersExpected: number;
    readonly reasons: string[];
}
export interface UnasMetrics {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly pools: UnasPool[];
    readonly disks: UnasDisk[];
    readonly slotsTotal: number;
    readonly slotsPopulated: number;
    readonly health: string;
    readonly system: {
        readonly name: string;
        readonly model: string;
        readonly firmware: string;
        readonly cpuTemp: number | null;
        readonly cpuLoad: number | null;
        readonly memoryUsedBytes: number;
        readonly memoryTotalBytes: number;
        readonly uptimeSeconds: number;
    };
    /** Raw system.info, so unknown field shapes can be inspected and refined. */
    readonly raw: Record<string, unknown>;
}

export interface UnasTarget {
    readonly host: string;
    readonly port?: number;
    readonly username: string;
    readonly password: string;
    readonly secure?: boolean;
}

function httpBase(target: UnasTarget): string {
    const scheme = target.secure === false ? "http" : "https";
    const port = target.port && target.port !== 443 ? `:${target.port}` : "";
    return `${scheme}://${target.host}${port}`;
}

/** Log in to the console and return the session cookie header. */
async function login(base: string, username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, rememberMe: true }),
        dispatcher: insecure
    });
    if (response.status === 401) {
        throw new Error(
            "UNAS login failed: invalid credentials. Use a LOCAL console account (Ubiquiti SSO accounts with 2FA cannot log in here)"
        );
    }
    if (!response.ok) throw new Error(`UNAS login failed (${response.status})`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const token = /TOKEN=([^;]+)/.exec(setCookie)?.[1];
    if (!token) throw new Error("UNAS login returned no session cookie");
    return `TOKEN=${token}`;
}

/**
 * Open the console system websocket, resolve with the first DEVICE_STATE_CHANGED
 * frame's `system.info`, then close. Rejects on timeout, socket error, or an
 * early close.
 */
function readSystemInfo(base: string, cookie: string): Promise<Record<string, unknown>> {
    const wsUrl = `${base.replace(/^http/, "ws")}/api/ws/system`;
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl, { dispatcher: insecure, headers: { cookie } });
        const timer = setTimeout(() => {
            socket.close();
            reject(new Error("UNAS websocket timed out before a device-state frame arrived"));
        }, SNAPSHOT_TIMEOUT_MS);

        const finish = (fn: () => void) => {
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // already closing
            }
            fn();
        };

        socket.addEventListener("error", () =>
            finish(() => reject(new Error("UNAS websocket connection failed")))
        );
        socket.addEventListener("close", () => clearTimeout(timer));
        socket.addEventListener("message", (event) => {
            if (typeof event.data !== "string") return;
            let frame: { type?: string; system?: { info?: Record<string, unknown> } };
            try {
                frame = JSON.parse(event.data);
            } catch {
                return;
            }
            if (frame.type === "DEVICE_STATE_CHANGED" && frame.system?.info) {
                finish(() => resolve(frame.system!.info!));
            }
        });
    });
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
function num(source: Record<string, unknown>, key: string): number {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}

/** Turn a raw `system.info` payload into the metrics the UI renders. */
export function parseSystemInfo(info: Record<string, unknown>): UnasMetrics {
    const hardware = asRecord(info.hardware);
    const memory = asRecord(info.memory);
    const cpu = asRecord(info.cpu);
    const ustorage = asRecord(info.ustorage);

    // Per-slot disks (the UNAS Pro "slots" view). Absent slots report "nodisk".
    const disks: UnasDisk[] = asArray(ustorage.disks).map((raw) => {
        const disk = asRecord(raw);
        const present = str(disk, "state") !== "nodisk";
        return {
            slot: num(disk, "slot"),
            present,
            state: str(disk, "state") ?? "unknown",
            model: str(disk, "model"),
            serial: str(disk, "serial"),
            type: str(disk, "type"),
            sizeBytes: num(disk, "size"),
            temperature: present ? num(disk, "temperature") || null : null,
            healthy: str(disk, "healthy") === "good",
            rpm: present ? num(disk, "rpm") || null : null,
            powerOnHours: present ? num(disk, "poweronhrs") || null : null
        };
    });

    // Storage filesystems carry the human RAID level/state (raid1, degraded).
    const raidFs = asArray(info.storage)
        .map(asRecord)
        .find((fs) => str(fs, "type") === "raid");
    const raidInfo = asRecord(raidFs?.raid);

    // Pools: the ustorage "space" entries that hold user data (not swap/overlay).
    const pools: UnasPool[] = asArray(ustorage.space)
        .map(asRecord)
        .filter((space) => str(space, "space_type") === "primary")
        .map((space) => {
            const raid = asRecord(space.raid);
            return {
                device: str(space, "device") ?? "pool",
                totalBytes: num(space, "total_bytes"),
                usedBytes: num(space, "used_bytes"),
                health: str(space, "health") ?? "unknown",
                raidLevel: str(raidInfo, "level"),
                raidState: str(raidInfo, "state"),
                membersPresent: asArray(raid.members).length,
                membersExpected: num(raid, "expected"),
                reasons: asArray(space.reasons)
                    .map(asRecord)
                    .map((reason) => str(reason, "type"))
                    .filter((reason): reason is string => reason !== null)
            };
        });

    const totalBytes = pools.reduce((sum, pool) => sum + pool.totalBytes, 0);
    const usedBytes = pools.reduce((sum, pool) => sum + pool.usedBytes, 0);
    const health = pools.some((pool) => pool.health !== "health" && pool.health !== "healthy")
        ? "atrisk"
        : "healthy";

    return {
        totalBytes,
        usedBytes,
        pools,
        disks,
        slotsTotal: disks.length,
        slotsPopulated: disks.filter((disk) => disk.present).length,
        health,
        system: {
            name: str(info, "hostname") ?? str(hardware, "name") ?? "UniFi UNAS",
            model: str(hardware, "shortname") ?? "UNAS",
            firmware: str(hardware, "firmwareVersion") ?? str(info, "ucore_version") ?? "",
            cpuTemp: num(cpu, "temperature") || null,
            cpuLoad: typeof cpu.currentload === "number" ? cpu.currentload : null,
            memoryUsedBytes: (num(memory, "total") - num(memory, "available")) * 1024,
            memoryTotalBytes: num(memory, "total") * 1024,
            uptimeSeconds: Math.round(num(info, "uptime"))
        },
        raw: info
    };
}

/** Native UniFi UNAS metrics: log in, read one device-state snapshot, parse it. */
export async function fetchUnasMetrics(target: UnasTarget): Promise<UnasMetrics> {
    const base = httpBase(target);
    const cookie = await login(base, target.username, target.password);
    const info = await readSystemInfo(base, cookie);
    return parseSystemInfo(info);
}
