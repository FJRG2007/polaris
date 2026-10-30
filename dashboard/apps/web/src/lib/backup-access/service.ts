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
import { RemoteRouter } from "@/lib/deploy/router-remote";
import {
    freeServerPorts,
    isSettingUp,
    prepareServerEdge,
    readServerEdge,
    serverPortHolders,
    withSetupLock
} from "@/lib/deploy/server-edge";
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
import {
    followHomeRelay,
    homeListenPorts,
    openKey,
    sealKey
} from "@/lib/deploy/wireguard/tunnel-service";
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
    type Flip,
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
import { tlsTime } from "./tls-time";
import {
    RELAY_LISTEN_PORT,
    RELAY_ROUTES_FILE,
    relayConfigs,
    relayHelper,
    relayPorts,
    relayProject,
    relaySpec,
    renderRelayRoutes
} from "./relay";
import { holdersCanBeFreed } from "./port-holders";
import { CALL_PORTS } from "@/lib/chat/call-ports";
import { getTailscaleHost } from "@/lib/tailscale/tailscale-service";
import { syncCallNodeIp } from "@/lib/chat/call-address-watch";
import { refreshInboundReach, readInboundReach } from "./inbound-service";
import { readAaaa, syncAaaa } from "./aaaa-service";
import { getHostGlobalIpv6 } from "@/lib/host-address";
import {
    callNodeIp,
    callReach,
    callsOutside,
    cgnatVerdict,
    recommendPath,
    type CallReach,
    type CallsOutside,
    type InboundPath,
    type InboundReach
} from "./inbound";
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
/** The relay server's own hostnames kept out of the routes to the house. */
const MAX_SERVED_NAMES = 2_000;

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
    /** The ports both ends were last brought up with. */
    tcp: z.array(z.number()).default([]),
    udp: z.array(z.number()).default([]),
    /** The routes last given to the relay server's edge. */
    routes: z.string().nullable().default(null)
});

/** Why a path cannot be used right now, as a key the screen words. */
const PATH_PROBLEMS = [
    "no-token",
    "no-domain",
    "no-daemon",
    "no-server",
    "no-address",
    "ports-busy",
    "ports-held",
    "edge-outdated",
    "relay-unreachable",
    "setting-up",
    "failed"
] as const;
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

/** Why callers outside the house cannot reach a call now, or null when they can. */
export async function callsOutsideNow(): Promise<CallsOutside | null> {
    const [config, state, relay, reach] = await Promise.all([
        readConfig(),
        getSetting(BACKUP_STATE_KEY).then(readState),
        getSetting(RELAY_KEY).then((raw) => parse(relaySchema, raw)),
        readInboundReach().catch(() => null)
    ]);
    return callsOutside({
        cgnat: reach?.cgnat ?? false,
        serving: state.serving,
        path: config.path,
        relayAddress: relay?.address ?? null
    });
}

/** What Admin -> Domains shows. */
export interface BackupView {
    readonly configured: boolean;
    readonly config: BackupConfig;
    readonly state: FlipState;
    readonly probe: Probe | null;
    readonly tunnelReady: boolean;
    readonly relay: { address: string; tcp: number[]; udp: number[] } | null;
    readonly servers: { id: string; name: string }[];
    readonly cloudflare: boolean;
    /** Whether visitors can reach the line itself; null before the first check. */
    readonly reach: InboundReach | null;
    /** Tailscale is connected here, so its private way in is open. */
    readonly tailscale: boolean;
    /** The path Polaris recommends for this line. */
    readonly recommended: InboundPath;
    /** How a caller outside the house reaches the call media now. */
    readonly calls: CallReach;
    /** This server's IPv6 way in: the address, and what its AAAA records hold. */
    readonly ipv6: {
        readonly address: string | null;
        readonly inbound: boolean | null;
        readonly published: string | null;
        readonly problem: "no-cloudflare" | "failed" | null;
    };
}

