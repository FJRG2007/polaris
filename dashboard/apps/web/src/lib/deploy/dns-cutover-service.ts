/**
 * Carrying out a DNS cutover: the pre-flight, the record writes through Cloudflare,
 * moving the route, the background pass that watches the public resolvers, and the
 * rollback. Every decision about what comes next is the state machine's
 * (dns-cutover.ts); this only reads the world and does what it names.
 *
 * Authorization is the caller's: the actions check `domains.manage` on the project
 * before anything here runs. Each step claims its phase with a conditional update
 * first, so a double press, a retry after a timeout, or two runners of the pass do
 * the work once.
 */

import { prisma } from "@polaris/db";
import * as machine from "./dns-cutover";
import { serviceDnsTarget } from "@/lib/domain-dns";
import { recordDeployAudit } from "@/lib/deploy-audit";
import * as cf from "@/lib/integrations/cloudflare-api";
import { checkPropagation } from "@/lib/dns/propagation";
import { openText } from "@/lib/tls/managed-certificates";
import { publicResolver } from "@/lib/dns/public-resolver";
import { containerPortOf, syncAppRoutes } from "@/lib/deploy-service";
import { checkDomain, type DomainHealth } from "@/lib/watch/health-probe";
import { provenDomainOf, type TokenCaller } from "@/lib/dns/zone-records";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";

/** How many open cutovers one background pass looks at. */
const PASS_LIMIT = 20;
/** How many services the target list offers. */
const TARGET_LIMIT = 100;
/** Retries of the pre-flight probe while the target's edge loads the staged route. */
const PROBE_ATTEMPTS = 3;
const PROBE_GAP_MS = 1500;

/** A refusal the screen turns into a sentence. */
export type CutoverRefusal = "not-found" | "same-service" | "not-allowed" | "closed";

export class CutoverRefusedError extends Error {
    constructor(readonly reason: CutoverRefusal) {
        super(reason);
        this.name = "CutoverRefusedError";
    }
}

/** A record as it stood before the cutover touched it. */
interface KeptRecord {
    readonly id: string;
    readonly content: string;
    readonly ttl: number;
    readonly proxied: boolean;
}

interface Written {
    readonly records: KeptRecord[];
    /** The record the switch created when there was none to rewrite. */
    readonly created: string | null;
    /** The switch began changing things, so a rollback has something to undo even
     *  when it did not finish. */
    readonly touched: boolean;
}

/** What the screen reads off one check, stored on the row as JSON. */
export interface CutoverChecks {
    preflight?: machine.PreflightChecks;
    /** The route the domain had, so a rollback behind a shared edge puts it back. */
    route?: { targetPort: number; portPinned: boolean };
    propagation?: {
        settled: boolean;
        resolvers: { label: string; status: string; values: string[]; agrees: boolean | null }[];
    };
    target?: { status: "up" | "down"; code: number | null };
    checkedAt?: string;
}

const APP_SELECT = {
    id: true,
    name: true,
    environmentId: true,
    currentDeploymentId: true,
    sourceType: true,
    sourceConfig: true,
    domains: { select: { targetPort: true } },
    environment: {
        select: { projectId: true, name: true, project: { select: { ownerId: true, orgId: true } } }
    },
    target: {
        select: { kind: true, hostId: true, host: { select: { name: true, address: true } } }
    }
} as const;

async function loadDomain(domainId: string) {
    return prisma.domain.findUnique({
        where: { id: domainId },
        select: {
            id: true,
            hostname: true,
            https: true,
            servedBy: true,
            certPem: true,
            certResolver: true,
            targetPort: true,
            portPinned: true,
            application: { select: APP_SELECT }
        }
    });
}

function readChecks(value: string): CutoverChecks {
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object" ? (parsed as CutoverChecks) : {};
    } catch {
        return {};
    }
}

