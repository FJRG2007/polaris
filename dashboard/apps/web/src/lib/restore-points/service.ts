/**
 * Restore points: what one configuration object looked like just before Polaris
 * changed it, kept so the change can be read back and undone in one click.
 *
 * Each kind has an adapter that reads the object's current state into a
 * snapshot body and writes a body back. `capture` is called by the code that
 * changes the object, before it does; `restore` captures the current state
 * first (so a restore is itself undoable), applies the chosen body and leaves an
 * audit row.
 */

import { prisma } from "@polaris/db";
import { dropGrantsOfGoneDomains } from "@/lib/access/grants";
import * as core from "@/lib/restore-points/core";

type Body = core.SnapshotBody;

interface Adapter {
    capture(objectKey: string): Promise<Body>;
    apply(objectKey: string, body: Body, actor: { id: string; ownerId: string }): Promise<void>;
}

function b64(value: Uint8Array | null): string | null {
    return value ? Buffer.from(value).toString("base64") : null;
}

function bytes(value: unknown): Uint8Array<ArrayBuffer> | null {
    return typeof value === "string" ? new Uint8Array(Buffer.from(value, "base64")) : null;
}

function splitKey(objectKey: string): [string, string] {
    const at = objectKey.indexOf(":");
    if (at < 0) throw new Error("Restore point key is not readable");
    return [objectKey.slice(0, at), objectKey.slice(at + 1)];
}

/** Variables, keyed "<application|environment>:<id>". A secret keeps its envelope. */
const env: Adapter = {
    async capture(objectKey) {
        const [scopeType, scopeId] = splitKey(objectKey);
        const rows = await prisma.envVar.findMany({
            where: { scopeType, scopeId },
            select: {
                key: true,
                isSecret: true,
                value: true,
                encryptedValue: true,
                valueNonce: true,
                valueKeyId: true
            }
        });
        const items: Body["items"] = {};
        for (const row of rows) {
            items[row.key] = row.isSecret
                ? {
                      secret: true,
                      [core.SECRET_FIELD]: {
                          c: b64(row.encryptedValue),
                          n: b64(row.valueNonce),
                          k: row.valueKeyId
                      }
                  }
                : { secret: false, value: row.value ?? "" };
        }
        return { items };
    },
    async apply(objectKey, body) {
        const [scopeType, scopeId] = splitKey(objectKey);
        await prisma.$transaction(async (tx) => {
            await tx.envVar.deleteMany({
                where: { scopeType, scopeId, key: { notIn: Object.keys(body.items) } }
            });
            for (const [key, item] of Object.entries(body.items)) {
                const envelope = item[core.SECRET_FIELD] as
                    | { c?: string; n?: string; k?: string }
                    | undefined;
                const data =
                    item.secret === true
                        ? {
                              isSecret: true,
                              value: null,
                              encryptedValue: bytes(envelope?.c),
                              valueNonce: bytes(envelope?.n),
                              valueKeyId: envelope?.k ?? null
                          }
                        : {
                              isSecret: false,
                              value: String(item.value ?? ""),
                              encryptedValue: null,
                              valueNonce: null,
                              valueKeyId: null
                          };
                await tx.envVar.upsert({
                    where: { scopeType_scopeId_key: { scopeType, scopeId, key } },
                    create: { scopeType, scopeId, key, ...data },
                    update: data
                });
            }
        });
    }
};

/** A service's scheduled jobs, keyed by application id, one item per job id. */
const cron: Adapter = {
    async capture(applicationId) {
        const rows = await prisma.serviceCron.findMany({
            where: { applicationId },
            select: {
                id: true,
                name: true,
                schedule: true,
                timezone: true,
                command: true,
                timeoutSeconds: true,
                maxAttempts: true,
                retryDelaySeconds: true,
                enabled: true
            }
        });
        return { items: Object.fromEntries(rows.map(({ id, ...rest }) => [id, rest])) };
    },
    async apply(applicationId, body, actor) {
        const { saveServiceCron } = await import("@/lib/deploy/service-cron");
        const kept = Object.keys(body.items);
        await prisma.serviceCron.deleteMany({ where: { applicationId, id: { notIn: kept } } });
        const present = new Set(
            (
                await prisma.serviceCron.findMany({
                    where: { applicationId },
                    select: { id: true }
                })
            ).map((row) => row.id)
        );
        for (const [id, item] of Object.entries(body.items)) {
            const input = item as unknown as Parameters<typeof saveServiceCron>[1];
            await saveServiceCron(
                applicationId,
                { ...input, id: present.has(id) ? id : undefined },
                actor.id,
                false
            );
        }
    }
};

const ROUTE_FIELDS = [
    "kind",
    "targetPort",
    "portPinned",
    "https",
    "enabled",
    "certResolver",
    "pathPrefix"
] as const;

