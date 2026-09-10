/**
 * Wildcard certificates for the domains people bring, ordered over DNS-01 and kept
 * renewed without anyone asking.
 *
 * What is wanted is decided in `managed-cert-plan`; this is the half that does it:
 * keep one row per wanted certificate, order the ones that are due through the
 * DNS host the domain lives on, and put what was issued where each edge that
 * serves a name under it will find it - this machine's, and the edge of every
 * other server with a domain the certificate covers.
 *
 * The per-hostname order over HTTP stays as it was. A name no certificate here
 * covers is ordered for exactly as before, and a domain whose DNS Polaris cannot
 * write simply has no row doing anything.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { withLease } from "@/lib/cron/lease";
import { orderDns01Certificate } from "./acme-dns01";
import { createHash, X509Certificate } from "node:crypto";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { getSetting, setSetting } from "@/lib/setting-store";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { dynamicDir, writeDynamicFile } from "@/lib/traefik-dynamic";
import { DNS01_PROVIDERS, dns01Provider, type Dns01ProviderKind } from "./dns01";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    isDue,
    mayHandCertificate,
    plannedCertificates,
    retryDelayMs,
    type CertificateHolder,
    type ServedNameFacts,
    type WantedCertificate
} from "./managed-cert-plan";

/** Every file this writes into the local edge's directory starts with this. */
const PREFIX = "polaris-managed-";
const TLS_FILE = `${PREFIX}certs.yml`;

/** The lease every pass takes, shared by the schedule and a pass somebody asked
 *  for on a screen, so the two never order the same certificate at once. */
export const MANAGED_CERT_LEASE = "managed-certificates";
const LEASE_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Secrets at rest
// ---------------------------------------------------------------------------

/** Seal a secret with the master key, as every other stored credential is. */
export function sealText(value: string): string {
    const sealed = encryptSecret(value, loadEnv().POLARIS_MASTER_KEY);
    return JSON.stringify({
        c: sealed.ciphertext.toString("base64"),
        n: sealed.nonce.toString("base64"),
        k: sealed.keyId
    });
}

