/**
 * Self-diagnosis: a fixed set of cheap, bounded checks over this deployment.
 *
 * Each check reuses the reading another screen already trusts - the update
 * status Settings shows, the disk the metrics are drawn from, the addresses
 * the health probe keeps, the edge's dynamic directory - rather than a second
 * opinion that could disagree with it. Each one runs on its own clock: one that
 * does not answer within `CHECK_TIMEOUT_MS` reports "unknown" instead of holding
 * the page or the support bundle open.
 *
 * A check answers in codes, not sentences. The screen turns `{ id, code, facts }`
 * into words in the reader's language, and the support bundle carries the same
 * codes, which read the same to whoever opens it.
 *
 * Server-only.
 */

import { z } from "zod";
import { join } from "node:path";
import { connect } from "node:tls";
import { prisma } from "@polaris/db";
import { lookup } from "node:dns/promises";
import { readdir, stat } from "node:fs/promises";
import { dynamicDir } from "@/lib/traefik-dynamic";
import { HostdClient } from "@polaris/hostd-client";
import { diskLevel } from "@/lib/deploy/disk-watch";
import { localDisk } from "@/lib/deploy/local-disk";
import { polarisZoneHost } from "@/lib/domain-zones";
import { getUpdateStatus } from "@/lib/update-service";
import { checkedAddresses } from "@/lib/address-health";
import { getCapabilities, loadEnv } from "@polaris/config";

export const CHECK_IDS = [
    "database",
    "hostAgent",
    "updates",
    "disk",
    "edge",
    "addresses",
    "certificate",
    "dns",
    "clock"
] as const;

export const checkIdSchema = z.enum(CHECK_IDS);
export type CheckId = z.infer<typeof checkIdSchema>;

export type CheckStatus = "pass" | "warn" | "fail" | "unknown" | "skip";

/** What Polaris can do about a finding itself. A link opens the screen that
 *  settles it; an action runs here, from the button beside the finding. */
export type CheckFix =
    | { readonly kind: "action"; readonly action: FixAction }
    | { readonly kind: "link"; readonly href: string };

export const FIX_ACTIONS = ["republishRoutes", "freeSpace"] as const;
export const fixActionSchema = z.enum(FIX_ACTIONS);
export type FixAction = z.infer<typeof fixActionSchema>;

export interface CheckResult {
    readonly id: CheckId;
    readonly status: CheckStatus;
    /** Which sentence the screen shows, under `diagnostics.checks.<id>.<code>`. */
    readonly code: string;
    /** Values that sentence is filled with. Never a secret: these reach the
     *  support bundle as they are. */
    readonly facts: Readonly<Record<string, string | number>>;
    readonly fix: CheckFix | null;
    readonly ms: number;
}

/** Long enough for a TLS handshake over a slow link, short enough that the
 *  slowest check never holds the bundle for long. */
export const CHECK_TIMEOUT_MS = 6000;

const GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Where the clock is compared, and the latency of the speed test measured. */
export const TIME_REFERENCE_URL = "https://speed.cloudflare.com/__down?bytes=0";

type Verdict = Omit<CheckResult, "id" | "ms">;

function verdict(
    status: CheckStatus,
    code: string,
    facts: Record<string, string | number> = {},
    fix: CheckFix | null = null
): Verdict {
    return { status, code, facts, fix };
}

/** The work, or null when it threw or ran past `ms`. */
export async function within<T>(work: Promise<T>, ms = CHECK_TIMEOUT_MS): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    try {
        return await Promise.race([work.catch(() => null), late]);
    } finally {
        clearTimeout(timer);
    }
}

/** Disk: the same thresholds the disk watcher alerts on. */
export function diskVerdict(disk: { used: number; total: number } | null, full: boolean): Verdict {
    if (!disk) return verdict("unknown", "unreadable");
    const free = Math.max(0, disk.total - disk.used);
    const facts = {
        freeGb: Math.round((free / GB) * 10) / 10,
        percent: Math.round((disk.used / disk.total) * 100)
    };
    const level = diskLevel(free, disk.total);
    const fix: CheckFix | null = full ? { kind: "action", action: "freeSpace" } : null;
    if (level === "critical") return verdict("fail", "critical", facts, fix);
    if (level === "low") return verdict("warn", "low", facts, fix);
    return verdict("pass", "ok", facts);
}

/** Certificate: expired or untrusted fails, under two weeks left warns. */
export function certificateVerdict(
    host: string,
    cert: { validTo: Date | null; trusted: boolean } | null,
    now = Date.now()
): Verdict {
    const link: CheckFix = { kind: "link", href: "/admin/domains" };
    if (!cert || !cert.validTo) return verdict("unknown", "unreachable", { host });
    const days = Math.floor((cert.validTo.getTime() - now) / DAY_MS);
    if (days < 0) return verdict("fail", "expired", { host, days: -days }, link);
    if (!cert.trusted) return verdict("fail", "untrusted", { host }, link);
    if (days < 14) return verdict("warn", "expiring", { host, days }, link);
    return verdict("pass", "ok", { host, days });
}

/** Clock: the Date header is whole seconds, so under 30 s is not a finding. */
export function clockVerdict(skewMs: number | null): Verdict {
    if (skewMs === null) return verdict("unknown", "unreachable");
    const seconds = Math.round(Math.abs(skewMs) / 1000);
    if (seconds > 300) return verdict("fail", "skewed", { seconds });
    if (seconds > 30) return verdict("warn", "skewed", { seconds });
    return verdict("pass", "ok", { seconds });
}