function readWritten(value: string): Written {
    try {
        const parsed = JSON.parse(value) as Partial<Written>;
        return {
            records: Array.isArray(parsed.records) ? parsed.records : [],
            created: typeof parsed.created === "string" ? parsed.created : null,
            touched: parsed.touched === true
        };
    } catch {
        return { records: [], created: null, touched: false };
    }
}

/** The services in the same project a domain may move to, within the environments
 *  this access reaches. */
export async function cutoverTargets(
    domainId: string,
    environmentIds: readonly string[] | null
): Promise<{ id: string; name: string; environment: string }[]> {
    const domain = await loadDomain(domainId);
    if (!domain) throw new CutoverRefusedError("not-found");
    const apps = await prisma.application.findMany({
        where: {
            id: { not: domain.application.id },
            environment: { projectId: domain.application.environment.projectId },
            ...(environmentIds ? { environmentId: { in: [...environmentIds] } } : {})
        },
        select: { id: true, name: true, environment: { select: { name: true } } },
        orderBy: { name: "asc" },
        take: TARGET_LIMIT
    });
    return apps.map((app) => ({ id: app.id, name: app.name, environment: app.environment.name }));
}

/** The Cloudflare token and zone that hold this hostname's record, when Polaris has
 *  one: the token of a domain the project's owner proved, else the instance's own. */
async function zoneFor(
    hostname: string,
    owner: { ownerId: string; orgId: string | null }
): Promise<{ token: string; zoneId: string } | null> {
    const caller: TokenCaller = {
        isAdmin: false,
        owners: [
            { kind: "user", id: owner.ownerId },
            ...(owner.orgId ? [{ kind: "org" as const, id: owner.orgId }] : [])
        ]
    };
    const proven = await provenDomainOf(hostname, caller.owners).catch(() => null);
    const ownerToken = proven
        ? openText(
              (
                  await prisma.ownerDomain.findUnique({
                      where: { domain: proven },
                      select: { dnsToken: true }
                  })
              )?.dnsToken ?? null
          )
        : null;
    for (const token of [ownerToken, await loadCloudflareToken()]) {
        if (!token) continue;
        try {
            return { token, zoneId: (await cf.resolveZoneForHostname(token, hostname)).id };
        } catch {
            // This token does not reach the zone; the next one may.
        }
    }
    return null;
}

/** What the public resolvers answer for the name today, and the longest TTL left. */
async function publicAnswer(hostname: string): Promise<{ values: string[]; ttl: number | null }> {
    try {
        const answers = await publicResolver().resolve4(hostname, { ttl: true });
        return {
            values: answers.map((answer) => answer.address),
            ttl: answers.length > 0 ? Math.max(...answers.map((answer) => answer.ttl)) : null
        };
    } catch {
        return { values: [], ttl: null };
    }
}

/** Ask the target's edge for the hostname, giving a freshly staged route a moment. */
async function probeTarget(hostname: string, address: string): Promise<DomainHealth> {
    let health = await checkDomain({ hostname, https: false }, { address });
    for (let attempt = 1; attempt < PROBE_ATTEMPTS && health.notRouted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, PROBE_GAP_MS));
        health = await checkDomain({ hostname, https: false }, { address });
    }
    return health;
}

function answersOf(health: DomainHealth): machine.PreflightChecks["answers"] {
    if (health.notRouted) return "not-routed";
    if (health.status === "up") return "up";
    return health.code === null ? "unknown" : "down";
}

/** Whether a certificate covers the name where it will be served before DNS moves. */
async function tlsReadiness(
    mode: machine.CutoverMode,
    domain: { hostname: string; certPem: string | null; certResolver: string }
): Promise<"ready" | "on-switch"> {
    if (mode === "edge" || domain.certPem || domain.certResolver !== "le") return "ready";
    const parent = domain.hostname.split(".").slice(1).join(".");
    const wildcard = await prisma.managedCertificate.findFirst({
        where: { domain: { in: [domain.hostname, parent] }, status: "issued" },
        select: { id: true }
    });
    return wildcard ? "ready" : "on-switch";
}

