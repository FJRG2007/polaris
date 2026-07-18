/**
 * Native UniFi UNAS metrics over the UniFi OS console API. The UNAS ships with
 * SSH off by default, so we do NOT use SSH: we log in to the console over HTTPS
 * with the UniFi account and read the Drive API through the console proxy - the
 * same endpoints the on-box service exposes, reached remotely. The console uses a
 * self-signed certificate, so TLS verification is relaxed for these calls only.
 *
 * Field names in the responses are parsed defensively (several candidate keys),
 * and the raw payloads are returned so a real device's shapes can refine them.
 */

import { Agent, fetch } from "undici";

/** Self-signed console cert: don't verify, but only for these requests. */
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

export interface UnasPool {
    readonly name: string;
    readonly total: number;
    readonly used: number;
}
export interface UnasShare {
    readonly name: string;
    readonly used: number;
    readonly quota: number | null;
    readonly members: number;
    readonly snapshots: boolean;
}
export interface UnasMetrics {
    readonly totalBytes: number;
    readonly usedBytes: number;
    readonly pools: UnasPool[];
    readonly shares: UnasShare[];
    readonly throughput: { read: number; write: number };
    readonly system: { name: string; version: string };
    /** Raw payloads, so unknown field shapes can be inspected and refined. */
    readonly raw: Record<string, unknown>;
}

export interface UnasTarget {
    readonly host: string;
    readonly port?: number;
    readonly username: string;
    readonly password: string;
    readonly secure?: boolean;
}

interface Auth {
    readonly cookie: string;
    readonly csrf?: string;
}

function baseUrl(target: UnasTarget): string {
    const scheme = target.secure === false ? "http" : "https";
    const port = target.port && target.port !== 443 ? `:${target.port}` : "";
    return `${scheme}://${target.host}${port}`;
}

async function login(base: string, username: string, password: string): Promise<Auth> {
    const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, rememberMe: true }),
        dispatcher: insecure
    });
    if (!response.ok) throw new Error(`UNAS login failed (${response.status})`);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const token = /TOKEN=([^;]+)/.exec(setCookie)?.[1];
    if (!token) throw new Error("UNAS login returned no session cookie");
    const csrf =
        response.headers.get("x-csrf-token") ?? response.headers.get("x-updated-csrf-token") ?? undefined;
    return { cookie: `TOKEN=${token}`, csrf };
}

async function apiGet(base: string, path: string, auth: Auth): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
        headers: { cookie: auth.cookie, ...(auth.csrf ? { "x-csrf-token": auth.csrf } : {}) },
        dispatcher: insecure
    });
    if (!response.ok) return null;
    return response.json();
}

/** First present numeric value among candidate keys. */
function num(source: unknown, ...keys: string[]): number {
    if (typeof source !== "object" || source === null) return 0;
    const record = source as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
}

export async function fetchUnasMetrics(target: UnasTarget): Promise<UnasMetrics> {
    const base = baseUrl(target);
    const auth = await login(base, target.username, target.password);
    const [storage, drives, netio, system] = await Promise.all([
        apiGet(base, "/proxy/drive/api/v2/storage", auth),
        apiGet(base, "/proxy/drive/api/v2/drives", auth),
        apiGet(base, "/proxy/drive/api/v2/systems/network-io", auth),
        apiGet(base, "/api/system", auth)
    ]);

    const poolList = ((storage as Record<string, unknown> | null)?.pools as unknown[] | undefined) ?? [];
    const pools: UnasPool[] = poolList.map((pool) => ({
        name: String((pool as Record<string, unknown>).name ?? `Pool ${num(pool, "number") || ""}`.trim()),
        total: num(pool, "size", "total", "capacity", "totalBytes"),
        used: num(pool, "used", "usage", "usedBytes")
    }));

    const driveList = ((drives as Record<string, unknown> | null)?.drives as unknown[] | undefined) ?? [];
    const shares: UnasShare[] = driveList
        .filter((drive) => (drive as Record<string, unknown>).type === "shared" || true)
        .map((drive) => {
            const record = drive as Record<string, unknown>;
            const quota = num(drive, "quota");
            return {
                name: String(record.name ?? "share"),
                used: num(drive, "usage", "used"),
                quota: quota > 0 ? quota : null,
                members: num(drive, "memberCount", "members"),
                snapshots: record.snapshotEnabled === true
            };
        });

    return {
        totalBytes: pools.reduce((sum, pool) => sum + pool.total, 0),
        usedBytes: pools.reduce((sum, pool) => sum + pool.used, 0),
        pools,
        shares,
        throughput: {
            read: num(netio, "read", "rx", "readBytesPerSec"),
            write: num(netio, "write", "tx", "writeBytesPerSec")
        },
        system: {
            name: String((system as Record<string, unknown> | null)?.name ?? "UniFi UNAS"),
            version: String((system as Record<string, unknown> | null)?.version ?? "")
        },
        raw: { storage, drives, netio, system }
    };
}
