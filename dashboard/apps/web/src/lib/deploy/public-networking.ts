/**
 * A service's public networking, past adding a domain: which ports it listens on,
 * a port per domain, a generated name renamed in place, what each custom
 * hostname's DNS and certificate say, and raw TCP published on a port of its own.
 *
 * Every read here is bounded and cached for a short while, because the panel that
 * asks is open for minutes at a time and the answers come from somebody else's
 * resolver, a TLS handshake or a command inside a container. Nothing here holds a
 * credential: the DNS answers are public, the certificate is what any visitor is
 * shown, and the socket table is read through the same runtime ports the terminal
 * uses.
 *
 * Server-only.
 */

import { connect } from "node:tls";
import { prisma, Prisma } from "@polaris/db";
import { getPorts } from "./runtime";
import { currentReleaseRef } from "./releases";
import { getPublicIp } from "@/lib/domain-service";
import { isPrivateIp, isWildcardHostname } from "@polaris/core";
import { listDeployZones } from "@/lib/domain-zones";
import { detectPublicIp } from "@/lib/network-service";
import { resolve4, resolve6, resolveCname, resolveSoa } from "node:dns/promises";
import { checkZoneSubdomain, containerPortOf, syncAppRoutes } from "@/lib/deploy-service";
import * as net from "./public-net";

/** How long an answer is reused. Short: the panel is where somebody fixes DNS and
 *  waits to see it turn green. */
const CACHE_MS = 30_000;
const CACHE_LIMIT = 500;
const LOOKUP_TIMEOUT_MS = 4_000;
const PORTS_TIMEOUT_MS = 6_000;
/** More domains than this on one service are listed without a reading. */
const DETAIL_LIMIT = 20;
/** Raw TCP doors one service may hold. */
export const TCP_PROXY_LIMIT = 8;

/** Why a change was refused, as a code the action turns into a sentence in the
 *  reader's language. */
export type PublicNetRefusalCode =
    | "notFound"
    | "badPort"
    | "notRenameable"
    | "badName"
    | "zoneUnavailable"
    | "taken"
    | "renameFailed"
    | "proxyLimit"
    | "rangeFull"
    | "portFixed";

export class PublicNetRefusal extends Error {
    public constructor(
        public readonly code: PublicNetRefusalCode,
        public readonly params: Readonly<Record<string, string | number>> = {}
    ) {
        super(code);
        this.name = "PublicNetRefusal";
    }
}

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), value });
    return value;
}

function forget(prefix: string): void {
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
        work.catch(() => fallback),
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.())
    ]);
}

function parseSource(json: string): Record<string, unknown> {
    try {
        const value = JSON.parse(json) as unknown;
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

/** A service, scoped to the owner the caller was granted access through. */
async function ownedApp(applicationId: string, ownerId: string) {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            id: true,
            slug: true,
            sourceType: true,
            sourceConfig: true,
            currentDeploymentId: true,
            targetId: true,
            target: {
                select: {
                    id: true,
                    kind: true,
                    hostId: true,
                    runtime: true,
                    proxyNetwork: true,
                    host: { select: { address: true } }
                }
            },
            environment: { select: { project: { select: { slug: true, ownerId: true, orgId: true } } } },
            domains: {
                where: { kind: { not: "release" } },
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    hostname: true,
                    kind: true,
                    enabled: true,
                    targetPort: true,
                    portPinned: true,
                    certResolver: true,
                    certPem: true
                }
            }
        }
    });
    if (!app) throw new PublicNetRefusal("notFound");
    return app;
}

/** What a service listens on: where the edge dials it by default, and every port
 *  a domain could be pointed at instead. */
export interface ServicePorts {
    /** The port the service's own domains follow. */
    readonly servicePort: number;
    /** Ports seen listening, sorted; at least the service port when nothing could
     *  be read. */
    readonly ports: readonly number[];
    /** Where `ports` came from: read inside the running container, or only what
     *  the service is configured with. */
    readonly source: "runtime" | "config";
}

/**
 * The ports a service listens on, read from the kernel's socket table inside the
 * container that serves it.
 *
 * Read with `cat`, which every image built on a distribution carries. An image
 * with no shell tools at all (distroless) answers nothing, and the service's own
 * configured port is offered instead - which is also what a service that is not
 * running gets, since there is nothing to ask.
 */