async function rewrite(
    zone: { token: string; zoneId: string },
    hostname: string,
    record: KeptRecord,
    change: { content?: string; ttl?: number }
): Promise<void> {
    await cf.saveDnsRecord(zone.token, zone.zoneId, record.id, {
        type: "A",
        name: hostname,
        content: change.content ?? record.content,
        ttl: change.ttl ?? record.ttl,
        proxied: record.proxied
    });
}

/**
 * Open a cutover of one domain to another service of the same project: stage the
 * route on the target's edge, check the target answers for the name, and lower the
 * TTL where Polaris writes the record. One open cutover per domain - asking again
 * answers the one already open.
 */
export async function startCutover(input: {
    domainId: string;
    targetApplicationId: string;
    actorId: string;
    environmentIds: readonly string[] | null;
}): Promise<string> {
    const open = await prisma.dnsCutover.findUnique({
        where: { openKey: input.domainId },
        select: { id: true }
    });
    if (open) return open.id;
    const domain = await loadDomain(input.domainId);
    if (!domain) throw new CutoverRefusedError("not-found");
    if (domain.application.id === input.targetApplicationId) {
        throw new CutoverRefusedError("same-service");
    }
    const target = await prisma.application.findUnique({
        where: { id: input.targetApplicationId },
        select: APP_SELECT
    });
    if (
        !target ||
        target.environment.projectId !== domain.application.environment.projectId ||
        (input.environmentIds !== null && !input.environmentIds.includes(target.environmentId))
    ) {
        throw new CutoverRefusedError("not-allowed");
    }

    const sameEdge =
        machine.edgeKey(domain.application.target, domain.servedBy) ===
        machine.edgeKey(target.target, domain.servedBy);
    const zone = sameEdge
        ? null
        : await zoneFor(domain.hostname, domain.application.environment.project);
    const mode: machine.CutoverMode = sameEdge ? "edge" : zone ? "cloudflare" : "manual";
    const newValue = sameEdge
        ? null
        : (
              await serviceDnsTarget(
                  { kind: target.target.kind, host: target.target.host },
                  domain.servedBy
              )
          ).ip;

    let records: KeptRecord[] = [];
    let oldValues: string[];
    let oldTtl: number | null;
    if (zone) {
        records = (await cf.findDnsRecords(zone.token, zone.zoneId, "A", domain.hostname)).map(
            (record) => ({
                id: record.id,
                content: record.content,
                ttl: record.ttl ?? 1,
                proxied: record.proxied === true
            })
        );
        oldValues = records.map((record) => record.content);
        oldTtl = records.length > 0 ? Math.max(...records.map((record) => record.ttl)) : null;
    } else {
        ({ values: oldValues, ttl: oldTtl } = await publicAnswer(domain.hostname));
    }

    const deployment = target.currentDeploymentId
        ? await prisma.deployment.findUnique({
              where: { id: target.currentDeploymentId },
              select: { status: true }
          })
        : null;

    let row: { id: string };
    try {
        row = await prisma.dnsCutover.create({
            data: {
                domainId: domain.id,
                hostname: domain.hostname,
                sourceApplicationId: domain.application.id,
                targetApplicationId: target.id,
                actorId: input.actorId,
                openKey: domain.id,
                phase: "checking",
                mode,
                oldValues: JSON.stringify(oldValues),
                newValue,
                oldTtl,
                zoneId: zone?.zoneId ?? null,
                recordIds: JSON.stringify({
                    records,
                    created: null,
                    touched: false
                } satisfies Written)
            },
            select: { id: true }
        });
    } catch {
        // Somebody opened one at the same moment; theirs is the cutover.
        const raced = await prisma.dnsCutover.findUnique({
            where: { openKey: domain.id },
            select: { id: true }
        });
        if (raced) return raced.id;
        throw new CutoverRefusedError("not-found");
    }

    // Staged before it is asked, so the target's edge has a route to answer with.
    if (mode !== "edge") await syncAppRoutes().catch(() => undefined);
    const health =
        mode === "edge" || !newValue ? null : await probeTarget(domain.hostname, newValue);
    const preflight: machine.PreflightChecks = {
        deployed: deployment !== null,
        running: deployment?.status === "running",
        answers: health ? answersOf(health) : mode === "edge" ? "skipped" : "unknown",
        code: health?.code ?? null,
        newValue,
        tls: await tlsReadiness(mode, domain)
    };
    const now = new Date();
    const start = machine.initialState(mode, preflight, oldTtl, now);
    let failure = start.failure;
    if (!failure && zone && machine.lowersTtl(mode, oldTtl)) {
        try {
            for (const record of records) {
                await rewrite(zone, domain.hostname, record, { ttl: machine.LOWERED_TTL });
            }
        } catch {
            failure = "record-write-failed";
        }
    }
    const checks: CutoverChecks = {
        preflight,
        route: { targetPort: domain.targetPort, portPinned: domain.portPinned },
        checkedAt: now.toISOString()
    };
    const closed = start.phase === "preflight-failed";
    await prisma.dnsCutover.update({
        where: { id: row.id },
        data: {
            phase: start.phase,
            failure,
            lowerUntil: start.lowerUntil,
            checks: JSON.stringify(checks),
            ...(closed ? { openKey: null, finishedAt: now } : {})
        }
    });
    if (closed && mode !== "edge") await syncAppRoutes().catch(() => undefined);
    await recordDeployAudit({
        actorId: input.actorId,
        action: "deploy.domain.cutover.start",
        targetType: "domain",
        targetId: domain.id,
        metadata: { hostname: domain.hostname, to: target.id, mode, phase: start.phase }
    });
    return row.id;
}

