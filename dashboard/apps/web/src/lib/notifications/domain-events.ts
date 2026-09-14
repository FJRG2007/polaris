/**
 * Telling somebody a domain stopped serving.
 *
 * The health probe has always recorded reachability, but only a Watch alarm somebody
 * had thought to create by hand ever turned that into an alert. So a domain could sit
 * at "down" indefinitely, visible to whoever opened the page and to nobody else - which
 * is how a service keeps answering on its host port while its public address serves
 * 502s and the first report comes from a visitor.
 *
 * Raised on the transition only, and only after a streak, so a domain that stays down
 * says so once instead of every minute, and one bad probe says nothing at all.
 *
 * The people told are the ones who can act: the project's owner and its admins.
 * A viewer cannot fix a broken route, and paging them teaches everyone to ignore this.
 */

import { notify } from "./dispatch";
import { prisma } from "@polaris/db";
import { parseProjectCapabilities } from "@polaris/core";
import { dispatchProjectWebhooks } from "../deploy-project-service";

/** Where a domain sits, in words, plus who is answerable for it. */
interface DomainContext {
    label: string;
    href: string;
    projectId: string;
    recipients: string[];
}

/** One domain's change of reachability, as a probe saw it. */
export interface DomainHealthChange {
    readonly domainId: string;
    readonly status: "up" | "down";
    readonly detail: string | null;
}

/** Names a sweep's message lists before it stops naming them. Past a handful the
 *  list is not what anybody is reading it for - the count is. */
const NAMES_SHOWN = 3;

function listNames(labels: readonly string[]): string {
    if (labels.length <= NAMES_SHOWN) return labels.join(", ");
    return `${labels.slice(0, NAMES_SHOWN).join(", ")} and ${labels.length - NAMES_SHOWN} more`;
}

/**
 * What one person is told, given how many of the domains they answer for moved
 * at once.
 *
 * Pure, and the only place either sentence is written. The single-domain alert
 * and a whole sweep's are the same message at two sizes, and writing them apart
 * is how they come to disagree.
 *
 * Past one the count becomes the headline and the names move into the body,
 * which is how `outageHeadline` says it for a place full of cameras: when
 * everything went at once, how much went is the diagnosis, and it belongs in the
 * sentence rather than in a detail somebody has to go and open.
 */
export function domainHealthMessage(
    status: "up" | "down",
    labels: readonly string[],
    detail: string | null
): { title: string; body: string } {
    const down = status === "down";
    if (labels.length === 1) {
        return {
            title: down ? `Domain not serving: ${labels[0]}` : `Domain serving again: ${labels[0]}`,
            body: down
                ? `${detail ?? "It stopped answering"}. The service itself may still be running - check the domain's route and the port it points at.`
                : "It is answering again."
        };
    }
    return {
        title: down
            ? `${labels.length} domains stopped serving`
            : `${labels.length} domains are answering again`,
        body: down
            ? `${listNames(labels)}. They went down together, so this is usually the connection or the edge rather than the services themselves.`
            : `${listNames(labels)}.`
    };
}

/**
 * The project owner and everybody its access entries let point a hostname
 * somewhere, deduped, for several projects at once. Whoever can only read is
 * left out: this is an alert about something being broken, addressed to whoever
 * can undo it, and paging people who cannot teaches everyone to ignore it.
 *
 * A team or an organization holding the capability is expanded to its people -
 * an alert nobody is named on is an alert nobody reads.
 *
 * Several projects in one read rather than one read each, because the case this
 * exists for is every domain on the box moving in the same pass.
 */