/** A service's routes and domains, keyed by application id, one item per hostname. */
const routes: Adapter = {
    async capture(applicationId) {
        const rows = await prisma.domain.findMany({
            where: { applicationId, kind: { not: "release" } }
        });
        const items: Body["items"] = {};
        for (const row of rows) {
            items[row.hostname] = Object.fromEntries(
                ROUTE_FIELDS.map((field) => [field, row[field] ?? null])
            );
        }
        return { items };
    },
    async apply(applicationId, body) {
        const hostnames = Object.keys(body.items);
        await prisma.domain.deleteMany({
            where: { applicationId, kind: { not: "release" }, hostname: { notIn: hostnames } }
        });
        await dropGrantsOfGoneDomains().catch(() => undefined);
        const { dashboardHosts } = await import("@/lib/domain-edge");
        const [dashboard, pages] = await Promise.all([
            dashboardHosts(),
            prisma.statusPage.findMany({
                where: { customDomain: { in: hostnames } },
                select: { customDomain: true }
            })
        ]);
        const reserved = new Set([
            ...dashboard,
            ...pages.flatMap((page) => (page.customDomain ? [page.customDomain] : []))
        ]);
        for (const [hostname, item] of Object.entries(body.items)) {
            if (reserved.has(hostname.toLowerCase())) continue;
            const data = Object.fromEntries(
                ROUTE_FIELDS.map((field) => [field, item[field] ?? undefined])
            ) as {
                kind?: string;
                targetPort: number;
            };
            const taken = await prisma.domain.findUnique({
                where: { hostname },
                select: { applicationId: true }
            });
            // A name another service took since then stays where it is.
            if (taken && taken.applicationId !== applicationId) continue;
            if (taken) await prisma.domain.update({ where: { hostname }, data });
            else await prisma.domain.create({ data: { ...data, hostname, applicationId } });
        }
        const { syncAppRoutes } = await import("@/lib/deploy-service");
        await syncAppRoutes().catch(() => undefined);
    }
};

/** A firewall scope, keyed "<scopeType>:<scopeId>", a single item "rule". */
const firewall: Adapter = {
    async capture(objectKey) {
        const [scopeType, scopeId] = splitKey(objectKey);
        const row = await prisma.wafRule.findUnique({
            where: { scopeType_scopeId: { scopeType, scopeId } }
        });
        if (!row) return { items: {} as Body["items"] };
        const { id: _id, createdAt: _c, updatedAt: _u, scopeType: _t, scopeId: _s, ...rule } = row;
        const parsed = Object.fromEntries(
            Object.entries(rule).map(([field, value]) => {
                if (typeof value !== "string" || !/^[[{]/.test(value)) return [field, value];
                try {
                    return [field, JSON.parse(value) as unknown];
                } catch {
                    return [field, value];
                }
            })
        );
        return { items: { rule: parsed } as Body["items"] };
    },
    async apply(objectKey, body, actor) {
        const [scopeType, scopeId] = splitKey(objectKey);
        const waf = await import("@/lib/waf-service");
        const rule = body.items.rule;
        if (!rule) {
            await prisma.wafRule.deleteMany({ where: { scopeType, scopeId } });
        } else {
            await waf.setWafRule(
                actor.ownerId,
                scopeType as Parameters<typeof waf.setWafRule>[1],
                scopeId,
                rule as never
            );
        }
        const { syncAppRoutes } = await import("@/lib/deploy-service");
        const { syncDashboardRoute } = await import("@/lib/domain-edge");
        if (scopeType === "polaris") await syncDashboardRoute().catch(() => undefined);
        else await syncAppRoutes().catch(() => undefined);
    }
};

/** A managed DNS zone, keyed by the scope as JSON, one item per "TYPE name". */
const dns: Adapter = {
    async capture(objectKey) {
        const zone = await import("@/lib/dns/zone-records");
        const { records } = await zone.zoneRecords(
            JSON.parse(objectKey) as Parameters<typeof zone.zoneRecords>[0]
        );
        const items: Body["items"] = {};
        for (const record of records) {
            if (!record.draft) continue;
            items[`${record.type} ${record.name} ${record.id}`] = {
                id: record.id,
                ...record.draft
            };
        }
        return { items };
    },
    async apply(objectKey, body) {
        const zone = await import("@/lib/dns/zone-records");
        const scope = JSON.parse(objectKey) as Parameters<typeof zone.zoneRecords>[0];
        const { records } = await zone.zoneRecords(scope);
        const wanted = Object.values(body.items) as Array<{ id: string } & Record<string, unknown>>;
        const wantedIds = new Set(wanted.map((item) => item.id));
        for (const record of records) {
            if (record.draft && !wantedIds.has(record.id))
                await zone.deleteZoneRecord(scope, record.id, false);
        }
        const live = new Set(records.map((record) => record.id));
        for (const { id, ...draft } of wanted) {
            await zone.saveZoneRecord(scope, live.has(id) ? id : null, draft as never, false);
        }
    }
};

const ADAPTERS: Record<core.RestorePointKind, Adapter> = { env, cron, routes, firewall, dns };

/**
 * Keep the object's current state as a restore point. Called by the code about
 * to change it. Never throws: a change must not fail because its history could
 * not be written.
 */
export async function capture(
    kind: core.RestorePointKind,
    objectKey: string,
    options: { actorId?: string | null; reason?: "change" | "restore" } = {}
): Promise<void> {
    try {
        const body = await ADAPTERS[kind].capture(objectKey);
        const newest = await prisma.restorePoint.findFirst({
            where: { kind, objectKey },
            orderBy: { createdAt: "desc" },
            select: { hash: true }
        });
        if (core.isDuplicate(newest?.hash, body)) return;
        await prisma.restorePoint.create({
            data: {
                kind,
                objectKey,
                hash: core.hashOf(body),
                body: core.canonical(body),
                reason: options.reason ?? "change",
                actorId: options.actorId ?? null
            }
        });
        await prune(kind, objectKey);
    } catch (error) {
        console.error(`restore-points: could not keep a ${kind} snapshot:`, error);
    }
}

async function prune(kind: string, objectKey: string): Promise<void> {
    const points = await prisma.restorePoint.findMany({
        where: { kind, objectKey },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: core.KEEP_PER_OBJECT + 20
    });
    const doomed = core.prunable(points, new Date());
    if (doomed.length > 0) await prisma.restorePoint.deleteMany({ where: { id: { in: doomed } } });
}

/** Instance-wide age sweep, for the scheduled retention pass. Bounded per call. */
export async function pruneOldRestorePoints(now = new Date()): Promise<{ removed: number }> {
    const cutoff = new Date(now.getTime() - core.MAX_AGE_DAYS * 86_400_000);
    const old = await prisma.restorePoint.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: 1000
    });
    if (old.length === 0) return { removed: 0 };
    const { count } = await prisma.restorePoint.deleteMany({
        where: { id: { in: old.map((row) => row.id) } }
    });
    return { removed: count };
}