async function loadCutover(id: string) {
    const row = await prisma.dnsCutover.findUnique({ where: { id } });
    if (!row) throw new CutoverRefusedError("not-found");
    return row;
}

async function zoneOf(row: { hostname: string; zoneId: string | null; domainId: string }) {
    const domain = await loadDomain(row.domainId);
    if (!domain) throw new CutoverRefusedError("not-found");
    const zone = await zoneFor(row.hostname, domain.application.environment.project);
    if (!zone || zone.zoneId !== row.zoneId) throw new Error("zone-unreachable");
    return zone;
}

/** Put the name's A records back the way the cutover found them, from what the zone
 *  holds now, so a rollback cut short and tried again converges instead of
 *  repeating what already happened. */
async function restoreRecords(
    zone: { token: string; zoneId: string },
    row: { hostname: string; newValue: string | null },
    written: Written
): Promise<void> {
    const current = await cf.findDnsRecords(zone.token, zone.zoneId, "A", row.hostname);
    const kept = new Set(written.records.map((record) => record.id));
    const spare = current.filter((entry) => !kept.has(entry.id));
    for (const record of written.records) {
        if (current.some((entry) => entry.id === record.id)) {
            await rewrite(zone, row.hostname, record, {});
            continue;
        }
        const again = spare.find(
            (entry) => entry.id !== written.created && entry.content === record.content
        );
        if (again) {
            spare.splice(spare.indexOf(again), 1);
            await rewrite(zone, row.hostname, { ...record, id: again.id }, {});
            continue;
        }
        await cf.saveDnsRecord(zone.token, zone.zoneId, null, {
            type: "A",
            name: row.hostname,
            content: record.content,
            ttl: record.ttl,
            proxied: record.proxied
        });
    }
    for (const entry of spare) {
        if (
            entry.id === written.created ||
            (row.newValue !== null && entry.content === row.newValue)
        ) {
            await cf.deleteDnsRecord(zone.token, zone.zoneId, entry.id);
        }
    }
}

