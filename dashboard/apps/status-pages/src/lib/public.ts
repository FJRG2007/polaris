/**
 * A status page as anybody with its address sees it.
 *
 * Only what the page is for leaves here: names, states, bars, incidents and
 * maintenance. A check's target, port, error and the page's author never do -
 * a target is often an address inside the operator's network. An unpublished
 * page is not found, whoever asks.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import {
    isOpen,
    maintenanceActive,
    type IncidentImpact,
    type IncidentState
} from "../model/incidents";
import {
    HISTORY_DAYS,
    componentState,
    dayBars,
    dayKey,
    dayStart,
    pageState,
    uptimePercent,
    type ComponentState,
    type DayBar
} from "../model/uptime";

/** How far back resolved incidents are listed. */
const INCIDENT_WINDOW_DAYS = 14;

export interface PublicComponent {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly state: ComponentState;
    readonly uptime: number | null;
    readonly bars: readonly DayBar[];
}

export interface PublicIncident {
    readonly id: string;
    readonly title: string;
    readonly state: IncidentState;
    readonly impact: IncidentImpact;
    readonly startedAt: string;
    readonly resolvedAt: string | null;
    readonly components: readonly string[];
    readonly updates: readonly {
        readonly state: IncidentState;
        readonly body: string;
        readonly at: string;
    }[];
}

export interface PublicMaintenance {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly active: boolean;
    readonly components: readonly string[];
}

export interface PublicStatusPage {
    readonly title: string;
    readonly description: string;
    readonly state: ComponentState;
    readonly components: readonly PublicComponent[];
    readonly incidents: readonly PublicIncident[];
    readonly maintenance: readonly PublicMaintenance[];
}

/** Reads one page for the public; null when there is none to show. */
export async function publicStatusPage(
    slug: string,
    now = new Date(),
    options: { readonly includeUnpublished?: boolean } = {}
): Promise<PublicStatusPage | null> {
    const since = new Date(dayStart(now).getTime() - (HISTORY_DAYS - 1) * 86_400_000);
    const incidentsSince = new Date(now.getTime() - INCIDENT_WINDOW_DAYS * 86_400_000);
    const page = await prisma.statusPage.findFirst({
        where: options.includeUnpublished ? { slug } : { slug, published: true },
        select: {
            title: true,
            description: true,
            components: {
                orderBy: [{ position: "asc" }, { createdAt: "asc" }],
                take: 100,
                select: {
                    id: true,
                    name: true,
                    description: true,
                    checks: {
                        where: { enabled: true },
                        select: {
                            lastStatus: true,
                            days: {
                                where: { day: { gte: since } },
                                select: { day: true, total: true, up: true }
                            }
                        }
                    }
                }
            },
            incidents: {
                where: { OR: [{ resolvedAt: null }, { startedAt: { gte: incidentsSince } }] },
                orderBy: { startedAt: "desc" },
                take: 20,
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
                        take: 20,
                        select: { state: true, body: true, createdAt: true }
                    }
                }
            },
            maintenance: {
                where: { endsAt: { gte: now } },
                orderBy: { startsAt: "asc" },
                take: 10,
                select: {
                    id: true,
                    title: true,
                    body: true,
                    componentIds: true,
                    startsAt: true,
                    endsAt: true
                }
            }
        }
    });
    if (!page) return null;

    const names = new Map(page.components.map((component) => [component.id, component.name]));
    const named = (ids: readonly string[]) =>
        ids.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
    const activeWindows = page.maintenance.filter((window) => maintenanceActive(window, now));

    const components = page.components.map((component): PublicComponent => {
        const rollups = component.checks.flatMap((check) =>
            check.days.map((day) => ({ day: dayKey(day.day), total: day.total, up: day.up }))
        );
        const inMaintenance = activeWindows.some((window) =>
            window.componentIds.includes(component.id)
        );
        return {
            id: component.id,
            name: component.name,
            description: component.description,
            state: componentState(
                component.checks.map((check) => check.lastStatus),
                inMaintenance
            ),
            uptime: uptimePercent(rollups),
            bars: dayBars(rollups, now)
        };
    });

    return {
        title: page.title,
        description: page.description,
        state: pageState(components.map((component) => component.state)),
        components,
        incidents: page.incidents.map((incident) => ({
            id: incident.id,
            title: incident.title,
            state: incident.state as IncidentState,
            impact: incident.impact as IncidentImpact,
            startedAt: incident.startedAt.toISOString(),
            resolvedAt: incident.resolvedAt?.toISOString() ?? null,
            components: named(incident.componentIds),
            updates: incident.updates.map((update) => ({
                state: update.state as IncidentState,
                body: update.body,
                at: update.createdAt.toISOString()
            }))
        })),
        maintenance: page.maintenance.map((window) => ({
            id: window.id,
            title: window.title,
            body: window.body,
            startsAt: window.startsAt.toISOString(),
            endsAt: window.endsAt.toISOString(),
            active: maintenanceActive(window, now),
            components: named(window.componentIds)
        }))
    };
}

/** Whether any incident on the page is still open. */
export function hasOpenIncident(page: PublicStatusPage): boolean {
    return page.incidents.some((incident) => isOpen(incident.state));
}