async function answerableForMany(
    projects: readonly { id: string; ownerId: string }[]
): Promise<Map<string, string[]>> {
    const byProject = new Map<string, Set<string>>();
    for (const project of projects) byProject.set(project.id, new Set([project.ownerId]));
    if (projects.length === 0) return new Map();

    const entries = await prisma.projectMember.findMany({
        where: {
            projectId: { in: projects.map((project) => project.id) },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        select: {
            projectId: true,
            capabilities: true,
            userId: true,
            team: { select: { members: { select: { userId: true } } } },
            org: { select: { ownerId: true, members: { select: { userId: true } } } }
        }
    });
    for (const entry of entries) {
        const recipients = byProject.get(entry.projectId);
        if (!recipients) continue;
        if (!parseProjectCapabilities(entry.capabilities).includes("domains.manage")) continue;
        if (entry.userId) recipients.add(entry.userId);
        for (const member of entry.team?.members ?? []) recipients.add(member.userId);
        if (entry.org) {
            recipients.add(entry.org.ownerId);
            for (const member of entry.org.members) recipients.add(member.userId);
        }
    }
    return new Map([...byProject].map(([id, recipients]) => [id, [...recipients]]));
}

async function describeDomains(
    domainIds: readonly string[]
): Promise<Map<string, DomainContext>> {
    const domains = await prisma.domain.findMany({
        where: { id: { in: [...domainIds] } },
        select: {
            id: true,
            hostname: true,
            application: {
                select: {
                    id: true,
                    name: true,
                    environment: {
                        select: { project: { select: { id: true, name: true, ownerId: true } } }
                    }
                }
            }
        }
    });

    const projects = new Map<string, { id: string; ownerId: string }>();
    for (const domain of domains) {
        const project = domain.application.environment.project;
        projects.set(project.id, { id: project.id, ownerId: project.ownerId });
    }
    const recipients = await answerableForMany([...projects.values()]);

    const found = new Map<string, DomainContext>();
    for (const domain of domains) {
        const app = domain.application;
        const project = app.environment.project;
        found.set(domain.id, {
            // The service as well as the hostname: an operator reading this on a phone
            // should not have to look up which of their services the name belongs to.
            label: `${domain.hostname} (${project.name} / ${app.name})`,
            href: `/apps/deploy/${project.id}?service=${app.id}`,
            projectId: project.id,
            recipients: recipients.get(project.id) ?? [project.ownerId]
        });
    }
    return found;
}

async function describeDomain(domainId: string): Promise<DomainContext | null> {
    return (await describeDomains([domainId])).get(domainId) ?? null;
}

/**
 * Raise the alert for a domain that changed reachability. Never throws: it runs inside
 * the health poller, and a probe that found something broken must not also break.
 *
 * `detail` is the probe's own reason ("HTTP 502", "Timed out"), which is the difference
 * between an alert somebody can act on and one that only says something is wrong.
 */
export async function notifyDomainHealthChanged(input: DomainHealthChange): Promise<void> {
    try {
        const context = await describeDomain(input.domainId);
        if (!context) return;

        const down = input.status === "down";
        const event = down ? "domain.down" : "domain.up";
        const { title, body } = domainHealthMessage(input.status, [context.label], input.detail);

        for (const userId of context.recipients) {
            await notify({
                userId,
                event,
                title,
                body,
                href: context.href,
                actionRequired: down,
                metadata: { domainId: input.domainId, status: input.status }
            });
        }

        await dispatchProjectWebhooks({
            projectId: context.projectId,
            event,
            title,
            body,
            url: context.href,
            level: down ? "danger" : "success"
        });
    } catch (error) {
        console.error("polaris: could not raise the domain notification:", error);
    }
}

/** One domain that moved, with the context the message is built from. */
interface Moved {
    readonly domainId: string;
    readonly context: DomainContext;
    readonly detail: string | null;
}

/** Where a sweep's alert points, since the domains in one span projects. */
const SWEEP_HREF = "/apps/deploy";

/**
 * The same, for everything one sweep found, said once.
 *
 * A home connection going down does not take one domain with it. It takes every
 * domain on the box, and the probe watches them all cross the threshold in the
 * same pass - so telling each one separately is one alert per deployed service,
 * three on a small install and three hundred on a large one, every one of them
 * saying the same thing about the same cause. The thing that actually happened,
 * that the line went, appears in none of them. Coming back is worse, because
 * they all come back at once and none of it needs acting on.
 *
 * Grouped by person rather than globally: two people answerable for different
 * projects each hear about their own, and neither is handed a list of services
 * they cannot do anything about. Somebody who answers for exactly one of the
 * domains that moved still gets that domain's own sentence and its own link -
 * for them nothing was a storm.
 *
 * Never throws: it runs at the end of the health poller's pass, and a sweep that
 * found something broken must not also break.
 */
export async function notifyDomainHealthChanges(
    changes: readonly DomainHealthChange[]
): Promise<void> {
    if (changes.length === 0) return;
    if (changes.length === 1) {
        await notifyDomainHealthChanged(changes[0]!);
        return;
    }
    try {
        const contexts = await describeDomains(changes.map((change) => change.domainId));

        const perUser = new Map<string, { up: Moved[]; down: Moved[] }>();
        const perProject = new Map<string, { up: Moved[]; down: Moved[] }>();
        for (const change of changes) {
            const context = contexts.get(change.domainId);
            if (!context) continue;
            const moved: Moved = { domainId: change.domainId, context, detail: change.detail };
            const where = change.status === "down" ? "down" : "up";
            for (const userId of context.recipients) {
                const held = perUser.get(userId) ?? { up: [], down: [] };
                held[where].push(moved);
                perUser.set(userId, held);
            }
            const held = perProject.get(context.projectId) ?? { up: [], down: [] };
            held[where].push(moved);
            perProject.set(context.projectId, held);
        }

        // Down first: a pass that took some things down and brought others back
        // says each once, and the one that needs somebody is the one read first.
        for (const [userId, held] of perUser) {
            for (const status of ["down", "up"] as const) {
                const bucket = held[status];
                if (bucket.length === 0) continue;
                const one = bucket.length === 1 ? bucket[0]! : null;
                const { title, body } = domainHealthMessage(
                    status,
                    bucket.map((item) => item.context.label),
                    one?.detail ?? null
                );
                await notify({
                    userId,
                    event: status === "down" ? "domain.down" : "domain.up",
                    title,
                    body,
                    href: one?.context.href ?? SWEEP_HREF,
                    actionRequired: status === "down",
                    metadata: one
                        ? { domainId: one.domainId, status }
                        : { status, domainIds: bucket.map((item) => item.domainId) }
                });
            }
        }

        for (const [projectId, held] of perProject) {
            for (const status of ["down", "up"] as const) {
                const bucket = held[status];
                if (bucket.length === 0) continue;
                const one = bucket.length === 1 ? bucket[0]! : null;
                const { title, body } = domainHealthMessage(
                    status,
                    bucket.map((item) => item.context.label),
                    one?.detail ?? null
                );
                await dispatchProjectWebhooks({
                    projectId,
                    event: status === "down" ? "domain.down" : "domain.up",
                    title,
                    body,
                    url: one?.context.href ?? SWEEP_HREF,
                    level: status === "down" ? "danger" : "success"
                });
            }
        }
    } catch (error) {
        console.error("polaris: could not raise the domain notifications:", error);
    }
}
