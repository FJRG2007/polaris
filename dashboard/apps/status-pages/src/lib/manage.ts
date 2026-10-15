/**
 * The operator's side: pages, components, checks, incidents and maintenance.
 * Every function here is called by an action that has already required
 * `status.manage` and validated its input.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { StatusRefusal } from "./outcome";
import { trySyncStatusEdge } from "./edge";
import type { CheckInput, PageInput } from "../model/schemas";
import { transition, type IncidentState } from "../model/incidents";

export interface PageSummary {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly published: boolean;
    readonly components: number;
    readonly openIncidents: number;
}

export async function listPages(): Promise<PageSummary[]> {
    const pages = await prisma.statusPage.findMany({
        orderBy: { createdAt: "asc" },
        take: 200,
        select: {
            id: true,
            slug: true,
            title: true,
            published: true,
            _count: { select: { components: true, incidents: { where: { resolvedAt: null } } } }
        }
    });
    return pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        published: page.published,
        components: page._count.components,
        openIncidents: page._count.incidents
    }));
}

export interface CheckView {
    readonly id: string;
    readonly kind: string;
    readonly target: string;
    readonly port: number | null;
    readonly expectStatus: number | null;
    readonly keyword: string;
    readonly dnsType: string | null;
    readonly dnsExpect: string;
    readonly intervalSec: number;
    readonly timeoutMs: number;
    readonly enabled: boolean;
    readonly lastStatus: string | null;
    readonly lastLatencyMs: number | null;
    readonly lastError: string | null;
    readonly lastCheckedAt: string | null;
}

export interface PageDetail {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly published: boolean;
    readonly customDomain: string | null;
    readonly components: readonly {
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly checks: readonly CheckView[];
    }[];
    readonly incidents: readonly {
        readonly id: string;
        readonly title: string;
        readonly state: string;
        readonly impact: string;
        readonly componentIds: readonly string[];
        readonly startedAt: string;
        readonly resolvedAt: string | null;
        readonly updates: readonly { readonly id: string; readonly state: string; readonly body: string; readonly at: string }[];
    }[];
    readonly maintenance: readonly {
        readonly id: string;
        readonly title: string;
        readonly body: string;
        readonly componentIds: readonly string[];
        readonly startsAt: string;
        readonly endsAt: string;
    }[];
}

export async function pageDetail(id: string): Promise<PageDetail> {
    const page = await prisma.statusPage.findUnique({
        where: { id },
        select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            published: true,
            customDomain: true,
            components: {
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                select: {
                    id: true,
                    name: true,
                    description: true,
                    checks: { orderBy: { createdAt: "asc" } }
                }
            },
            incidents: {
                orderBy: { startedAt: "desc" },
                take: 50,
                select: {
                    id: true,
                    title: true,
                    state: true,
                    impact: true,
                    componentIds: true,
                    startedAt: true,
                    resolvedAt: true,
                    updates: {
                        orderBy: { createdAt: "desc" },
                        take: 50,
                        select: { id: true, state: true, body: true, createdAt: true }
                    }
                }
            },
            maintenance: {
                orderBy: { startsAt: "desc" },
                take: 50,
                select: { id: true, title: true, body: true, componentIds: true, startsAt: true, endsAt: true }
            }
        }
    });
    if (!page) throw new StatusRefusal("errors.pageGone");
    return {
        ...page,
        components: page.components.map((component) => ({
            ...component,
            checks: component.checks.map((check) => ({
                id: check.id,
                kind: check.kind,
                target: check.target,
                port: check.port,
                expectStatus: check.expectStatus,
                keyword: check.keyword,
                dnsType: check.dnsType,
                dnsExpect: check.dnsExpect,
                intervalSec: check.intervalSec,
                timeoutMs: check.timeoutMs,
                enabled: check.enabled,
                lastStatus: check.lastStatus,
                lastLatencyMs: check.lastLatencyMs,
                lastError: check.lastError,
                lastCheckedAt: check.lastCheckedAt?.toISOString() ?? null
            }))
        })),
        incidents: page.incidents.map((incident) => ({
            ...incident,
            startedAt: incident.startedAt.toISOString(),
            resolvedAt: incident.resolvedAt?.toISOString() ?? null,
            updates: incident.updates.map((update) => ({
                id: update.id,
                state: update.state,
                body: update.body,
                at: update.createdAt.toISOString()
            }))
        })),
        maintenance: page.maintenance.map((window) => ({
            ...window,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString()
        }))
    };
}

function isUniqueViolation(caught: unknown): boolean {
    return (caught as { code?: string } | null)?.code === "P2002";
}

export async function savePage(id: string | null, input: PageInput, userId: string): Promise<{ id: string }> {
    try {
        if (id) {
            await prisma.statusPage.update({ where: { id }, data: input });
            // Publishing, unpublishing or a new slug changes what its domain serves.
            await trySyncStatusEdge();
            return { id };
        }
        const page = await prisma.statusPage.create({ data: { ...input, createdById: userId }, select: { id: true } });
        return page;
    } catch (caught) {
        if (isUniqueViolation(caught)) throw new StatusRefusal("errors.slugTaken");
        throw caught;
    }
}

export async function deletePage(id: string): Promise<void> {
    await prisma.statusPage.deleteMany({ where: { id } });
    await trySyncStatusEdge();
}

/** How a page's custom domain stands: the record it needs, and whether it
 *  already points here. */