async function moveRoute(domainId: string, applicationId: string, route?: CutoverChecks["route"]) {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { sourceType: true, sourceConfig: true, domains: { select: { targetPort: true } } }
    });
    if (!app) throw new CutoverRefusedError("not-found");
    await prisma.domain.update({
        where: { id: domainId },
        data: {
            applicationId,
            targetPort: route?.targetPort ?? containerPortOf(app),
            portPinned: route?.portPinned ?? false
        }
    });
}

/**
 * What the screen shows for a domain: its latest cutover, freshly checked when the
 * screen has been waiting on it longer than the gap, and the services it may move to.
 */
export async function cutoverPanel(
    domainId: string,
    environmentIds: readonly string[] | null
): Promise<{
    cutover: machine.CutoverView | null;
    targets: { id: string; name: string; environment: string }[];
}> {
    const latest = () =>
        prisma.dnsCutover.findFirst({ where: { domainId }, orderBy: { createdAt: "desc" } });
    let row = await latest();
    if (row?.openKey) {
        const checkedAt = readChecks(row.checks).checkedAt;
        const at = checkedAt ? new Date(checkedAt) : null;
        if (
            machine.screenShouldCheck(
                machine.readPhase(row.phase),
                at && !Number.isNaN(at.getTime()) ? at : null,
                new Date()
            )
        ) {
            await advanceCutover(row.id).catch((error) => {
                console.error(`polaris: DNS cutover ${row?.id} could not be checked:`, error);
            });
            row = await latest();
        }
    }
    const targets = await cutoverTargets(domainId, environmentIds);
    if (!row) return { cutover: null, targets };
    const names = new Map(
        (
            await prisma.application.findMany({
                where: { id: { in: [row.sourceApplicationId, row.targetApplicationId] } },
                select: { id: true, name: true }
            })
        ).map((app) => [app.id, app.name])
    );
    return {
        cutover: machine.cutoverView(row, {
            source: names.get(row.sourceApplicationId) ?? "",
            target: names.get(row.targetApplicationId) ?? ""
        }),
        targets
    };
}

/** The open cutover of a domain, or a refusal saying there is none. */
export async function openCutoverId(domainId: string): Promise<string> {
    const open = await prisma.dnsCutover.findUnique({
        where: { openKey: domainId },
        select: { id: true }
    });
    if (!open) throw new CutoverRefusedError("closed");
    return open.id;
}

/**
 * Point the name at the target. Only from `lowering` or `ready`: the phase is claimed
 * first, so a second press finds nothing to do. A record Cloudflare refused leaves the
 * cutover where it was, with the reason, to be tried again.
 */
