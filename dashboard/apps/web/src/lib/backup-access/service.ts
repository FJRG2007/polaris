/**
 * Backup access: keep the domain reachable from outside when the home line stops
 * taking visitors, without adding a millisecond while it does.
 *
 * The direct path is used while the line is healthy. A backup path is kept warm
 * but unused - the named Cloudflare tunnel's connector stays connected with no
 * DNS pointing at it, or the WireGuard link to a relay on one of the operator's
 * own cloud servers stays up - so a flip is only DNS writes. Polaris does with the
 * free DNS API what Cloudflare Load Balancing does between origins for a fee.
 *
 * Both connectors dial out. With no uplink at all nothing outside can reach the
 * house and Polaris cannot call the Cloudflare API either: that state is told as
 * it is and nothing is changed until the uplink returns.
 *
 * Runs every minute from the scheduler, leased, and keeps all of its state in
 * settings, so a restart between two writes finishes the flip on the next pass.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { connect, isIP } from "node:net";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { getHostConnection } from "@/lib/host-service";
import { getPorts } from "@/lib/deploy/runtime";
import type { RuntimePorts } from "@polaris/deploy";
import { ownedZoneNames } from "@/lib/domain-dns";
import type { ComposeSpec } from "@polaris/deploy";
import { getDomainZones } from "@/lib/domain-zones";
import { HostdPorts } from "@/lib/deploy/ports-hostd";
import { probePublicIp } from "@/lib/network-service";
import * as notices from "@/lib/notification-service";
import { PUBLISHED_KEY } from "@/lib/domain-address-sync";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getSetting, setSetting } from "@/lib/setting-store";
import { internetOffline } from "@/lib/offline/outbound-lookup";
import { forwardedPorts } from "@/lib/app-extensions/registry";
import { generateKeyPair } from "@/lib/deploy/wireguard/tunnel-config";
import { openKey, sealKey } from "@/lib/deploy/wireguard/tunnel-service";
import {
    loadCloudflareToken,
    requireCloudflareAccount
} from "@/lib/integrations/cloudflare-account-service";
import {
    createTunnel,
    deleteDnsRecord,
    deleteTunnel,
    findNameRecords,
    getTunnelToken,
    putTunnelHosts,
    resolveZoneForHostname,
    saveDnsRecord,
    setRecordTtl
} from "@/lib/integrations/cloudflare-api";
import {
    BACKUP_CONFIG_KEY,
    BACKUP_RECORDS_KEY,
    BACKUP_STATE_KEY,
    forgetBackupAccess
} from "@/lib/backup-access";
import {
    BACKUP_MODES,
    BACKUP_PATHS,
    decide,
    readState,
    type FlipState,
    type Verdict
} from "./decision";
import {
    planFlip,
    planRestore,
    planTtl,
    savedRecordSchema,
    type BackupTarget,
    type LiveRecord,
    type RecordOp
} from "./records";
import {
    relayPorts,
    relayProject,
    relaySpec,
    renderHomeConfig,
    renderRelayConfig
} from "./relay";
import { combineVerdicts, outsideScript, readOutside, type OutsideAnswer } from "./outside-check";

const TTL_KEY = "backupAccess.ttl";
const TUNNEL_KEY = "backupAccess.tunnel";
const RELAY_KEY = "backupAccess.relay";
const PROBE_KEY = "backupAccess.probe";

const TUNNEL_PROJECT = "polaris-backup-tunnel";
const TUNNEL_IMAGE = "cloudflare/cloudflared:latest";
const PROXY_NETWORK = "polaris-proxy";
/** The edge, as the connector reaches it on the proxy network. */
const EDGE_ORIGIN = "https://traefik:443";
/** Where a tunnel connector dials: what the tunnel path adds before the edge. */
const TUNNEL_EDGE = { host: "region1.v2.argotunnel.com", port: 7844 };
const CONNECT_TIMEOUT_MS = 3_000;
/** How long the cloud server is given to answer the SSH handshake. */
const OUTSIDE_READY_MS = 8_000;