export interface DomainStatus {
    readonly domain: string;
    /** `ready` - the name answers with this server's address.
     *  `created` - Polaris just wrote the record through the connected DNS account.
     *  `conflict` - a record exists and points elsewhere (`current`).
     *  `manual` - the operator adds the record; `ip` is what it must name, null
     *  when this server does not know its own public address. */
    readonly state: "ready" | "created" | "conflict" | "manual";
    readonly ip: string | null;
    readonly current: string | null;
    /** Whether the edge file was written with this domain in it. */
    readonly routed: boolean;
}

/** Asks DNS (and the connected DNS account, when there is one) about a domain. */
export async function domainStatus(domain: string, routed: boolean): Promise<DomainStatus> {
    const result = await host.domainDns.provisionHostnameDns(domain);
    return {
        domain,
        state: result.status === "unchanged" ? "ready" : result.status,
        ip: result.ip,
        current: result.content ?? null,
        routed
    };
}

/** Sets or removes a page's custom domain and rewrites the edge. */
export async function setCustomDomain(id: string, domain: string | null): Promise<DomainStatus | null> {
    if (domain) {
        const [taken, other] = await Promise.all([
            host.appEdge.edgeHostnameTaken(domain),
            prisma.statusPage.findFirst({
                where: { customDomain: domain, NOT: { id } },
                select: { id: true }
            })
        ]);
        if (taken || other) throw new StatusRefusal("errors.domainTaken");
    }
    try {
        await prisma.statusPage.update({ where: { id }, data: { customDomain: domain } });
    } catch (caught) {
        if (isUniqueViolation(caught)) throw new StatusRefusal("errors.domainTaken");
        throw caught;
    }
    const routed = await trySyncStatusEdge();
    if (!domain) {
        if (!routed) throw new StatusRefusal("errors.edgeWrite");
        return null;
    }
    return domainStatus(domain, routed);
}

/** Checks a page's domain again, rewriting the edge on the way so a missed
 *  write repairs itself from here. */
export async function checkCustomDomain(id: string): Promise<DomainStatus | null> {
    const page = await prisma.statusPage.findUnique({ where: { id }, select: { customDomain: true } });
    if (!page) throw new StatusRefusal("errors.pageGone");
    if (!page.customDomain) return null;
    const routed = await trySyncStatusEdge();
    return domainStatus(page.customDomain, routed);
}