export interface RestorePointView {
    readonly id: string;
    readonly createdAt: string;
    readonly reason: string;
    readonly actorName: string | null;
    /** What restoring this point would change, against the object as it is now. */
    readonly changes: core.ItemChange[];
}

/** The object's timeline, newest first, each with its diff against the present. */
export async function listRestorePoints(
    kind: core.RestorePointKind,
    objectKey: string
): Promise<RestorePointView[]> {
    const [points, current] = await Promise.all([
        prisma.restorePoint.findMany({
            where: { kind, objectKey },
            orderBy: { createdAt: "desc" },
            take: core.KEEP_PER_OBJECT
        }),
        ADAPTERS[kind].capture(objectKey)
    ]);
    const actorIds = [
        ...new Set(points.flatMap((point) => (point.actorId ? [point.actorId] : [])))
    ];
    const actors = actorIds.length
        ? await prisma.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, name: true }
          })
        : [];
    const names = new Map(actors.map((actor) => [actor.id, actor.name]));
    return points.map((point) => ({
        id: point.id,
        createdAt: point.createdAt.toISOString(),
        reason: point.reason,
        actorName: point.actorId ? (names.get(point.actorId) ?? null) : null,
        changes: core.diffBodies(current, core.parseBody(point.body))
    }));
}

/**
 * Put the object back the way a point recorded it. The present state is kept
 * as a point of its own first, so the restore can be undone the same way.
 */
export async function restorePoint(
    pointId: string,
    expected: { kind: core.RestorePointKind; objectKey: string },
    actor: { id: string; ownerId: string; orgId?: string | null }
): Promise<void> {
    const point = await prisma.restorePoint.findUnique({ where: { id: pointId } });
    if (!point || point.kind !== expected.kind || point.objectKey !== expected.objectKey) {
        throw new Error("That restore point no longer exists");
    }
    await capture(expected.kind, expected.objectKey, { actorId: actor.id, reason: "restore" });
    await ADAPTERS[expected.kind].apply(expected.objectKey, core.parseBody(point.body), actor);
    // Loaded here: this module sits under every service that captures a point,
    // and the audit service brings the auth stack with it.
    const { recordAudit } = await import("@/lib/audit-service");
    await recordAudit({
        actorId: actor.id,
        orgId: actor.orgId ?? undefined,
        action: "restore-point.restore",
        targetType: expected.kind,
        targetId: expected.objectKey.slice(0, 200),
        metadata: { pointId, pointCreatedAt: point.createdAt.toISOString() }
    });
}

/** Keys used by the code that captures, so every caller writes the same one. */
export const restoreKeys = {
    env: (scope: "application" | "environment" | "group", scopeId: string) => `${scope}:${scopeId}`,
    firewall: (scopeType: string, scopeId: string) => `${scopeType}:${scopeId}`,
    cron: (applicationId: string) => applicationId,
    routes: (applicationId: string) => applicationId,
    dns: (scope: unknown) => core.canonical(scope)
};

export type RestorePointKindName = core.RestorePointKind;