export const configSchema = z.object({
    mode: z.enum(BACKUP_MODES),
    path: z.enum(BACKUP_PATHS).nullable(),
    relayTargetId: z.string().uuid().nullable(),
    dataSaver: z.boolean(),
    manualOn: z.boolean()
});
export type BackupConfig = z.infer<typeof configSchema>;

const DEFAULT_CONFIG: BackupConfig = {
    mode: "automatic",
    path: null,
    relayTargetId: null,
    dataSaver: true,
    manualOn: false
};

const recordsSchema = z.object({
    zoneId: z.string(),
    target: z.union([
        z.object({ kind: z.literal("tunnel"), tunnelId: z.string() }),
        z.object({ kind: z.literal("relay"), address: z.string() })
    ]),
    originals: z.array(savedRecordSchema)
});

const tunnelSchema = z.object({ tunnelId: z.string(), accountId: z.string(), token: z.string() });

const relaySchema = z.object({
    targetId: z.string(),
    address: z.string(),
    relayPublic: z.string(),
    relayPrivate: z.string(),
    homePublic: z.string(),
    homePrivate: z.string(),
    /** The TCP ports both ends were last brought up with. */
    tcp: z.array(z.number()).default([]),
    skippedUdp: z.array(z.number()).default([])
});

/** Why a path cannot be used right now, as a key the screen words. */
const PATH_PROBLEMS = ["no-token", "no-domain", "no-daemon", "no-server", "no-address", "failed"] as const;
export type PathProblem = (typeof PATH_PROBLEMS)[number] | null;

const probeSchema = z.object({
    checkedAt: z.string(),
    verdict: z.enum(["up", "down", "no-uplink", "unknown"]),
    /** Milliseconds to open a connection over each path; null when not measured. */
    latency: z.object({
        direct: z.number().nullable(),
        tunnel: z.number().nullable(),
        relay: z.number().nullable()
    }),
    /** This box reached its own public address once, so that check means something. */
    calibrated: z.boolean(),
    /** The cloud server that checked from outside; null when only the inside check ran. */
    from: z.string().nullable().default(null),
    lastIp: z.string().nullable(),
    problem: z.enum(PATH_PROBLEMS).nullable().catch(null),
    detail: z.string().nullable(),
    conflicts: z.array(z.string()).default([])
});
type Probe = z.infer<typeof probeSchema>;