export async function switchCutover(id: string, actorId: string): Promise<void> {
    const row = await loadCutover(id);
    const phase = machine.readPhase(row.phase);
    const mode = machine.readMode(row.mode);
    const effects = machine.switchEffects({ phase, mode });
    if (!machine.canSwitch(phase)) return;
    const claimed = await prisma.dnsCutover.updateMany({
        where: { id, phase: row.phase },
        data: { phase: "propagating", switchedAt: new Date(), failure: null }
    });
    if (claimed.count === 0) return;
    let written = readWritten(row.recordIds);
    const save = async (next: Written) => {
        written = next;
        await prisma.dnsCutover.update({
            where: { id },
            data: { recordIds: JSON.stringify(next) }
        });
    };
    try {
        await save({ ...written, touched: true });
        for (const effect of effects) {
            if (effect === "write-record") {
                const zone = await zoneOf(row);
                const present = new Set(
                    (await cf.findDnsRecords(zone.token, zone.zoneId, "A", row.hostname)).map(
                        (entry) => entry.id
                    )
                );
                const ttl = machine.lowersTtl(mode, row.oldTtl) ? machine.LOWERED_TTL : undefined;
                const [first, ...rest] = written.records;
                if (first && present.has(first.id)) {
                    await rewrite(zone, row.hostname, first, { content: row.newValue ?? "", ttl });
                } else if (!written.created || !present.has(written.created)) {
                    const created = (
                        await cf.saveDnsRecord(zone.token, zone.zoneId, null, {
                            type: "A",
                            name: row.hostname,
                            content: row.newValue ?? "",
                            ttl: machine.LOWERED_TTL,
                            proxied: false
                        })
                    ).id;
                    await save({ ...written, created });
                }
                for (const other of rest) {
                    if (present.has(other.id))
                        await cf.deleteDnsRecord(zone.token, zone.zoneId, other.id);
                }
            } else if (effect === "move-route") {
                await moveRoute(row.domainId, row.targetApplicationId);
            } else if (effect === "republish") {
                await syncAppRoutes();
            }
        }
    } catch {
        await prisma.dnsCutover.update({
            where: { id },
            data: {
                phase: row.phase,
                switchedAt: null,
                failure: mode === "edge" ? "route-move-failed" : "record-write-failed"
            }
        });
        return;
    }
    await recordDeployAudit({
        actorId,
        action: "deploy.domain.cutover.switch",
        targetType: "domain",
        targetId: row.domainId,
        metadata: { hostname: row.hostname, mode, to: row.newValue }
    });
}

/**
 * Put everything back the way it was before the cutover and close it. The cutover is
 * closed first, so a second press - or the background pass reaching it at the same
 * moment - finds nothing to do; a record Cloudflare refused reopens it, with the
 * reason, to be tried again.
 */
export async function rollbackCutover(id: string, actorId: string): Promise<void> {
    const row = await loadCutover(id);
    const phase = machine.readPhase(row.phase);
    const mode = machine.readMode(row.mode);
    const effects = machine.rollbackEffects({
        phase,
        mode,
        switchedAt: row.switchedAt,
        oldTtl: row.oldTtl,
        touched: readWritten(row.recordIds).touched
    });
    if (effects.length === 0) return;
    const claimed = await prisma.dnsCutover.updateMany({
        where: { id, phase: row.phase },
        data: { phase: "rolled-back", openKey: null, finishedAt: new Date() }
    });
    if (claimed.count === 0) return;
    const checks = readChecks(row.checks);
    try {
        for (const effect of effects) {
            if (effect === "restore-record") {
                await restoreRecords(await zoneOf(row), row, readWritten(row.recordIds));
            } else if (effect === "move-route-back") {
                await moveRoute(row.domainId, row.sourceApplicationId, checks.route);
            }
        }
    } catch (error) {
        console.error(`polaris: DNS cutover ${id} could not be rolled back:`, error);
        await prisma.dnsCutover
            .update({
                where: { id },
                data: {
                    phase: row.phase,
                    openKey: row.openKey,
                    finishedAt: null,
                    failure: mode === "edge" ? "rollback-route-failed" : "rollback-write-failed"
                }
            })
            .catch(() => undefined);
        return;
    }
    if (effects.includes("republish")) await syncAppRoutes().catch(() => undefined);
    await recordDeployAudit({
        actorId,
        action: "deploy.domain.cutover.rollback",
        targetType: "domain",
        targetId: row.domainId,
        metadata: { hostname: row.hostname, mode, restored: machine.readList(row.oldValues) }
    });
}

