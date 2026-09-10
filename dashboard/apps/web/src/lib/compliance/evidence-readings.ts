/**
 * Reading the facts the compliance evidence reports, from where each one lives.
 *
 * Every figure comes from the module or table that owns it - the instance policy
 * through `instance-security`, retention through `retention-service`, the chain
 * through `audit-chain`, the firewall through `waf-service` - so the evidence
 * reads a setting the way the code that enforces it does, defaults included.
 * `buildEvidence` puts it into words.
 *
 * Counts are taken over accounts that can sign in (`VISIBLE_USER`): a banned or
 * disabled account is not part of who can reach the instance.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { loadEnv } from "@polaris/config";
import { wafSummary } from "@/lib/waf-service";
import { appBaseUrl } from "@/lib/domain-service";
import { prisma, VISIBLE_USER } from "@polaris/db";
import { getAuthMailStatus } from "@/lib/auth-mail";
import { auditChainStatus } from "@/lib/audit-chain";
import * as evidence from "@/lib/compliance/evidence";
import { retentionPolicy } from "@/lib/retention-service";
import { isSealedCopy } from "@/lib/backups/sealed-copies";
import { getInstanceSecurity } from "@/lib/instance-security";
import { MIN_PASSWORD_LENGTH, SESSION_MAX_AGE, SESSION_UPDATE_AGE } from "@polaris/auth";

/** What a person is called in the report: the name they chose, or their handle. */
function displayName(user: { name: string; username: string | null; email: string }): string {
    return user.name || (user.username ? `@${user.username}` : user.email);
}

async function readAuthentication(): Promise<evidence.EvidenceReadings["authentication"]> {
    const [policy, mail, accounts, withSecondFactor, withPasskey] = await Promise.all([
        getInstanceSecurity(),
        getAuthMailStatus(),
        prisma.user.count({ where: VISIBLE_USER }),
        prisma.user.count({ where: { ...VISIBLE_USER, twoFactorEnabled: true } }),
        prisma.user.count({ where: { ...VISIBLE_USER, passkeys: { some: {} } } })
    ]);
    return {
        policy,
        mailReady: mail.channelId !== null,
        accounts,
        withSecondFactor,
        withPasskey,
        minPasswordLength: MIN_PASSWORD_LENGTH
    };
}

async function readSessions(now: Date): Promise<evidence.EvidenceReadings["sessions"]> {
    const visible = { user: VISIBLE_USER };
    const [
        accounts,
        shorterLifetime,
        idleLock,
        clientBindingOff,
        addressPinned,
        loginApproval,
        open
    ] = await Promise.all([
        prisma.user.count({ where: VISIBLE_USER }),
        prisma.userSecurity.count({ where: { ...visible, sessionMaxMinutes: { gt: 0 } } }),
        prisma.userSecurity.count({ where: { ...visible, idleLockMinutes: { gt: 0 } } }),
        prisma.userSecurity.count({ where: { ...visible, bindSessionsToClient: false } }),
        prisma.userSecurity.count({ where: { ...visible, pinSessionsToAddress: { not: "off" } } }),
        prisma.userSecurity.count({ where: { ...visible, requireLoginApproval: true } }),
        prisma.session.count({ where: { ...visible, expiresAt: { gt: now } } })
    ]);
    return {
        maxAgeSeconds: SESSION_MAX_AGE,
        updateAgeSeconds: SESSION_UPDATE_AGE,
        accounts,
        shorterLifetime,
        idleLock,
        clientBindingOff,
        addressPinned,
        loginApproval,
        open
    };
}

async function readAdministrators(): Promise<evidence.EvidenceReadings["administrators"]> {
    const admins = await prisma.user.findMany({
        where: { ...VISIBLE_USER, isAdmin: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, username: true, email: true, twoFactorEnabled: true }
    });
    return admins.map((admin) => ({
        id: admin.id,
        name: displayName(admin),
        secondFactor: admin.twoFactorEnabled
    }));
}

async function readAudit(): Promise<evidence.EvidenceReadings["audit"]> {
    const [retention, chain] = await Promise.all([retentionPolicy(), auditChainStatus()]);
    const last = chain.lastVerification;
    return {
        retention,
        sealed: chain.sealed,
        pending: chain.pending,
        head: chain.head,
        lastVerification: last
            ? {
                  at: last.at,
                  ok: last.ok,
                  checked: last.checked,
                  broken: last.broken ? { seq: last.broken.seq, reason: last.broken.reason } : null
              }
            : null
    };
}

/** An item's newest usable point, by how many of its stored copies are sealed. */
interface NewestCopies {
    sealed: number;
    clear: number;
}

const USABLE_POINT = { status: { in: ["available", "partial"] } };

/**
 * The newest usable point's stored copies of each of these items. An item with
 * no stored copy is absent.
 *
 * Three steps, each one row per item or per copy: the newest point's time, the
 * point taken then, and its copies - rather than every point of every item.
 */