export async function backupView(): Promise<BackupView> {
    const [zones, config, state, probe, tunnel, relay, token, servers, reach, tailscale, aaaa] =
        await Promise.all([
            getDomainZones().catch(() => null),
            readConfig(),
            getSetting(BACKUP_STATE_KEY).then(readState),
            getSetting(PROBE_KEY).then((raw) => parse(probeSchema, raw)),
            getSetting(TUNNEL_KEY).then((raw) => parse(tunnelSchema, raw)),
            getSetting(RELAY_KEY).then((raw) => parse(relaySchema, raw)),
            loadCloudflareToken().catch(() => null),
            prisma.deployTarget
                .findMany({
                    where: { status: "active", kind: { not: "local" }, owner: { isAdmin: true } },
                    select: { id: true, name: true },
                    orderBy: { name: "asc" },
                    take: 100
                })
                .catch(() => []),
            readInboundReach().catch(() => null),
            getTailscaleHost()
                .then(Boolean)
                .catch(() => false),
            readAaaa().catch(() => null)
        ]);
    const cgnat = reach?.cgnat ?? false;
    return {
        configured: Boolean(zones?.baseDomain),
        config,
        state,
        probe,
        tunnelReady: tunnel !== null,
        relay: relay ? { address: relay.address, tcp: relay.tcp, udp: relay.udp } : null,
        servers,
        cloudflare: Boolean(token),
        reach,
        tailscale,
        recommended: recommendPath({
            cgnat,
            hasServer: servers.length > 0,
            cloudflare: Boolean(token),
            tailscale
        }),
        calls: callReach({
            cgnat,
            serving: state.serving,
            path: config.path,
            relayAddress: relay?.address ?? null
        }),
        ipv6: {
            address: reach?.ipv6 ?? null,
            inbound: reach?.ipv6Inbound ?? null,
            published: aaaa?.published ?? null,
            problem: aaaa?.problem ?? null
        }
    };
}

/** Save the operator's choices, then bring the chosen path up and run a pass. */
export async function saveConfig(next: BackupConfig): Promise<void> {
    const previous = await readConfig();
    await setSetting(BACKUP_CONFIG_KEY, JSON.stringify(configSchema.parse(next)));
    forgetBackupAccess();
    // A path still serving is retired by the pass, once the records have left it.
    const serving = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY))?.target.kind ?? null;
    if (previous.path === "relay" && next.path !== "relay" && serving !== "relay")
        await retireRelay().catch(() => undefined);
    if (previous.path === "tunnel" && next.path !== "tunnel" && serving !== "tunnel")
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
            target =
                config.path === "tunnel"
                    ? await warmTunnel(zones.baseDomain)
                    : await warmRelay(config);
        } catch (caught) {
            problem = caught instanceof PathRefusal ? caught.code : "failed";
            detail = caught instanceof PathRefusal ? caught.detail : message(caught);
        }
    }
    const saved = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY));
    // While on backup, a path that failed to warm is still the one serving.
    if (!target && saved && config.path) target = saved.target;

    const { evidence, ...measured } = await measure(
        before,
        previous.serving,
        uplink,
        config.relayTargetId,
        zones.baseDomain
    );
    // A relay that answers on its own but does not carry a visitor home. Never
    // moved onto, since that swaps a line for nothing; while already on it, the
    // records stay where they are, because the line that failed is no better.
    const deadRelay =
        uplink && config.path === "relay" && target !== null && measured.latency.relay === null;
    if (deadRelay) {
        problem = problem ?? "relay-unreachable";
        detail = detail ?? String(RELAY_LISTEN_PORT);
    }
    // The IPv6 way in: this box's own global address, checked from outside the
    // same way as the line. Published as AAAA only once that check gets in.
    const ipv6 = uplink ? await getHostGlobalIpv6().catch(() => null) : null;
    const v6 = ipv6 ? await checkFromOutside(config.relayTargetId, ipv6) : null;
    const ipv6Inbound = v6 ? v6.answer.verdict === "up" : null;
    const reach = uplink
        ? await refreshInboundReach({
              publicIp: evidence.ip,
              outside: evidence.outside,
              hairpin: evidence.hairpin,
              ipv6,
              ipv6Inbound
          }).catch(() => null)
        : null;
    if (uplink) await syncAaaa({ ipv6, inbound: ipv6Inbound }).catch(() => undefined);
    // A carrier NAT takes no visitors whatever the probes say: a hairpin to the
    // carrier's address can even answer from somebody else's router.
    const cgnat = cgnatVerdict(reach, evidence.ip);
    const verdict: Verdict =
        cgnat.down && measured.verdict !== "no-uplink" ? "down" : measured.verdict;
    const now = new Date();
    const decision = decide(previous, {
        mode: config.mode,
        manualOn: config.manualOn,
        pathReady: target !== null && !(deadRelay && previous.serving === "direct"),
        verdict,
        failToFlip: cgnat.failToFlip,
        now
    });

    let conflicts: string[] = [];
    let moved: string | null = null;
    try {
        if (decision.move === "to-backup" && target) await toBackup(zones.baseDomain, target);
        // A path changed while on backup: the records follow it before the old one goes.
        else if (
            decision.state.serving === "backup" &&
            target &&
            saved &&
            !sameTarget(saved.target, target)
        )
            await toBackup(zones.baseDomain, target);
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
            JSON.stringify({
                ...decision.state,
                serving: previous.serving,
                since: previous.since,
                lastFlip: previous.lastFlip
            })
        );
    }
    if (uplink) {
        try {
            await arm(zones.baseDomain, target !== null);
            await retireUnused(config);
        } catch (caught) {
            problem = problem ?? "failed";
            detail = detail ?? message(caught);
        }
        const serving = (await getSetting(BACKUP_STATE_KEY).then(readState)).serving;
        const relay = parse(relaySchema, await getSetting(RELAY_KEY));
        const relayIp = callNodeIp({
            serving,
            path: config.path,
            relayAddress: relay?.address ?? null
        });
        try {
            await syncCallNodeIp(relayIp);
        } catch (caught) {
            console.error("polaris: could not point the call server at the relay:", caught);
        }
        // The tunnels that end here are dialed through the relay the same way.
        await followHomeRelay(relayIp).catch((caught: unknown) => {
            console.error("polaris: could not point the tunnels at the relay:", caught);
        });
    }
    await setSetting(
        PROBE_KEY,
        JSON.stringify({
            ...measured,
            verdict,
            checkedAt: now.toISOString(),
            problem,
            detail,
            conflicts
        } satisfies Probe)
    );
    return { verdict, move: moved };
}