/** Hand the domain to the target for good and put the TTL back. */
async function finish(row: Awaited<ReturnType<typeof loadCutover>>): Promise<void> {
    const mode = machine.readMode(row.mode);
    const effects = machine.finishEffects({ phase: "finishing", mode, oldTtl: row.oldTtl });
    for (const effect of effects) {
        if (effect === "move-route") {
            const domain = await prisma.domain.findUnique({
                where: { id: row.domainId },
                select: { applicationId: true }
            });
            if (domain && domain.applicationId !== row.targetApplicationId) {
                await moveRoute(row.domainId, row.targetApplicationId);
            }
        } else if (effect === "restore-ttl") {
            try {
                const zone = await zoneOf(row);
                const first = readWritten(row.recordIds).records[0];
                if (first && row.newValue && row.oldTtl !== null) {
                    await rewrite(zone, row.hostname, first, {
                        content: row.newValue,
                        ttl: row.oldTtl
                    });
                }
            } catch {
                // The cutover is done either way; a short TTL is harmless and the
                // record editor shows it.
            }
        }
    }
    // Closed before the publish, so the staged route is not written again.
    const closed = await prisma.dnsCutover.updateMany({
        where: { id: row.id, phase: "finishing" },
        data: { phase: "done", openKey: null, finishedAt: new Date() }
    });
    if (effects.includes("republish")) await syncAppRoutes().catch(() => undefined);
    if (closed.count === 0) return;
    await recordDeployAudit({
        actorId: row.actorId,
        action: "deploy.domain.cutover.finish",
        targetType: "domain",
        targetId: row.domainId,
        metadata: {
            hostname: row.hostname,
            from: row.sourceApplicationId,
            to: row.targetApplicationId,
            mode,
            value: row.newValue
        }
    });
}

/** One look at one open cutover: the lowering's clock, or the resolvers and the
 *  new service once switched. Safe to run as often as anybody likes. */
export async function advanceCutover(id: string): Promise<void> {
    const row = await loadCutover(id);
    const phase = machine.readPhase(row.phase);
    const mode = machine.readMode(row.mode);
    const now = new Date();
    if (phase === "finishing") return finish(row);
    if (phase !== "lowering" && phase !== "propagating") return;
    const checks = readChecks(row.checks);
    let observation: machine.PropagationObservation | null = null;
    if (phase === "propagating") {
        const domain = await loadDomain(row.domainId);
        const written = readWritten(row.recordIds);
        const proxied = written.records.some((record) => record.proxied);
        const [report, health] = await Promise.all([
            mode === "edge"
                ? null
                : checkPropagation(
                      row.hostname,
                      "A",
                      proxied || !row.newValue ? null : [row.newValue]
                  ),
            checkDomain({ hostname: row.hostname, https: domain?.https ?? true })
        ]);
        checks.propagation = report
            ? {
                  settled: report.settled,
                  resolvers: report.resolvers.map((entry) => ({
                      label: entry.label,
                      status: entry.status,
                      values: entry.values,
                      agrees: entry.agrees
                  }))
              }
            : undefined;
        checks.target = { status: health.status, code: health.code };
        observation = {
            dnsSettled: report ? report.settled : true,
            targetUp: health.status === "up"
        };
    }
    checks.checkedAt = now.toISOString();
    const next = machine.tick(
        { phase, mode, lowerUntil: row.lowerUntil, switchedAt: row.switchedAt, oldTtl: row.oldTtl },
        observation,
        now
    );
    const moved = await prisma.dnsCutover.updateMany({
        where: { id, phase: row.phase },
        data: {
            phase: next.phase,
            failure: next.failure ?? row.failure,
            checks: JSON.stringify(checks),
            passes: { increment: 1 }
        }
    });
    if (moved.count > 0 && next.phase === "finishing") await finish({ ...row, phase: "finishing" });
}

/** The background pass: every open cutover that is waiting on time or on DNS. */
export async function runCutoverPass(): Promise<{ looked: number }> {
    const open = await prisma.dnsCutover.findMany({
        where: { openKey: { not: null }, phase: { in: ["lowering", "propagating", "finishing"] } },
        select: { id: true },
        orderBy: { updatedAt: "asc" },
        take: PASS_LIMIT
    });
    for (const row of open) {
        await advanceCutover(row.id).catch((error) => {
            console.error(`polaris: DNS cutover ${row.id} could not be advanced:`, error);
        });
    }
    return { looked: open.length };
}