export async function serviceListeningPorts(applicationId: string, ownerId: string): Promise<ServicePorts> {
    const app = await ownedApp(applicationId, ownerId);
    const servicePort = containerPortOf(app);
    const fallback: ServicePorts = { servicePort, ports: [servicePort], source: "config" };
    if (!app.currentDeploymentId) return fallback;
    return cached(`ports:${app.id}:${app.currentDeploymentId}`, async () => {
        const ports = await getPorts(app.target, app.environment.project.ownerId).catch(() => null);
        if (!ports) return fallback;
        try {
            const release = await currentReleaseRef(app);
            const result = await withTimeout(
                ports.runIn(release.name, ["cat", "/proc/net/tcp", "/proc/net/tcp6"]),
                PORTS_TIMEOUT_MS,
                null
            );
            // tcp6 is absent on a kernel without IPv6, which makes cat exit non-zero
            // after printing tcp - so the output is read whatever the status.
            const found = result ? net.parseListeningPorts(result.output) : [];
            if (found.length === 0) return fallback;
            return { servicePort, ports: found, source: "runtime" } satisfies ServicePorts;
        } finally {
            await ports.dispose().catch(() => undefined);
        }
    });
}

/**
 * Point one domain at a port of its own - Railway's "target port" per domain.
 *
 * Pinned, so the edge dials that port whatever the service's own port is or
 * later becomes. Setting it back to the service's port unpins it, which is the
 * state every domain was in before this existed.
 */
export async function setDomainPort(domainId: string, ownerId: string, port: number): Promise<void> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new PublicNetRefusal("badPort");
    const domain = await prisma.domain.findFirst({
        where: { id: domainId, application: { environment: { project: { ownerId } } } },
        select: {
            id: true,
            deploymentId: true,
            servedBy: true,
            application: {
                select: {
                    sourceType: true,
                    sourceConfig: true,
                    currentDeploymentId: true,
                    target: { select: { kind: true, hostId: true } }
                }
            }
        }
    });
    if (!domain) throw new PublicNetRefusal("notFound");
    const servicePort = containerPortOf(domain.application);
    if (port !== servicePort) {
        const { currentDeploymentId, target } = domain.application;
        const keptRelease = currentDeploymentId
            ? (await prisma.deployment.count({
                  where: { id: currentDeploymentId, isolated: true, cutover: false }
              })) > 0
            : false;
        const remote = target.kind !== "local" && target.hostId !== null;
        if (!net.dialsPinnedPort(domain, { remote, keptRelease })) throw new PublicNetRefusal("portFixed");
    }
    await prisma.domain.update({
        where: { id: domain.id },
        data: { targetPort: port, portPinned: port !== servicePort }
    });
    await syncAppRoutes().catch(() => undefined);
}

/** Which zone a hostname was minted in, when it was minted in one: its parent is
 *  a deploy zone and what is left of it is one label. */
async function zoneOf(
    hostname: string,
    project: { ownerId: string; orgId: string | null }
): Promise<{ label: string; host: string; subdomain: string } | null> {
    const owner = project.orgId ? { kind: "org" as const, id: project.orgId } : { kind: "user" as const, id: project.ownerId };
    const zones = await listDeployZones(owner);
    for (const zone of zones) {
        if (zone.kind === "base") continue;
        const suffix = `.${zone.host}`;
        if (!hostname.endsWith(suffix)) continue;
        const subdomain = hostname.slice(0, -suffix.length);
        if (subdomain && !subdomain.includes(".")) return { label: zone.label, host: zone.host, subdomain };
    }
    return null;
}

/** Whether a domain's name can be edited in place, and in which zone. */
export async function renameableZone(domainId: string, ownerId: string) {
    const domain = await prisma.domain.findFirst({
        where: { id: domainId, application: { environment: { project: { ownerId } } } },
        select: {
            hostname: true,
            kind: true,
            applicationId: true,
            application: { select: { environment: { select: { project: { select: { ownerId: true, orgId: true } } } } } }
        }
    });
    if (!domain || (domain.kind !== "auto" && domain.kind !== "random")) return null;
    const zone = await zoneOf(domain.hostname, domain.application.environment.project);
    return zone ? { ...zone, applicationId: domain.applicationId } : null;
}

/**
 * Give a generated name a different subdomain in the same zone.
 *
 * The zone's wildcard already covers the new name, so nothing has to be written
 * in DNS; the edge picks the new route up within seconds and the old name stops
 * answering for this service, as it does on Railway.
 */