function parse<S extends z.ZodTypeAny>(schema: S, raw: string | null): z.output<S> | null {
    if (!raw) return null;
    try {
        const parsed = schema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export async function readConfig(): Promise<BackupConfig> {
    return parse(configSchema, await getSetting(BACKUP_CONFIG_KEY)) ?? DEFAULT_CONFIG;
}

/** What Admin -> Domains shows. */
export interface BackupView {
    readonly configured: boolean;
    readonly config: BackupConfig;
    readonly state: FlipState;
    readonly probe: Probe | null;
    readonly tunnelReady: boolean;
    readonly relay: { address: string; tcp: number[]; skippedUdp: number[] } | null;
    readonly servers: { id: string; name: string }[];
    readonly cloudflare: boolean;
}

export async function backupView(): Promise<BackupView> {
    const [zones, config, state, probe, tunnel, relay, token, servers] = await Promise.all([
        getDomainZones().catch(() => null),
        readConfig(),
        getSetting(BACKUP_STATE_KEY).then(readState),
        getSetting(PROBE_KEY).then((raw) => parse(probeSchema, raw)),
        getSetting(TUNNEL_KEY).then((raw) => parse(tunnelSchema, raw)),
        getSetting(RELAY_KEY).then((raw) => parse(relaySchema, raw)),
        loadCloudflareToken().catch(() => null),
        prisma.deployTarget
            .findMany({
                where: { status: "active", kind: { not: "local" } },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
                take: 100
            })
            .catch(() => [])
    ]);
    return {
        configured: Boolean(zones?.baseDomain),
        config,
        state,
        probe,
        tunnelReady: tunnel !== null,
        relay: relay ? { address: relay.address, tcp: relay.tcp, skippedUdp: relay.skippedUdp } : null,
        servers,
        cloudflare: Boolean(token)
    };
}

/** Save the operator's choices, then bring the chosen path up and run a pass. */
export async function saveConfig(next: BackupConfig): Promise<void> {
    const previous = await readConfig();
    await setSetting(BACKUP_CONFIG_KEY, JSON.stringify(configSchema.parse(next)));
    forgetBackupAccess();
    if (previous.path === "relay" && (next.path !== "relay" || next.relayTargetId !== previous.relayTargetId))
        await retireRelay().catch(() => undefined);
    if (previous.path === "tunnel" && next.path !== "tunnel")
        await retireTunnel().catch(() => undefined);
}

/**
 * One pass: keep the chosen path warm, check the direct path, and flip when the
 * decision says so. Every write is planned against what Cloudflare holds now, so a
 * pass that is repeated or was cut short does the right thing.
 */
export async function runBackupAccess(): Promise<{ verdict: Verdict; move: string | null }> {
    const zones = await getDomainZones().catch(() => null);
    if (!zones?.baseDomain) return { verdict: "unknown", move: null };
    const config = await readConfig();
    const previous = await getSetting(BACKUP_STATE_KEY).then(readState);
    const before = parse(probeSchema, await getSetting(PROBE_KEY));

    const uplink = !internetOffline();
    let problem: PathProblem = null;
    let detail: string | null = null;
    let target: BackupTarget | null = null;
    if (uplink && config.path) {
        try {
            target = config.path === "tunnel" ? await warmTunnel(zones.baseDomain) : await warmRelay(config);
        } catch (caught) {
            problem = caught instanceof PathRefusal ? caught.code : "failed";
            detail = caught instanceof PathRefusal ? null : message(caught);
        }
    }
    const saved = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY));
    // While on backup, a path that failed to warm is still the one serving.
    if (!target && saved && config.path) target = saved.target;

    const measured = await measure(before, previous.serving, uplink, config.relayTargetId);
    const now = new Date();
    const decision = decide(previous, {
        mode: config.mode,
        manualOn: config.manualOn,
        pathReady: target !== null,
        verdict: measured.verdict,
        now
    });

    let conflicts: string[] = [];
    let moved: string | null = null;
    try {
        if (uplink) await arm(zones.baseDomain, target !== null && decision.state.serving === "direct");
        if (decision.move === "to-backup" && target) await toBackup(zones.baseDomain, target);
        if (decision.move === "to-direct" || (decision.state.serving === "direct" && saved))
            conflicts = await toDirect();
        moved = decision.move;
        await setSetting(BACKUP_STATE_KEY, JSON.stringify(decision.state));
        forgetBackupAccess();
        if (decision.move) await announce(decision.state, zones.baseDomain);
    } catch (caught) {
        problem = problem ?? "failed";
        detail = detail ?? message(caught);
        // The streaks still count: the next pass decides the same move again.
        await setSetting(
            BACKUP_STATE_KEY,
            JSON.stringify({ ...decision.state, serving: previous.serving, since: previous.since, lastFlip: previous.lastFlip })
        );
    }
    await setSetting(
        PROBE_KEY,
        JSON.stringify({ ...measured, checkedAt: now.toISOString(), problem, detail, conflicts } satisfies Probe)
    );
    return { verdict: measured.verdict, move: moved };
}

class PathRefusal extends Error {
    constructor(readonly code: Exclude<PathProblem, null>) {
        super(code);
    }
}