class PathRefusal extends Error {
    constructor(
        readonly code: Exclude<PathProblem, null>,
        readonly detail: string | null = null
    ) {
        super(code);
    }
}

/** Every owned name's address records, as they are now. */
async function liveRecords(
    baseDomain: string
): Promise<{ token: string; zoneId: string; live: LiveRecord[] }> {
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

/** `armed` is null once records were written back and have to be looked at again. */
const ttlSchema = z.object({
    armed: z.boolean().nullable(),
    ttl: z.record(z.string(), z.number())
});

/** Short TTLs on DNS-only records while a flip may come; their own back after. */
async function arm(baseDomain: string, armed: boolean): Promise<void> {
    const stored = parse(ttlSchema, await getSetting(TTL_KEY));
    if ((stored?.armed ?? false) === armed) return;
    const { token, zoneId, live } = await liveRecords(baseDomain);
    const plan = planTtl(live, armed, stored?.ttl ?? {});
    // Every TTL about to be shortened is remembered first, and the state only
    // changes once the writes landed, so a pass cut short is planned again.
    await setSetting(
        TTL_KEY,
        JSON.stringify({
            armed: stored?.armed ?? null,
            ttl: { ...stored?.ttl, ...plan.remembered }
        })
    );
    await apply(token, zoneId, plan.ops);
    await setSetting(TTL_KEY, JSON.stringify({ armed, ttl: plan.remembered }));
}

async function forgetArmed(): Promise<void> {
    const stored = parse(ttlSchema, await getSetting(TTL_KEY));
    if (stored && stored.armed !== null)
        await setSetting(TTL_KEY, JSON.stringify({ ...stored, armed: null }));
}

function sameTarget(a: BackupTarget, b: BackupTarget): boolean {
    return a.kind === "tunnel"
        ? b.kind === "tunnel" && a.tunnelId === b.tunnelId
        : b.kind === "relay" && a.address === b.address;
}

async function toBackup(baseDomain: string, target: BackupTarget): Promise<void> {
    const { token, zoneId, live } = await liveRecords(baseDomain);
    // The originals are saved before the first write and never replaced while a
    // flip is under way, so a repeated pass cannot remember the backup as original.
    const saved = parse(recordsSchema, await getSetting(BACKUP_RECORDS_KEY));
    const plan = planFlip(live, target, saved?.originals);
    if (!saved)
        await setSetting(
            BACKUP_RECORDS_KEY,
            JSON.stringify({ zoneId, target, originals: plan.originals })
        );
    // Moving between paths keeps the originals and only changes what is restored over.
    else if (!sameTarget(saved.target, target))
        await setSetting(BACKUP_RECORDS_KEY, JSON.stringify({ ...saved, target }));
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
    // The originals came back with whatever TTL they had when saved.
    await forgetArmed();
    return plan.conflicts;
}

/** Take down a path that is no longer chosen, once no record points at it. */
async function retireUnused(config: BackupConfig): Promise<void> {
    const [serving, tunnel, relay] = await Promise.all([
        getSetting(BACKUP_RECORDS_KEY).then(
            (raw) => parse(recordsSchema, raw)?.target.kind ?? null
        ),
        getSetting(TUNNEL_KEY),
        getSetting(RELAY_KEY)
    ]);
    if (tunnel && config.path !== "tunnel" && serving !== "tunnel") await retireTunnel();
    if (relay && config.path !== "relay" && serving !== "relay") await retireRelay();
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
        if (token)
            await deleteTunnel(token, stored.accountId, stored.tunnelId).catch(() => undefined);
    }
    await setSetting(TUNNEL_KEY, null);
}