export async function renameDomain(domainId: string, ownerId: string, subdomain: string): Promise<string> {
    const zone = await renameableZone(domainId, ownerId);
    if (!zone) throw new PublicNetRefusal("notRenameable");
    const check = await checkZoneSubdomain(zone.applicationId, ownerId, { zoneLabel: zone.label, subdomain });
    if (typeof check === "string") throw new PublicNetRefusal(check === "bad-name" ? "badName" : "zoneUnavailable");
    if (check.invalid) throw new PublicNetRefusal("badName");
    if (!check.hostname) throw new PublicNetRefusal("zoneUnavailable");
    const current = await prisma.domain.findUnique({ where: { id: domainId }, select: { hostname: true } });
    if (current?.hostname === check.hostname) return check.hostname;
    if (!check.available) throw new PublicNetRefusal("taken", { hostname: check.hostname });
    try {
        await prisma.domain.update({
            where: { id: domainId },
            data: { hostname: check.hostname, healthStatus: "unknown", healthCheckedAt: null, healthFailures: 0 }
        });
    } catch (caught) {
        if (caught && typeof caught === "object" && "code" in caught && caught.code === "P2002") {
            throw new PublicNetRefusal("taken", { hostname: check.hostname });
        }
        throw new PublicNetRefusal("renameFailed");
    }
    await syncAppRoutes().catch(() => undefined);
    return check.hostname;
}

/** One DNS record somebody has to create at their DNS provider. */
export interface DnsRecordAdvice {
    readonly type: "A" | "AAAA" | "CNAME";
    readonly name: string;
    readonly value: string;
}

/** What one domain's DNS and certificate were found to be. */
export interface DomainReading {
    readonly id: string;
    readonly hostname: string;
    /** Only for a name somebody brought: a generated one rides Polaris's own DNS. */
    readonly dns: {
        readonly verdict: net.DnsVerdict;
        readonly addresses: readonly string[];
        readonly cnames: readonly string[];
        /** The records that make it work, preferred first. */
        readonly records: readonly DnsRecordAdvice[];
        /** The zone's own top: a CNAME cannot live there. */
        readonly apex: boolean;
        readonly wildcard: boolean;
    } | null;
    readonly cert: {
        /** `unknown` when no handshake could be made from here: the address did
         *  not answer this server, which says nothing about the certificate. */
        readonly verdict: net.CertVerdict | "pending" | "failed" | "unknown";
        readonly issuer: string | null;
        readonly validTo: string | null;
        readonly daysLeft: number | null;
        readonly supplied: boolean;
    } | null;
}

async function lookup(hostname: string): Promise<{ addresses: string[]; cnames: string[] }> {
    const [v4, v6, cnames] = await Promise.all([
        withTimeout(resolve4(hostname), LOOKUP_TIMEOUT_MS, [] as string[]),
        withTimeout(resolve6(hostname), LOOKUP_TIMEOUT_MS, [] as string[]),
        withTimeout(resolveCname(hostname), LOOKUP_TIMEOUT_MS, [] as string[])
    ]);
    return { addresses: [...v4, ...v6], cnames };
}

/** Whether a name is the top of its DNS zone - it carries the zone's SOA. Asked
 *  of DNS rather than guessed from the number of labels, which is wrong for every
 *  `co.uk`. */
async function isZoneApex(hostname: string): Promise<boolean> {
    const soa = await withTimeout(resolveSoa(hostname).then(() => true), LOOKUP_TIMEOUT_MS, false);
    return soa;
}

/** The certificate a visitor is shown on a hostname, read with one handshake.
 *  Only ever made to a public address, so a stored name never points this
 *  server's handshake at its own network. */
async function readCertificate(hostname: string): Promise<{ validTo: Date; issuer: string | null; trusted: boolean } | null> {
    const { addresses } = await lookup(hostname);
    const address = addresses[0];
    if (!address || addresses.some((entry) => isPrivateIp(entry))) return null;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: { validTo: Date; issuer: string | null; trusted: boolean } | null) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        const socket = connect({ host: address, port: 443, servername: hostname, rejectUnauthorized: false });
        socket.setTimeout(LOOKUP_TIMEOUT_MS, () => finish(null));
        socket.once("error", () => finish(null));
        socket.once("secureConnect", () => {
            const peer = socket.getPeerCertificate();
            const validTo = peer?.valid_to ? new Date(peer.valid_to) : null;
            if (!validTo || Number.isNaN(validTo.getTime())) return finish(null);
            const issuer = peer.issuer?.O || peer.issuer?.CN || null;
            finish({ validTo, issuer: typeof issuer === "string" ? issuer : null, trusted: socket.authorized });
        });
    });
}