/** Every owned name's address records, as they are now. */
async function liveRecords(baseDomain: string): Promise<{ token: string; zoneId: string; live: LiveRecord[] }> {
    const token = await loadCloudflareToken();
    if (!token) throw new PathRefusal("no-token");
    const zones = await getDomainZones();
    const zoneId = (await resolveZoneForHostname(token, baseDomain)).id;
    const live: LiveRecord[] = [];
    // Sequential: Cloudflare rate-limits per account.
    for (const name of await ownedZoneNames(zones)) {
        for (const record of await findNameRecords(token, zoneId, name)) {
            if (record.type !== "A" && record.type !== "AAAA" && record.type !== "CNAME") continue;
            live.push({
                id: record.id,
                name: record.name,
                type: record.type,
                content: record.content,
                proxied: record.proxied,
                ttl: record.ttl
            });
        }
    }
    return { token, zoneId, live };
}

async function apply(token: string, zoneId: string, ops: readonly RecordOp[]): Promise<void> {
    for (const op of ops) {
        if (op.op === "put") await saveDnsRecord(token, zoneId, op.id, op.record);
        else if (op.op === "create") await saveDnsRecord(token, zoneId, null, op.record);
        else if (op.op === "delete") await deleteDnsRecord(token, zoneId, op.id);
        else await setRecordTtl(token, zoneId, op.id, op.ttl);
    }
}

/** Short TTLs on DNS-only records while a flip may come; their own back after. */
async function arm(baseDomain: string, armed: boolean): Promise<void> {
    const stored = parse(z.object({ armed: z.boolean(), ttl: z.record(z.string(), z.number()) }), await getSetting(TTL_KEY));
    if ((stored?.armed ?? false) === armed) return;
    const { token, zoneId, live } = await liveRecords(baseDomain);
    const plan = planTtl(live, armed, stored?.ttl ?? {});
    await setSetting(TTL_KEY, JSON.stringify({ armed, ttl: plan.remembered }));
    await apply(token, zoneId, plan.ops);
}

async function toBackup(baseDomain: string, target: BackupTarget): Promise<void> {
    const { token, zoneId, live } = await liveRecords(baseDomain);
    const plan = planFlip(live, target);
    // The originals are saved before the first write and never replaced while a
    // flip is under way, so a repeated pass cannot remember the backup as original.
    const saved = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY));
    if (!saved)
        await setSetting(BACKUP_RECORDS_KEY, JSON.stringify({ zoneId, target, originals: plan.originals }));
    forgetBackupAccess();
    await apply(token, zoneId, plan.ops);
}

/** Write the remembered records back, then let go of them. Answers the names left alone. */
async function toDirect(): Promise<string[]> {
    const saved = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY));
    if (!saved) return [];
    const token = await loadCloudflareToken();
    if (!token) throw new PathRefusal("no-token");
    const live: LiveRecord[] = [];
    for (const name of new Set(saved.originals.map((record) => record.name))) {
        for (const record of await findNameRecords(token, saved.zoneId, name)) {
            if (record.type !== "A" && record.type !== "AAAA" && record.type !== "CNAME") continue;
            live.push({ ...record, type: record.type });
        }
    }
    const plan = planRestore(live, saved.originals, saved.target);
    await apply(token, saved.zoneId, plan.ops);
    await setSetting(BACKUP_RECORDS_KEY, null);
    return plan.conflicts;
}

/** The named tunnel, created once, its connector kept running with no DNS on it. */
async function warmTunnel(baseDomain: string): Promise<BackupTarget> {
    let stored = parse(tunnelSchema, await getSetting(TUNNEL_KEY));
    const names = await ownedZoneNames(await getDomainZones());
    if (names.length === 0) throw new PathRefusal("no-domain");
    if (!stored) {
        const account = await requireCloudflareAccount().catch(() => {
            throw new PathRefusal("no-token");
        });
        await resolveZoneForHostname(account.token, baseDomain);
        const tunnel = await createTunnel(account.token, account.accountId, "polaris-backup");
        const connector = await getTunnelToken(account.token, account.accountId, tunnel.id);
        await putTunnelHosts(account.token, account.accountId, tunnel.id, names, EDGE_ORIGIN);
        stored = { tunnelId: tunnel.id, accountId: account.accountId, token: sealKey(connector) };
        await setSetting(TUNNEL_KEY, JSON.stringify(stored));
    }
    await keepUp(new HostdPorts(), TUNNEL_PROJECT, () => tunnelSpec(openKey(stored.token)));
    return { kind: "tunnel", tunnelId: stored.tunnelId };
}