/** A target row as `getPorts` takes it, with the address the house dials. */
async function relayTarget(id: string, anyOwner = false) {
    const row = await prisma.deployTarget.findFirst({
        where: {
            id,
            status: "active",
            kind: { not: "local" },
            ...(anyOwner ? {} : { owner: { isAdmin: true } })
        },
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
    // Another server was picked: its relay end comes down, the house end is replaced below.
    if (stored && stored.targetId !== target.id)
        await retireRelayEnd(stored.targetId).catch(() => undefined);
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
            udp: [],
            routes: null
        };
    }
    // The ports the installed game servers publish, as the router is asked to
    // forward them; a server added or removed changes what both ends carry.
    const games = await forwardedPorts().catch(() => []);
    // The call media rides the relay too: without it a call through the relay
    // joins and carries no sound.
    // So do the WireGuard tunnels whose public end is this machine: their peers
    // dial its listen port, which a carrier NAT never lets in.
    const tunnels = await homeListenPorts().catch(() => []);
    const ports = relayPorts([
        ...games.flatMap((row) => row.ports),
        ...CALL_PORTS,
        ...tunnels.map((port) => ({ port, protocol: "udp" as const }))
    ]);
    // Fresh keys start with no ports, so they always bring both ends up again; a
    // relay brought up before UDP was carried stored none, so one with UDP game
    // ports comes up again with them.
    const changed =
        stored.routes === null ||
        stored.tcp.join(",") !== ports.tcp.join(",") ||
        stored.udp.join(",") !== ports.udp.join(",");
    const names = await ownedZoneNames(await getDomainZones());
    if (names.length === 0) throw new PathRefusal("no-domain");
    const served = await prisma.domain.findMany({
        where: { enabled: true, servedBy: "server", application: { targetId: target.id } },
        select: { hostname: true },
        orderBy: { hostname: "asc" },
        take: MAX_SERVED_NAMES
    });
    const routes = renderRelayRoutes(
        names,
        served.map((domain) => domain.hostname)
    );
    // The keys are kept now and the ports only once both ends run with them, so a
    // bring-up that failed is tried again on the next pass.
    await setSetting(RELAY_KEY, JSON.stringify(stored));
    const keys = {
        relay: { publicKey: stored.relayPublic, privateKey: openKey(stored.relayPrivate) },
        home: { publicKey: stored.homePublic, privateKey: openKey(stored.homePrivate) }
    };
    const configs = relayConfigs(keys, address, ports);
    await shareServerEdge(target);
    await keepUp(
        await getPorts(target, target.ownerId),
        relayProject("relay"),
        () => relaySpec("relay", configs.relay, ports, [target.proxyNetwork]),
        changed
    ).catch((caught: unknown) => {
        // The server already publishes one of the ports for something of its own.
        throw /port is already allocated|address already in use|bind for/i.test(message(caught))
            ? new PathRefusal("ports-busy")
            : caught;
    });
    await keepUp(
        new HostdPorts(),
        relayProject("home"),
        () => relaySpec("home", configs.home, ports),
        changed
    );
    if (changed || stored.routes !== routes) {
        await (await relayEdge(target)).pushFile(RELAY_ROUTES_FILE, routes);
        await setSetting(
            RELAY_KEY,
            JSON.stringify({ ...stored, tcp: ports.tcp, udp: ports.udp, routes })
        );
    }
    return { kind: "relay", address };
}