/**
 * What each of a service's domains is found to be: for a name somebody brought,
 * where its DNS points and the records that would make it point here; for any
 * name served over HTTPS, the certificate visitors get.
 *
 * The record offered first is a CNAME to one of the service's own generated
 * names where it has one, the way Railway hands out `<x>.up.railway.app`: it
 * follows the service if the server's address ever changes. At a zone apex, where
 * DNS allows no CNAME, it is an A record to the server - which every provider
 * takes, so the flattening Railway needs there is not needed here.
 */
export async function domainReadings(applicationId: string, ownerId: string): Promise<DomainReading[]> {
    const app = await ownedApp(applicationId, ownerId);
    const remote = app.target.kind !== "local" ? (app.target.host?.address?.trim() ?? null) : null;
    const expectedIp = remote && /^[\d.]+$|:/.test(remote) ? remote : remote ? null : await detectPublicIp().catch(() => null);
    const own = app.domains
        .filter((domain) => domain.kind === "auto" || domain.kind === "random")
        .map((domain) => domain.hostname)
        .filter((hostname) => !hostname.endsWith(".plr.local"));
    const managed = await prisma.managedCertificate.findMany({
        where: {
            domain: {
                in: app.domains
                    .filter((domain) => isWildcardHostname(domain.hostname))
                    .flatMap((domain) => [domain.hostname, domain.hostname.slice(2)])
            }
        },
        select: { domain: true, status: true, expiresAt: true }
    });
    const now = Date.now();
    const domains = app.domains.filter((domain) => domain.enabled).slice(0, DETAIL_LIMIT);
    return Promise.all(
        domains.map((domain) =>
            cached(`reading:${domain.id}:${domain.hostname}`, async (): Promise<DomainReading> => {
                const wildcard = isWildcardHostname(domain.hostname);
                const brought = domain.kind === "custom" || domain.kind === "base";
                let dns: DomainReading["dns"] = null;
                if (brought) {
                    const probeName = wildcard ? `polaris-check.${domain.hostname.slice(2)}` : domain.hostname;
                    const [reading, apex] = await Promise.all([
                        lookup(probeName),
                        wildcard ? Promise.resolve(false) : isZoneApex(domain.hostname)
                    ]);
                    const records: DnsRecordAdvice[] = [];
                    const cnameTarget = own[0];
                    if (cnameTarget && !apex) records.push({ type: "CNAME", name: domain.hostname, value: cnameTarget });
                    if (expectedIp) {
                        records.push({ type: expectedIp.includes(":") ? "AAAA" : "A", name: domain.hostname, value: expectedIp });
                    }
                    dns = {
                        verdict: net.dnsVerdict(reading, { ip: expectedIp, cnameTargets: own }),
                        addresses: reading.addresses,
                        cnames: reading.cnames,
                        records,
                        apex,
                        wildcard
                    };
                }
                let cert: DomainReading["cert"] = null;
                if (domain.certPem) {
                    cert = { verdict: "valid", issuer: null, validTo: null, daysLeft: null, supplied: true };
                } else if (wildcard) {
                    const row = managed.find(
                        (entry) => entry.domain === domain.hostname || entry.domain === domain.hostname.slice(2)
                    );
                    if (row) {
                        cert = {
                            verdict:
                                row.status === "issued" && row.expiresAt
                                    ? net.certVerdict({ validTo: row.expiresAt, trusted: true }, now)
                                    : row.status === "failed"
                                      ? "failed"
                                      : "pending",
                            issuer: null,
                            validTo: row.expiresAt?.toISOString() ?? null,
                            daysLeft: row.expiresAt ? net.daysUntil(row.expiresAt, now) : null,
                            supplied: false
                        };
                    }
                } else if (domain.certResolver === "le") {
                    const seen = await readCertificate(domain.hostname);
                    cert = seen
                        ? {
                              verdict: net.certVerdict(seen, now),
                              issuer: seen.issuer,
                              validTo: seen.validTo.toISOString(),
                              daysLeft: net.daysUntil(seen.validTo, now),
                              supplied: false
                          }
                        : { verdict: "unknown", issuer: null, validTo: null, daysLeft: null, supplied: false };
                }
                return { id: domain.id, hostname: domain.hostname, dns, cert };
            })
        )
    );
}