function tunnelSpec(token: string): ComposeSpec {
    return {
        project: TUNNEL_PROJECT,
        services: [
            {
                name: TUNNEL_PROJECT,
                image: TUNNEL_IMAGE,
                pullPolicy: "always",
                env: { TUNNEL_TOKEN: token },
                ports: [],
                volumes: [],
                labels: {},
                command: ["tunnel", "--no-autoupdate", "run"],
                networks: [PROXY_NETWORK],
                restart: "unless-stopped"
            }
        ],
        volumes: [],
        networks: [PROXY_NETWORK]
    };
}

async function retireTunnel(): Promise<void> {
    const stored = parse(tunnelSchema, await getSetting(TUNNEL_KEY));
    const ports = new HostdPorts();
    try {
        await ports.composeDown(TUNNEL_PROJECT);
    } finally {
        await ports.dispose();
    }
    if (stored) {
        const token = await loadCloudflareToken();
        if (token) await deleteTunnel(token, stored.accountId, stored.tunnelId).catch(() => undefined);
    }
    await setSetting(TUNNEL_KEY, null);
}

/** A target row as `getPorts` takes it, with the address the house dials. */
async function relayTarget(id: string) {
    const row = await prisma.deployTarget.findFirst({
        where: { id, status: "active", kind: { not: "local" } },
        select: {
            id: true,
            kind: true,
            hostId: true,
            runtime: true,
            proxyNetwork: true,
            ownerId: true,
            host: { select: { address: true } }
        }
    });
    if (!row) throw new PathRefusal("no-server");
    return row;
}

/** Both ends of the relay link, keys generated once and kept sealed. */
async function warmRelay(config: BackupConfig): Promise<BackupTarget> {
    if (!config.relayTargetId) throw new PathRefusal("no-server");
    const target = await relayTarget(config.relayTargetId);
    const address = target.host?.address ?? null;
    if (!address) throw new PathRefusal("no-address");
    let stored = parse(relaySchema, await getSetting(RELAY_KEY));
    if (!stored || stored.targetId !== target.id || stored.address !== address) {
        const relay = generateKeyPair();
        const home = generateKeyPair();
        stored = {
            targetId: target.id,
            address,
            relayPublic: relay.publicKey,
            relayPrivate: sealKey(relay.privateKey),
            homePublic: home.publicKey,
            homePrivate: sealKey(home.privateKey),
            tcp: [],
            skippedUdp: []
        };
    }
    // The ports the installed game servers publish, as the router is asked to
    // forward them; a server added or removed changes what both ends carry.
    const games = await forwardedPorts().catch(() => []);
    const ports = relayPorts(games.flatMap((row) => row.ports));
    // Fresh keys start with no ports, so they always bring both ends up again.
    const changed = stored.tcp.join(",") !== ports.tcp.join(",");
    // The keys are kept now and the ports only once both ends run with them, so a
    // bring-up that failed is tried again on the next pass.
    stored = { ...stored, skippedUdp: ports.skippedUdp };
    await setSetting(RELAY_KEY, JSON.stringify(stored));
    const keys = {
        relay: { publicKey: stored.relayPublic, privateKey: openKey(stored.relayPrivate) },
        home: { publicKey: stored.homePublic, privateKey: openKey(stored.homePrivate) }
    };
    const relayConfig = renderRelayConfig(keys, ports.tcp);
    const homeConfig = renderHomeConfig(keys, address, ports.tcp);
    await keepUp(
        await getPorts(target, target.ownerId),
        relayProject("relay"),
        () => relaySpec("relay", relayConfig, ports.tcp),
        changed
    );
    await keepUp(new HostdPorts(), relayProject("home"), () => relaySpec("home", homeConfig, ports.tcp), changed);
    if (changed) await setSetting(RELAY_KEY, JSON.stringify({ ...stored, tcp: ports.tcp }));
    return { kind: "relay", address };
}