async function newestCopies(resourceIds: readonly string[]): Promise<Map<string, NewestCopies>> {
    const copies = new Map<string, NewestCopies>();
    if (resourceIds.length === 0) return copies;
    const newest = await prisma.recoveryPoint.groupBy({
        by: ["resourceId"],
        where: { ...USABLE_POINT, resourceId: { in: [...resourceIds] } },
        _max: { takenAt: true }
    });
    const taken = newest.flatMap((group) =>
        group._max.takenAt ? [{ resourceId: group.resourceId, takenAt: group._max.takenAt }] : []
    );
    if (taken.length === 0) return copies;
    const points = await prisma.recoveryPoint.findMany({
        where: { ...USABLE_POINT, OR: taken },
        select: { id: true, resourceId: true }
    });
    const resourceOf = new Map<string, string>();
    const picked = new Set<string>();
    for (const point of points) {
        if (picked.has(point.resourceId)) continue;
        picked.add(point.resourceId);
        resourceOf.set(point.id, point.resourceId);
    }
    const stored = await prisma.recoveryPointCopy.findMany({
        where: { pointId: { in: [...resourceOf.keys()] }, status: "available" },
        select: { pointId: true, sealedWith: true, path: true }
    });
    for (const copy of stored) {
        const resourceId = resourceOf.get(copy.pointId);
        if (!resourceId) continue;
        const held = copies.get(resourceId) ?? { sealed: 0, clear: 0 };
        if (isSealedCopy(copy)) held.sealed += 1;
        else held.clear += 1;
        copies.set(resourceId, held);
    }
    return copies;
}

/** Every item's newest copies, read a page of items at a time. */
async function newestCopiesOfAll(): Promise<Map<string, NewestCopies>> {
    const all = new Map<string, NewestCopies>();
    let cursor: string | null = null;
    for (;;) {
        const page: { id: string }[] = await prisma.protectedResource.findMany({
            where: { points: { some: USABLE_POINT } },
            orderBy: { id: "asc" },
            take: evidence.EVIDENCE_ROWS_MAX,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            select: { id: true }
        });
        for (const [resourceId, held] of await newestCopies(page.map((resource) => resource.id))) {
            all.set(resourceId, held);
        }
        const last = page.at(-1);
        if (page.length < evidence.EVIDENCE_ROWS_MAX || !last) return all;
        cursor = last.id;
    }
}

/**
 * The protected items, newest backup first, each with whether its newest copy is
 * encrypted everywhere it was written, and the same figures over every item.
 *
 * Only the newest usable point of each item is looked at: that is the copy a
 * restore would reach for, and it answers "are the backups encrypted" for the
 * item as it is now rather than for a copy taken before sealing existed.
 */
async function readBackups(): Promise<evidence.EvidenceReadings["backups"]> {
    const [total, scheduled, failing, activeKeys, copiesOf, resources] = await Promise.all([
        prisma.protectedResource.count(),
        prisma.protectedResource.count({
            where: { status: "active", plan: { is: { every: { not: "off" } } } }
        }),
        prisma.protectedResource.count({ where: { lastStatus: "failed" } }),
        prisma.backupKey.count({ where: { retiredAt: null } }),
        newestCopiesOfAll(),
        prisma.protectedResource.findMany({
            orderBy: [{ lastBackupAt: { sort: "desc", nulls: "last" } }, { name: "asc" }],
            take: evidence.EVIDENCE_ROWS_MAX,
            select: {
                id: true,
                name: true,
                kind: true,
                status: true,
                lastBackupAt: true,
                lastStatus: true,
                plan: { select: { every: true } }
            }
        })
    ]);
    const kept = [...copiesOf.values()];
    return {
        total,
        scheduled,
        failing,
        withCopy: kept.length,
        encrypted: kept.filter((held) => held.clear === 0).length,
        activeKeys,
        items: resources.map((resource) => {
            const held = copiesOf.get(resource.id);
            return {
                id: resource.id,
                name: resource.name,
                kind: resource.kind,
                status: resource.status,
                every: resource.plan?.every ?? null,
                lastSuccessAt: resource.lastBackupAt?.toISOString() ?? null,
                lastStatus: resource.lastStatus,
                sealed: held?.sealed ?? 0,
                clear: held?.clear ?? 0
            };
        })
    };
}

async function readSecrets(): Promise<evidence.EvidenceReadings["secrets"]> {
    const [secret, secretClear, plainVariables, runnerSecrets] = await Promise.all([
        prisma.envVar.count({ where: { isSecret: true } }),
        prisma.envVar.count({ where: { isSecret: true, encryptedValue: null } }),
        prisma.envVar.count({ where: { isSecret: false } }),
        prisma.runnerSecret.count()
    ]);
    return { secretEncrypted: secret - secretClear, secretClear, plainVariables, runnerSecrets };
}