async function relayEdge(target: { hostId: string | null; ownerId: string }) {
    if (!target.hostId) throw new PathRefusal("no-server");
    return new RemoteRouter(await getHostConnection(target.hostId, target.ownerId));
}

type RelayTarget = Awaited<ReturnType<typeof relayTarget>>;

/**
 * The relay shares the server's edge instead of taking its ports, so the server
 * stays free to serve its own apps. A missing edge is set up here; a running one
 * too old to carry the relay is left for the operator to replace, since that stops
 * what it serves for a moment; a program of somebody else's on the ports is reported
 * by name, because stopping it is the operator's call too. A relay from before the
 * edge holds the ports itself, so it comes down first and is started again after.
 */
async function shareServerEdge(target: RelayTarget): Promise<void> {
    const { hostId, ownerId, proxyNetwork } = target;
    if (!hostId) throw new PathRefusal("no-server");
    if (isSettingUp(hostId)) throw new PathRefusal("setting-up");
    const edge = await readServerEdge(hostId, ownerId);
    if (edge.error) throw new Error(edge.error);
    if (edge.traefik && edge.pushable && edge.challenges) return;
    if (edge.traefik) throw new PathRefusal("edge-outdated");
    let holders = await serverPortHolders(hostId, ownerId);
    if (holders.includes(relayHelper())) {
        await stopRelayEnd(target);
        holders = await serverPortHolders(hostId, ownerId);
    }
    if (holders.length > 0) throw new PathRefusal("ports-held", holders.join(", "));
    await withSetupLock(hostId, () => prepareServerEdge(hostId, ownerId, proxyNetwork));
}

/** Why a repair asked for on the card did not happen, as a key the card words. */
export type RelayRepairFailure = "no-server" | "not-web-server" | "refused";

/** The relay server, or the failure to report; anything that goes wrong in `task` is
 *  logged and answered as a key, because the browser never sees a server's message. */
async function repairRelay(
    task: (target: RelayTarget, hostId: string) => Promise<void>
): Promise<RelayRepairFailure | null> {
    try {
        const config = await readConfig();
        if (!config.relayTargetId) return "no-server";
        const target = await relayTarget(config.relayTargetId);
        if (!target.hostId) return "no-server";
        await task(target, target.hostId);
        return null;
    } catch (caught) {
        if (caught instanceof PathRefusal) {
            if (caught.code === "no-server") return "no-server";
            if (caught.code === "ports-held") return "not-web-server";
        }
        console.error("polaris: could not repair the relay server:", caught);
        return "refused";
    }
}

/**
 * Stop the web servers holding the relay server's ports, on the operator's word, so
 * the next pass can put the edge there. Refuses anything but a web server.
 */
export function freeRelayPorts(): Promise<RelayRepairFailure | null> {
    return repairRelay(async (target, hostId) => {
        const holders = await serverPortHolders(hostId, target.ownerId);
        if (holders.length === 0) return;
        if (!holdersCanBeFreed(holders)) throw new PathRefusal("ports-held", holders.join(", "));
        await freeServerPorts(hostId, target.ownerId, holders);
    });
}

/** Replace the relay server's outdated edge, on the operator's word. */
export function updateRelayEdge(): Promise<RelayRepairFailure | null> {
    return repairRelay((target, hostId) =>
        withSetupLock(hostId, () => prepareServerEdge(hostId, target.ownerId, target.proxyNetwork))
    );
}

async function retireRelay(): Promise<void> {
    const stored = parse(relaySchema, await getSetting(RELAY_KEY));
    const home = new HostdPorts();
    try {
        await home.composeDown(relayProject("home"));
    } finally {
        await home.dispose();
    }
    if (stored) await retireRelayEnd(stored.targetId);
    await setSetting(RELAY_KEY, null);
}

async function retireRelayEnd(targetId: string): Promise<void> {
    // Taking our own relay down, wherever it was left.
    const target = await relayTarget(targetId, true).catch(() => null);
    if (!target) return;
    await stopRelayEnd(target);
    await (await relayEdge(target)).clearFile(RELAY_ROUTES_FILE).catch(() => undefined);
}

async function stopRelayEnd(target: RelayTarget): Promise<void> {
    const ports = await getPorts(target, target.ownerId);
    try {
        await ports.composeDown(relayProject("relay"));
    } finally {
        await ports.dispose();
    }
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
            throw /hostd|ECONNREFUSED|ENOENT|501/i.test(message(caught))
                ? new PathRefusal("no-daemon")
                : caught;
        });
        if (changed || running.length === 0) await ports.composeUp(spec());
    } finally {
        await ports.dispose();
    }
}