async function retireRelay(): Promise<void> {
    const stored = parse(relaySchema, await getSetting(RELAY_KEY));
    const home = new HostdPorts();
    try {
        await home.composeDown(relayProject("home"));
    } finally {
        await home.dispose();
    }
    if (stored) {
        const target = await relayTarget(stored.targetId).catch(() => null);
        if (target) {
            const ports = await getPorts(target, target.ownerId);
            try {
                await ports.composeDown(relayProject("relay"));
            } finally {
                await ports.dispose();
            }
        }
    }
    await setSetting(RELAY_KEY, null);
}

/**
 * Start a project when none of its containers is there, or bring it up again when
 * what it carries changed. Quiet when it already runs as it should.
 */
async function keepUp(
    ports: RuntimePorts,
    project: string,
    spec: () => ComposeSpec,
    changed = false
): Promise<void> {
    try {
        // A runtime that cannot list is given the spec every pass: compose leaves an
        // unchanged project running as it is.
        const list = ports.listContainers?.bind(ports) ?? (async () => []);
        const running = await list(project).catch((caught: unknown) => {
            throw /hostd|ECONNREFUSED|ENOENT|501/i.test(message(caught)) ? new PathRefusal("no-daemon") : caught;
        });
        if (changed || running.length === 0) await ports.composeUp(spec());
    } finally {
        await ports.dispose();
    }
}