/** Open a sealed secret, or null when it cannot be read. */
export function openText(stored: string | null): string | null {
    if (!stored) return null;
    try {
        const { c, n, k } = JSON.parse(stored) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// What is wanted
// ---------------------------------------------------------------------------

/** Read the facts the plan needs and bring the rows in line with it: a row per
 *  wanted certificate, and none for anything no longer wanted. */
async function syncWanted(): Promise<void> {
    // Loaded when used: the domain settings read the owner domains, which read
    // this module, and a static import would close that loop.
    const { deployBase } = await import("@/lib/domain-service");
    const [ownerDomains, wildcardDomains, base] = await Promise.all([
        prisma.ownerDomain.findMany({
            select: { id: true, domain: true, verifiedAt: true, userId: true, orgId: true }
        }),
        prisma.domain.findMany({
            where: { hostname: { startsWith: "*." }, enabled: true },
            select: {
                hostname: true,
                certPem: true,
                application: {
                    select: {
                        environment: {
                            select: {
                                project: { select: { ownerId: true, orgId: true, owner: { select: { isAdmin: true } } } }
                            }
                        }
                    }
                }
            }
        }),
        deployBase().catch(() => "")
    ]);
    const wanted = plannedCertificates({
        ownerDomains: ownerDomains.map((row) => ({
            id: row.id,
            domain: row.domain,
            verified: row.verifiedAt !== null,
            userId: row.userId,
            orgId: row.orgId
        })),
        wildcardHosts: wildcardDomains.map((row) => ({
            hostname: row.hostname,
            hasUpload: row.certPem !== null,
            ownerId: row.application.environment.project.ownerId,
            orgId: row.application.environment.project.orgId,
            ownerIsAdmin: row.application.environment.project.owner.isAdmin
        })),
        deployBase: base || null
    });
    const existing = await prisma.managedCertificate.findMany({
        select: { id: true, domain: true, source: true, ownerDomainId: true }
    });
    const byDomain = new Map(wanted.map((entry) => [entry.domain, entry]));
    const gone = existing.filter((row) => !byDomain.has(row.domain)).map((row) => row.id);
    if (gone.length > 0) await prisma.managedCertificate.deleteMany({ where: { id: { in: gone } } });
    for (const entry of wanted) {
        const row = existing.find((candidate) => candidate.domain === entry.domain);
        if (!row) {
            await prisma.managedCertificate.create({
                data: { domain: entry.domain, source: entry.source, ownerDomainId: entry.ownerDomainId }
            });
        } else if (row.source !== entry.source || row.ownerDomainId !== entry.ownerDomainId) {
            await prisma.managedCertificate.update({
                where: { id: row.id },
                data: { source: entry.source, ownerDomainId: entry.ownerDomainId }
            });
        }
    }
}

/** The DNS host and the credential that prove one certificate: the owner domain's
 *  own token when it has one, else the instance's connected Cloudflare token. */
async function credentialFor(
    certificate: Pick<WantedCertificate, "ownerDomainId">
): Promise<{ kind: Dns01ProviderKind; token: string } | null> {
    if (certificate.ownerDomainId) {
        const owner = await prisma.ownerDomain.findUnique({
            where: { id: certificate.ownerDomainId },
            select: { dnsProvider: true, dnsToken: true }
        });
        const token = openText(owner?.dnsToken ?? null);
        const kind = (DNS01_PROVIDERS as readonly string[]).includes(owner?.dnsProvider ?? "")
            ? (owner?.dnsProvider as Dns01ProviderKind)
            : "cloudflare";
        if (token) return { kind, token };
    }
    const instance = await loadCloudflareToken();
    return instance ? { kind: "cloudflare", token: instance } : null;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Order one certificate and record what happened. Never throws: a failure is
 *  written on the row, with when it is tried again. */
async function issue(row: {
    id: string;
    domain: string;
    ownerDomainId: string | null;
    certPem: string | null;
    expiresAt: Date | null;
    failures: number;
}): Promise<boolean> {
    const now = new Date();
    const credential = await credentialFor(row);
    if (!credential) {
        await prisma.managedCertificate.update({
            where: { id: row.id },
            data: {
                status: row.certPem ? "issued" : "pending",
                lastAttemptAt: now,
                nextAttemptAt: new Date(now.getTime() + retryDelayMs(1)),
                detail: `Add a Cloudflare API token that can edit the DNS of ${row.domain} to get a wildcard certificate.`
            }
        });
        return false;
    }
    try {
        const provider = await dns01Provider(credential.kind, credential.token, row.domain);
        const { certificate, key } = await orderDns01Certificate({
            names: [`*.${row.domain}`, row.domain],
            provider
        });
        const expiresAt = new Date(new X509Certificate(certificate).validTo);
        await prisma.managedCertificate.update({
            where: { id: row.id },
            data: {
                status: "issued",
                certPem: certificate,
                certKey: sealText(key),
                expiresAt,
                lastAttemptAt: now,
                nextAttemptAt: null,
                failures: 0,
                detail: null
            }
        });
        return true;
    } catch (caught) {
        const reason = caught instanceof Error ? caught.message : "the order failed";
        const failures = row.failures + 1;
        const next = new Date(now.getTime() + retryDelayMs(failures));
        console.error(`polaris: could not obtain the certificate for *.${row.domain}:`, reason);
        await prisma.managedCertificate.update({
            where: { id: row.id },
            data: {
                // A renewal that failed leaves the current certificate serving, so
                // the row still says it is issued; the detail says what went wrong.
                status: row.certPem && row.expiresAt && row.expiresAt > now ? "issued" : "failed",
                lastAttemptAt: now,
                nextAttemptAt: next,
                failures,
                detail: reason.slice(0, 500)
            }
        });
        return false;
    }
}

export interface ManagedCertificatePass {
    readonly certificates: number;
    readonly issued: number;
    readonly failed: number;
}

/**
 * One pass: bring the rows in line with what is wanted, order whatever is due,
 * and publish what is held. Safe to run on a schedule and from a screen - both
 * take the same lease, and a pass that finds nothing due only republishes.
 */
export async function ensureManagedCertificates(): Promise<ManagedCertificatePass | null> {
    return withLease(MANAGED_CERT_LEASE, LEASE_MS, async () => {
        await syncWanted();
        const rows = await prisma.managedCertificate.findMany({
            select: {
                id: true,
                domain: true,
                ownerDomainId: true,
                certPem: true,
                expiresAt: true,
                nextAttemptAt: true,
                failures: true
            }
        });
        let issued = 0;
        let failed = 0;
        const now = new Date();
        // One at a time: each order waits on DNS, and Let's Encrypt limits how many
        // are open at once per account.
        for (const row of rows.filter((candidate) => isDue(candidate, now))) {
            if (await issue(row)) issued += 1;
            else failed += 1;
        }
        await publishManagedCertificates();
        await pushRemoteCertificates().catch((error: unknown) =>
            console.error("polaris: could not hand certificates to a server's edge:", error)
        );
        return { certificates: rows.length, issued, failed };
    });
}

/** Start a pass now without waiting for it, for a screen that has just changed
 *  something a certificate depends on. The screen polls the row for the result. */
export function requestManagedCertificates(): void {
    void ensureManagedCertificates().catch((error: unknown) =>
        console.error("polaris: the certificate pass failed:", error)
    );
}

/** Clear the wait on an owner domain's certificate, so the next pass orders it. */
export async function retryOwnerDomainCertificate(ownerDomainId: string): Promise<void> {
    await prisma.managedCertificate.updateMany({ where: { ownerDomainId }, data: { nextAttemptAt: null } });
    requestManagedCertificates();
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

interface Servable {
    readonly id: string;
    readonly domain: string;
    readonly certPem: string;
    readonly keyPem: string;
    readonly holder: CertificateHolder | null;
}

/** The certificates worth serving right now: issued, readable, and not expired. */
async function servable(): Promise<Servable[]> {
    const rows = await prisma.managedCertificate.findMany({
        where: { certPem: { not: null }, certKey: { not: null }, expiresAt: { gt: new Date() } },
        select: {
            id: true,
            domain: true,
            certPem: true,
            certKey: true,
            ownerDomain: { select: { userId: true, orgId: true } }
        }
    });
    return rows.flatMap((row) => {
        const keyPem = openText(row.certKey);
        return row.certPem && keyPem
            ? [{ id: row.id, domain: row.domain, certPem: row.certPem, keyPem, holder: row.ownerDomain ?? null }]
            : [];
    });
}

/**
 * Write every servable certificate into this machine's edge directory and take
 * away the files of the ones that are not. Only `tls.certificates`: the edge
 * picks by name, so this covers the names under each domain and leaves every
 * other certificate exactly where it was.
 */
export async function publishManagedCertificates(): Promise<void> {
    const certificates = await servable();
    const dyn = dynamicDir();
    await mkdir(dyn, { recursive: true });
    const entries: string[] = [];
    const written = new Set<string>();
    for (const certificate of certificates) {
        const crt = `${PREFIX}${certificate.id}.crt`;
        const key = `${PREFIX}${certificate.id}.key`;
        await writeDynamicFile(crt, certificate.certPem);
        await writeDynamicFile(key, certificate.keyPem, { mode: 0o600 });
        written.add(crt);
        written.add(key);
        entries.push(`    - certFile: ${join(dyn, crt)}`, `      keyFile: ${join(dyn, key)}`);
    }
    if (entries.length > 0) {
        await writeDynamicFile(TLS_FILE, ["tls:", "  certificates:", ...entries, ""].join("\n"));
        written.add(TLS_FILE);
    }
    // Only this module's own files; with nothing to serve that includes the list,
    // since an empty `tls` block is a file the edge refuses outright.
    for (const name of await readdir(dyn).catch(() => [] as string[])) {
        if (!name.startsWith(PREFIX) || written.has(name) || name.endsWith(".tmp")) continue;
        await unlink(join(dyn, name)).catch(() => undefined);
    }
}

/** The setting that remembers what each server was last given, so a pass that
 *  changed nothing does not open an SSH session to every server every time. */
const pushedKey = (hostId: string): string => `tls.managed.pushed.${hostId}`;

/**
 * Give each other server the certificates for the domains its own edge serves.
 * A server is handed only what covers a name it answers for and is its owner's to
 * hold (see `mayHandCertificate`), and a server that no longer answers for any is
 * given the empty set - which takes the files away.
 */
async function pushRemoteCertificates(): Promise<void> {
    const [certificates, domains] = await Promise.all([
        servable(),
        prisma.domain.findMany({
            where: {
                enabled: true,
                servedBy: { not: "polaris" },
                application: { target: { hostId: { not: null }, kind: { not: "local" } } }
            },
            select: {
                hostname: true,
                application: {
                    select: {
                        target: { select: { hostId: true, host: { select: { ownerId: true } } } },
                        environment: {
                            select: {
                                project: { select: { ownerId: true, orgId: true, owner: { select: { isAdmin: true } } } }
                            }
                        }
                    }
                }
            }
        })
    ]);
    const hosts = new Map<string, { ownerId: string; names: ServedNameFacts[] }>();
    for (const domain of domains) {
        const { hostId, host } = domain.application.target;
        if (!hostId || !host) continue;
        const project = domain.application.environment.project;
        const held = hosts.get(hostId) ?? { ownerId: host.ownerId, names: [] };
        held.names.push({
            hostname: domain.hostname,
            ownerId: project.ownerId,
            orgId: project.orgId,
            ownerIsAdmin: project.owner.isAdmin,
            hostOwnerId: host.ownerId
        });
        hosts.set(hostId, held);
    }
    if (hosts.size === 0) return;
    const [{ RemoteRouter }, { getHostConnection }] = await Promise.all([
        import("@/lib/deploy/router-remote"),
        import("@/lib/host-service")
    ]);
    for (const [hostId, held] of hosts) {
        const given = certificates
            .filter((certificate) => held.names.some((name) => mayHandCertificate(certificate, name)))
            .map(({ id, domain, certPem, keyPem }) => ({ id, domain, certPem, keyPem }));
        const fingerprint = createHash("sha256")
            .update(given.map((certificate) => `${certificate.id}:${certificate.certPem}`).join("\n"))
            .digest("hex");
        if ((await getSetting(pushedKey(hostId))) === fingerprint) continue;
        try {
            const connection = await getHostConnection(hostId, held.ownerId);
            await new RemoteRouter({
                address: connection.address,
                port: connection.port,
                username: connection.username,
                auth: connection.auth,
                hostKey: connection.hostKey
            }).pushCertificates(given);
            await setSetting(pushedKey(hostId), fingerprint);
        } catch (error) {
            // One server asleep or refusing is not a reason to leave the others
            // without theirs; it is tried again on the next pass.
            console.error(`polaris: could not hand certificates to server ${hostId}:`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Reading, for the owner domains screen
// ---------------------------------------------------------------------------

export interface ManagedCertificateView {
    readonly status: "pending" | "issued" | "failed";
    readonly expiresAt: string | null;
    readonly nextAttemptAt: string | null;
    readonly detail: string | null;
}

/** The certificate each of these owner domains has, by owner domain id. */
export async function ownerDomainCertificates(ids: readonly string[]): Promise<Map<string, ManagedCertificateView>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.managedCertificate.findMany({
        where: { ownerDomainId: { in: [...ids] }, source: "owner" },
        select: { ownerDomainId: true, status: true, expiresAt: true, nextAttemptAt: true, detail: true }
    });
    return new Map(
        rows.flatMap((row) =>
            row.ownerDomainId
                ? [
                      [
                          row.ownerDomainId,
                          {
                              status: (["pending", "issued", "failed"].includes(row.status)
                                  ? row.status
                                  : "pending") as ManagedCertificateView["status"],
                              expiresAt: row.expiresAt?.toISOString() ?? null,
                              nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
                              detail: row.detail
                          }
                      ] as const
                  ]
                : []
        )
    );
}