/** How long a TCP connection takes to open, or null when it does not. */
export function connectTime(
    host: string,
    port: number,
    timeoutMs = CONNECT_TIMEOUT_MS
): Promise<number | null> {
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
    relayTargetId: string | null,
    baseDomain: string
): Promise<Measured> {
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
            lastIp: before?.lastIp ?? null,
            evidence: { ip: null, outside: null, hairpin: false }
        };
    const [direct, tunnelMs, relayMs, ip] = await Promise.all([
        published ? connectTime(published, 443) : Promise.resolve(null),
        tunnel ? connectTime(TUNNEL_EDGE.host, TUNNEL_EDGE.port) : Promise.resolve(null),
        relay ? tlsTime(relay.address, 443, baseDomain, CONNECT_TIMEOUT_MS) : Promise.resolve(null),
        probePublicIp(0)
    ]);
    const nowCalibrated = calibrated || direct !== null;
    let inside: Verdict;
    if (nowCalibrated) inside = direct !== null ? "up" : "down";
    else if (!ip || !published) inside = "unknown";
    // On backup the follower stands back, so a line back on a new address is "up"
    // once it holds still; the follower repoints it after the records are restored.
    else
        inside =
            ip === published || (serving === "backup" && ip === before?.lastIp) ? "up" : "down";
    // The address visitors would reach today: the one the line has now, else the
    // one the records were last given.
    const outside = await checkFromOutside(relayTargetId, ip ?? published);
    const { verdict } = combineVerdicts(inside, outside?.answer ?? null);
    return {
        verdict,
        latency: { direct: direct ?? outside?.answer.ms ?? null, tunnel: tunnelMs, relay: relayMs },
        calibrated: nowCalibrated,
        from: outside?.from ?? null,
        lastIp: ip ?? before?.lastIp ?? null,
        evidence: {
            ip,
            // Only a check aimed at the address the line has now says anything about it.
            outside: ip && outside ? outside.answer.verdict : null,
            hairpin: direct !== null && ip !== null && ip === published
        }
    };
}

type Measured = Omit<Probe, "checkedAt" | "problem" | "detail" | "conflicts"> & {
    readonly evidence: {
        readonly ip: string | null;
        readonly outside: "up" | "down" | null;
        readonly hairpin: boolean;
    };
};

/**
 * The cloud server that checks from outside: the relay's own when the relay path
 * is chosen, else the first active machine enrolled as a VPS or cloud server. A
 * machine whose address is the house's own is not outside.
 */
async function outsideMachine(relayTargetId: string | null, homeAddress: string) {
    const preferred = relayTargetId
        ? await prisma.deployTarget.findFirst({
              where: { id: relayTargetId, owner: { isAdmin: true } },
              select: { hostId: true }
          })
        : null;
    const hosts = await prisma.host.findMany({
        where: {
            status: "active",
            owner: { isAdmin: true },
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
    const rows = await prisma.user
        .findMany({ where: { isAdmin: true }, select: { id: true } })
        .catch(() => []);
    const on = state.serving === "backup";
    for (const { id: userId } of rows) {
        const t = await wordsFor(userId, "notices");
        await notices
            .createNotification({
                userId,
                href: "/admin/domains/remote-access#backup-access",
                type: on ? "domain.backup-on" : "domain.backup-off",
                level: on ? "warning" : "success",
                title: on
                    ? t("backupAccess.onTitle", { domain })
                    : t("backupAccess.offTitle", { domain }),
                body: t(noticeBody(state.lastFlip?.reason ?? null, on))
            })
            .catch(() => undefined);
    }
}

/** Why the domain moved, as the bell words it: each reason says something different. */
function noticeBody(reason: Flip["reason"] | null, on: boolean) {
    if (reason === "always") return "backupAccess.onAlwaysBody";
    if (reason === "manual") return on ? "backupAccess.onManualBody" : "backupAccess.offManualBody";
    if (reason === "unconfigured") return "backupAccess.offUnconfiguredBody";
    return on ? "backupAccess.onBody" : "backupAccess.offBody";
}

function message(caught: unknown): string {
    return caught instanceof Error ? caught.message : String(caught);
}