/** A service's TCP proxies and where they are reached from. */
export interface TcpProxyView {
    readonly proxies: readonly net.TcpProxy[];
    /** The address people outside connect to: the server's public IP. */
    readonly publicHost: string | null;
    /** The server's address on its own network, for a router forward. */
    readonly lanHost: string | null;
    /** Whether a running release has to be replaced for a change to take effect. */
    readonly deployed: boolean;
}

async function hostsFor(app: Awaited<ReturnType<typeof ownedApp>>): Promise<{ publicHost: string | null; lanHost: string | null }> {
    if (app.target.kind !== "local") {
        const address = app.target.host?.address?.trim() || null;
        return { publicHost: address, lanHost: null };
    }
    const [publicHost, lanHost] = await Promise.all([
        detectPublicIp().catch(() => null),
        getPublicIp().catch(() => null)
    ]);
    return { publicHost, lanHost: lanHost && lanHost !== publicHost ? lanHost : null };
}

export async function listTcpProxies(applicationId: string, ownerId: string): Promise<TcpProxyView> {
    const app = await ownedApp(applicationId, ownerId);
    return {
        proxies: net.tcpProxiesOf(parseSource(app.sourceConfig)),
        ...(await hostsFor(app)),
        deployed: app.currentDeploymentId !== null
    };
}

/**
 * Publish a port of the container on a public port of the machine it runs on.
 *
 * Published by the container runtime, so it is raw TCP with nothing in between:
 * a database, a game, an MQTT broker. The public port is chosen from a band no
 * service's own port is ever drawn from, skipping every port any service
 * already publishes. It takes effect when the service is next started, which
 * the panel offers to do at once.
 */
export async function addTcpProxy(applicationId: string, ownerId: string, containerPort: number): Promise<net.TcpProxy> {
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65_535) {
        throw new PublicNetRefusal("badPort");
    }
    const app = await ownedApp(applicationId, ownerId);
    const proxy = await rewriteSource(app.id, async (source, tx) => {
        const proxies = net.tcpProxiesOf(source);
        const existing = proxies.find((entry) => entry.container === containerPort);
        if (existing) return { result: existing, next: null };
        if (proxies.length >= TCP_PROXY_LIMIT) throw new PublicNetRefusal("proxyLimit", { count: TCP_PROXY_LIMIT });
        const others = await tx.application.findMany({ select: { sourceConfig: true } });
        const taken = new Set(others.flatMap((row) => net.publishedPortsOf(parseSource(row.sourceConfig))));
        const host = net.pickProxyPort(taken, parseInt(app.id.replace(/-/g, "").slice(-6), 16) + containerPort);
        if (host === null) throw new PublicNetRefusal("rangeFull");
        const added: net.TcpProxy = { container: containerPort, host };
        return { result: added, next: { ...source, tcpProxies: [...proxies, added] } };
    });
    forget(`ports:${app.id}`);
    return proxy;
}

export async function removeTcpProxy(applicationId: string, ownerId: string, containerPort: number): Promise<void> {
    const app = await ownedApp(applicationId, ownerId);
    await rewriteSource(app.id, async (source) => {
        const kept = net.tcpProxiesOf(source).filter((proxy) => proxy.container !== containerPort);
        const next: Record<string, unknown> = { ...source };
        if (kept.length > 0) next.tcpProxies = kept;
        else delete next.tcpProxies;
        return { result: undefined, next };
    });
}

type SourceEdit<T> = (
    source: Record<string, unknown>,
    tx: Prisma.TransactionClient
) => Promise<{ result: T; next: Record<string, unknown> | null }>;

/** Read, change and write a service's source config as one serializable unit,
 *  retried when a concurrent writer wins, so neither write is lost and two
 *  services never pick the same public port. */
async function rewriteSource<T>(applicationId: string, edit: SourceEdit<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await prisma.$transaction(
                async (tx) => {
                    const row = await tx.application.findUniqueOrThrow({
                        where: { id: applicationId },
                        select: { sourceConfig: true }
                    });
                    const { result, next } = await edit(parseSource(row.sourceConfig), tx);
                    if (next) {
                        const written = await tx.application.updateMany({
                            where: { id: applicationId, sourceConfig: row.sourceConfig },
                            data: { sourceConfig: JSON.stringify(next) }
                        });
                        if (written.count !== 1) throw new SourceConflict();
                    }
                    return result;
                },
                { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
            );
        } catch (error) {
            const conflict = error instanceof SourceConflict
                || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034");
            if (!conflict || attempt >= 5) throw error;
        }
    }
}

class SourceConflict extends Error {}