export async function addComponent(input: { pageId: string; name: string; description: string }) {
    const last = await prisma.statusComponent.findFirst({
        where: { pageId: input.pageId },
        orderBy: { position: "desc" },
        select: { position: true }
    });
    return prisma.statusComponent.create({
        data: { ...input, position: (last?.position ?? 0) + 1 },
        select: { id: true }
    });
}

export async function updateComponent(id: string, input: { name: string; description: string }) {
    await prisma.statusComponent.update({ where: { id }, data: input });
}

export async function deleteComponent(id: string) {
    await prisma.statusComponent.deleteMany({ where: { id } });
}

/** The stored row for a check, every field the kind does not use cleared. */
export function checkRow(input: CheckInput) {
    const base = {
        componentId: input.componentId,
        kind: input.kind,
        target: input.target,
        intervalSec: input.intervalSec,
        timeoutMs: input.timeoutMs,
        enabled: input.enabled,
        port: null as number | null,
        expectStatus: null as number | null,
        keyword: "",
        dnsType: null as string | null,
        dnsExpect: ""
    };
    switch (input.kind) {
        case "http":
            return { ...base, expectStatus: input.expectStatus, keyword: input.keyword };
        case "tcp":
        case "ping":
            return { ...base, port: input.port };
        case "dns":
            return { ...base, dnsType: input.dnsType, dnsExpect: input.dnsExpect };
    }
}

export async function saveCheck(id: string | null, input: CheckInput) {
    const data = { ...checkRow(input), nextRunAt: new Date() };
    if (id) {
        await prisma.statusCheck.update({ where: { id }, data });
        return { id };
    }
    return prisma.statusCheck.create({ data, select: { id: true } });
}

export async function deleteCheck(id: string) {
    await prisma.statusCheck.deleteMany({ where: { id } });
}

export async function openIncident(input: {
    pageId: string;
    title: string;
    impact: string;
    state: IncidentState;
    body: string;
    componentIds: string[];
}) {
    const now = new Date();
    return prisma.statusIncident.create({
        data: {
            pageId: input.pageId,
            title: input.title,
            impact: input.impact,
            state: input.state,
            componentIds: input.componentIds,
            startedAt: now,
            resolvedAt: input.state === "resolved" ? now : null,
            updates: { create: { state: input.state, body: input.body } }
        },
        select: { id: true }
    });
}

export async function postIncidentUpdate(input: { incidentId: string; state: IncidentState; body: string }) {
    const incident = await prisma.statusIncident.findUnique({
        where: { id: input.incidentId },
        select: { state: true, resolvedAt: true }
    });
    if (!incident) throw new StatusRefusal("errors.incidentGone");
    const next = transition(
        { state: incident.state as IncidentState, resolvedAt: incident.resolvedAt },
        input.state,
        new Date()
    );
    if (!next.ok) throw new StatusRefusal("errors.resolvedReopen");
    await prisma.statusIncident.update({
        where: { id: input.incidentId },
        data: {
            state: next.state,
            resolvedAt: next.resolvedAt,
            updates: { create: { state: input.state, body: input.body } }
        }
    });
}

export async function deleteIncident(id: string) {
    await prisma.statusIncident.deleteMany({ where: { id } });
}

export async function saveMaintenance(input: {
    pageId: string;
    title: string;
    body: string;
    componentIds: string[];
    startsAt: Date;
    endsAt: Date;
}) {
    return prisma.statusMaintenance.create({ data: input, select: { id: true } });
}

export async function deleteMaintenance(id: string) {
    await prisma.statusMaintenance.deleteMany({ where: { id } });
}

/** Polaris's own deployed addresses, for a check to point at without typing. */
export async function deployedTargets(): Promise<{ label: string; url: string }[]> {
    const domains = await prisma.domain.findMany({
        where: { enabled: true, NOT: { kind: "release" } },
        orderBy: { hostname: "asc" },
        take: 200,
        select: { hostname: true, https: true, application: { select: { name: true } } }
    });
    return domains.map((domain) => ({
        label: `${domain.application.name} (${domain.hostname})`,
        url: `${domain.https ? "https" : "http"}://${domain.hostname}/`
    }));
}