async function readTls(): Promise<evidence.EvidenceReadings["tls"]> {
    const enabled = { enabled: true };
    const [domains, letsEncrypt, internalCa, plainHttp, uploaded, managed] = await Promise.all([
        prisma.domain.count({ where: enabled }),
        prisma.domain.count({ where: { ...enabled, certResolver: "le" } }),
        prisma.domain.count({ where: { ...enabled, certResolver: "internal" } }),
        prisma.domain.count({ where: { ...enabled, certResolver: "none" } }),
        prisma.domain.count({ where: { ...enabled, certPem: { not: null } } }),
        prisma.managedCertificate.findMany({ select: { status: true, expiresAt: true } })
    ]);
    return {
        domains,
        letsEncrypt,
        internalCa,
        plainHttp,
        uploaded,
        managed: {
            issued: managed.filter((cert) => cert.status === "issued").length,
            pending: managed.filter((cert) => cert.status === "pending").length,
            failed: managed.filter((cert) => cert.status === "failed").length,
            expiries: managed.flatMap((cert) =>
                cert.status === "issued" && cert.expiresAt ? [cert.expiresAt.toISOString()] : []
            )
        }
    };
}

async function readFirewall(now: Date): Promise<evidence.EvidenceReadings["firewall"]> {
    const [summary, activeBans] = await Promise.all([
        wafSummary(),
        prisma.wafBan.count({ where: { OR: [{ until: null }, { until: { gt: now } }] } })
    ]);
    return { ...summary, activeBans };
}

/** Every service's edge settings, read the way the edge reads them. */
async function readEdge(): Promise<evidence.EvidenceReadings["edge"]> {
    const apps = await prisma.application.findMany({ select: { edgeConfig: true } });
    const configs = apps.map((app) => core.parseAppEdgeConfig(app.edgeConfig));
    const headers = Object.fromEntries(
        core.EDGE_HEADER_PRESETS.map((preset) => [preset, 0])
    ) as Record<core.EdgeHeaderPreset, number>;
    for (const config of configs) headers[config.headers.preset] += 1;
    return {
        services: configs.length,
        rateLimited: configs.filter((config) => config.rateLimits.length > 0).length,
        rateRules: configs.reduce((sum, config) => sum + config.rateLimits.length, 0),
        concurrencyCapped: configs.filter((config) => config.concurrency > 0).length,
        challenged: configs.filter((config) => config.challenge !== "off").length,
        headers,
        customHeaders: configs.filter((config) => config.headers.custom.length > 0).length
    };
}

/**
 * The newest audit entry that changed each area, with who made it.
 *
 * Somebody whose account is gone still reads as somebody, and an entry nobody
 * signed in to make reads as Polaris - the same rule the organization history
 * follows.
 */
async function readChanges(): Promise<evidence.EvidenceReadings["changes"]> {
    const entries = await Promise.all(
        evidence.EVIDENCE_AREAS.map((area) =>
            prisma.auditLog.findFirst({
                where: { action: { in: [...evidence.EVIDENCE_CHANGE_ACTIONS[area]] } },
                orderBy: { at: "desc" },
                select: { at: true, action: true, actorId: true }
            })
        )
    );
    const actorIds = [
        ...new Set(entries.flatMap((entry) => (entry?.actorId ? [entry.actorId] : [])))
    ];
    const actors =
        actorIds.length === 0
            ? []
            : await prisma.user.findMany({
                  where: { id: { in: actorIds } },
                  select: { id: true, name: true, username: true, email: true }
              });
    const names = new Map(actors.map((actor) => [actor.id, displayName(actor)]));
    return Object.fromEntries(
        evidence.EVIDENCE_AREAS.map((area, index) => {
            const entry = entries[index];
            if (!entry) return [area, null];
            const known = entry.actorId ? names.get(entry.actorId) : undefined;
            const actorName = entry.actorId ? (known ?? "a former member") : "Polaris";
            return [
                area,
                {
                    at: entry.at.toISOString(),
                    action: entry.action,
                    actorId: entry.actorId,
                    actorName,
                    actorExists: known !== undefined
                }
            ];
        })
    ) as evidence.EvidenceReadings["changes"];
}

/** Everything the evidence reports, read now. */
export async function readEvidence(now: Date = new Date()): Promise<evidence.EvidenceReport> {
    const env = loadEnv();
    const [url, authentication, sessions, administrators, audit] = await Promise.all([
        appBaseUrl(),
        readAuthentication(),
        readSessions(now),
        readAdministrators(),
        readAudit()
    ]);
    const [backups, secrets, tls, firewall, edge, changes] = await Promise.all([
        readBackups(),
        readSecrets(),
        readTls(),
        readFirewall(now),
        readEdge(),
        readChanges()
    ]);
    return evidence.buildEvidence({
        now,
        instance: { url, build: env.POLARIS_BUILD_SHA ? env.POLARIS_BUILD_SHA.slice(0, 12) : null },
        authentication,
        sessions,
        administrators,
        audit,
        backups,
        secrets,
        tls,
        firewall,
        edge,
        changes
    });
}