/** The edge: one empty file freezes every route, so any empty one fails. */
export function edgeVerdict(files: ReadonlyArray<{ name: string; size: number }> | null): Verdict {
    if (!files) return verdict("unknown", "unreadable");
    const empty = files.filter((file) => file.size === 0).map((file) => file.name);
    const fix: CheckFix = { kind: "action", action: "republishRoutes" };
    if (empty.length > 0) return verdict("fail", "empty", { files: empty.join(", ") }, fix);
    return verdict("pass", "ok", { count: files.length });
}

/** The public hostname the dashboard answers on, when it has one. */
async function dashboardHost(): Promise<string | null> {
    const zone = await polarisZoneHost().catch(() => null);
    if (zone) return zone;
    try {
        const host = new URL(loadEnv().POLARIS_APP_URL ?? "").hostname;
        // An address or a LAN name has no public certificate or record to check.
        if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
        return host;
    } catch {
        return null;
    }
}

function peerCertificate(host: string): Promise<{ validTo: Date | null; trusted: boolean }> {
    return new Promise((resolve, reject) => {
        // Not verified here on purpose: an untrusted certificate is a finding to
        // report, not a reason to learn nothing about it.
        const socket = connect(
            { host, port: 443, servername: host, rejectUnauthorized: false },
            () => {
                const peer = socket.getPeerCertificate();
                const validTo = peer?.valid_to ? new Date(peer.valid_to) : null;
                resolve({
                    validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo : null,
                    trusted: socket.authorized
                });
                socket.end();
            }
        );
        socket.setTimeout(CHECK_TIMEOUT_MS, () => socket.destroy(new Error("timeout")));
        socket.on("error", reject);
    });
}

async function clockSkew(): Promise<number | null> {
    const sent = Date.now();
    const response = await fetch(TIME_REFERENCE_URL, {
        method: "GET",
        cache: "no-store",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    });
    const received = Date.now();
    await response.body?.cancel().catch(() => undefined);
    const header = response.headers.get("date");
    const theirs = header ? Date.parse(header) : Number.NaN;
    if (Number.isNaN(theirs)) return null;
    return (sent + received) / 2 - theirs;
}

async function edgeFiles(): Promise<Array<{ name: string; size: number }>> {
    const dir = dynamicDir();
    const names = (await readdir(dir)).filter((name) => /\.(ya?ml|toml)$/i.test(name));
    return Promise.all(
        names
            .slice(0, 200)
            .map(async (name) => ({ name, size: (await stat(join(dir, name))).size }))
    );
}

const RUNNERS: Record<CheckId, () => Promise<Verdict>> = {
    async database() {
        const started = Date.now();
        const answered = await within(prisma.$queryRaw`SELECT 1`.then(() => true));
        if (!answered) return verdict("fail", "unreachable");
        const ms = Date.now() - started;
        return ms > 500 ? verdict("warn", "slow", { ms }) : verdict("pass", "ok", { ms });
    },
    async hostAgent() {
        if (getCapabilities().edition === "limited") return verdict("warn", "limited");
        const health = await within(new HostdClient().health());
        if (!health) return verdict("fail", "silent");
        return verdict("pass", "ok", { version: health.version });
    },
    async updates() {
        const status = await within(getUpdateStatus());
        const link: CheckFix = { kind: "link", href: "/admin/settings" };
        if (!status || status.error) return verdict("unknown", "unreachable", {}, link);
        if (status.upToDate) return verdict("pass", "ok", { version: status.current ?? "-" });
        return verdict(
            "warn",
            "behind",
            { behind: status.behindBy ?? 0, version: status.current ?? "-" },
            link
        );
    },
    async disk() {
        return diskVerdict(await within(localDisk()), getCapabilities().edition === "full");
    },
    async edge() {
        return edgeVerdict(await within(edgeFiles()));
    },
    async addresses() {
        const checked = await within(checkedAddresses(), CHECK_TIMEOUT_MS * 2);
        const link: CheckFix = { kind: "link", href: "/admin/settings" };
        if (!checked) return verdict("unknown", "unreachable");
        const down = checked
            .filter((address) => address.health.state === "down")
            .map((address) => address.host);
        if (down.length === 0) return verdict("pass", "ok", { count: checked.length });
        if (down.length === checked.length)
            return verdict("fail", "allDown", { hosts: down.join(", ") }, link);
        return verdict("warn", "someDown", { hosts: down.join(", ") }, link);
    },
    async certificate() {
        const host = await dashboardHost();
        if (!host) return verdict("skip", "noDomain");
        return certificateVerdict(host, await within(peerCertificate(host)));
    },
    async dns() {
        const host = await dashboardHost();
        if (!host) return verdict("skip", "noDomain");
        const found = await within(lookup(host).then((answer) => answer.address));
        if (!found)
            return verdict(
                "fail",
                "unresolved",
                { host },
                { kind: "link", href: "/admin/domains" }
            );
        return verdict("pass", "ok", { host, address: found });
    },
    async clock() {
        return clockVerdict(await within(clockSkew()));
    }
};

/** Run one check. Never throws: a check that breaks is a finding of its own. */
export async function runCheck(id: CheckId): Promise<CheckResult> {
    const started = Date.now();
    let result: Verdict;
    try {
        result =
            (await within(RUNNERS[id](), CHECK_TIMEOUT_MS * 2)) ?? verdict("unknown", "timeout");
    } catch {
        result = verdict("unknown", "timeout");
    }
    return { id, ...result, ms: Date.now() - started };
}

/** Every check, in parallel. */
export function runDiagnosis(): Promise<CheckResult[]> {
    return Promise.all(CHECK_IDS.map((id) => runCheck(id)));
}