/** How long a TCP connection takes to open, or null when it does not. */
export function connectTime(host: string, port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<number | null> {
    return new Promise((resolve) => {
        const started = performance.now();
        const socket = connect({ host, port });
        const done = (value: number | null) => {
            socket.destroy();
            resolve(value);
        };
        socket.setTimeout(timeoutMs, () => done(null));
        socket.once("connect", () => done(Math.round(performance.now() - started)));
        socket.once("error", () => done(null));
    });
}

/**
 * Check the direct path and time each path.
 *
 * From outside first: when an enrolled cloud server exists, it opens 443 on the
 * house's public address the way a visitor would, and its answer decides
 * (`combineVerdicts`). What follows is the fallback from inside.
 *
 * The strongest inside check is opening 443 on this server's own public address;
 * a router that does not loop that back makes it fail always, so it only counts
 * once it has worked here. Until then the public address is compared with the
 * one the records name. No uplink at all is the breaker's to say.
 */
async function measure(
    before: Probe | null,
    serving: FlipState["serving"],
    uplink: boolean,
    relayTargetId: string | null
): Promise<Omit<Probe, "checkedAt" | "problem" | "detail" | "conflicts">> {
    const [published, tunnel, relay] = await Promise.all([
        getSetting(PUBLISHED_KEY),
        getSetting(TUNNEL_KEY),
        getSetting(RELAY_KEY).then((raw) => parse(relaySchema, raw))
    ]);
    const calibrated = before?.calibrated ?? false;
    if (!uplink)
        return {
            verdict: "no-uplink",
            latency: { direct: null, tunnel: null, relay: null },
            calibrated,
            from: null,
            lastIp: before?.lastIp ?? null
        };
    const [direct, tunnelMs, relayMs, ip] = await Promise.all([
        published ? connectTime(published, 443) : Promise.resolve(null),
        tunnel ? connectTime(TUNNEL_EDGE.host, TUNNEL_EDGE.port) : Promise.resolve(null),
        relay ? connectTime(relay.address, 443) : Promise.resolve(null),
        probePublicIp(0)
    ]);
    const nowCalibrated = calibrated || direct !== null;
    let inside: Verdict;
    if (nowCalibrated) inside = direct !== null ? "up" : "down";
    else if (!ip || !published) inside = "unknown";
    // On backup the follower stands back, so a line back on a new address is "up"
    // once it holds still; the follower repoints it after the records are restored.
    else inside = ip === published || (serving === "backup" && ip === before?.lastIp) ? "up" : "down";
    // The address visitors would reach today: the one the line has now, else the
    // one the records were last given.
    const outside = await checkFromOutside(relayTargetId, ip ?? published);
    const { verdict } = combineVerdicts(inside, outside?.answer ?? null);
    return {
        verdict,
        latency: { direct: direct ?? outside?.answer.ms ?? null, tunnel: tunnelMs, relay: relayMs },
        calibrated: nowCalibrated,
        from: outside?.from ?? null,
        lastIp: ip ?? before?.lastIp ?? null
    };
}

/**
 * The cloud server that checks from outside: the relay's own when the relay path
 * is chosen, else the first active machine enrolled as a VPS or cloud server. A
 * machine whose address is the house's own is not outside.
 */
async function outsideMachine(relayTargetId: string | null, homeAddress: string) {
    const preferred = relayTargetId
        ? await prisma.deployTarget.findFirst({ where: { id: relayTargetId }, select: { hostId: true } })
        : null;
    const hosts = await prisma.host.findMany({
        where: {
            status: "active",
            OR: [
                { environment: { in: ["vps", "cloud"] } },
                ...(preferred?.hostId ? [{ id: preferred.hostId }] : [])
            ]
        },
        select: { id: true, name: true, ownerId: true, address: true },
        orderBy: { createdAt: "asc" },
        take: 20
    });
    const outside = hosts.filter((host) => host.address !== homeAddress);
    return outside.find((host) => host.id === preferred?.hostId) ?? outside[0] ?? null;
}

/**
 * Ask a cloud server whether 443 on the house's address opens. Null when there
 * is none, or it could not be asked or did not say: the inside check stands then.
 */
async function checkFromOutside(
    relayTargetId: string | null,
    address: string | null
): Promise<{ answer: OutsideAnswer; from: string } | null> {
    if (!address || isIP(address) === 0) return null;
    try {
        const host = await outsideMachine(relayTargetId, address);
        if (!host) return null;
        const connection = await getHostConnection(host.id, host.ownerId);
        const lease = await borrowSsh("exec", host.id, {
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            // Pinned like every other probe: an empty list refuses rather than trusts.
            pinnedHostKey: connection.hostKey ?? [],
            readyTimeoutMs: OUTSIDE_READY_MS
        });
        let output = "";
        try {
            await execCommand(lease.client, "sh -s", {
                input: outsideScript(address),
                onStdout: (chunk) => {
                    output += chunk.toString("utf8");
                }
            });
        } finally {
            lease.release();
        }
        const answer = readOutside(output);
        return answer ? { answer, from: host.name } : null;
    } catch (caught) {
        console.warn(`polaris: backup access could not check from outside: ${message(caught)}`);
        return null;
    }
}

/** One bell per flip, to every administrator. */
async function announce(state: FlipState, domain: string): Promise<void> {
    const rows = await prisma.user.findMany({ where: { isAdmin: true }, select: { id: true } }).catch(() => []);
    const on = state.serving === "backup";
    for (const { id: userId } of rows) {
        const t = await wordsFor(userId, "notices");
        await notices
            .createNotification({
                userId,
                href: "/admin/domains#backup-access",
                type: on ? "domain.backup-on" : "domain.backup-off",
                level: on ? "warning" : "success",
                title: on ? t("backupAccess.onTitle", { domain }) : t("backupAccess.offTitle", { domain }),
                body: on ? t("backupAccess.onBody") : t("backupAccess.offBody")
            })
            .catch(() => undefined);
    }
}

function message(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}
