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

/**
 * The project owner and everybody its access entries let point a hostname
 * somewhere, deduped. Whoever can only read is left out: this is an alert about
 * something being broken, addressed to whoever can undo it, and paging people
 * who cannot teaches everyone to ignore it.
 *
 * A team or an organization holding the capability is expanded to its people -
 * an alert nobody is named on is an alert nobody reads.
 */
async function answerableFor(projectId: string, ownerId: string): Promise<string[]> {
    const entries = await prisma.projectMember.findMany({
        where: {
            projectId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        select: {
            capabilities: true,
            userId: true,
            team: { select: { members: { select: { userId: true } } } },
            org: { select: { ownerId: true, members: { select: { userId: true } } } }
        }
    });
    const recipients = new Set<string>([ownerId]);
    for (const entry of entries) {
        if (!parseProjectCapabilities(entry.capabilities).includes("domains.manage")) continue;
        if (entry.userId) recipients.add(entry.userId);
        for (const member of entry.team?.members ?? []) recipients.add(member.userId);
        if (entry.org) {
            recipients.add(entry.org.ownerId);
            for (const member of entry.org.members) recipients.add(member.userId);
        }
    }
    return [...recipients];
}

async function describeDomain(domainId: string): Promise<DomainContext | null> {
    const domain = await prisma.domain.findUnique({
        where: { id: domainId },
        select: {
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
    if (!domain) return null;
    const app = domain.application;
    const project = app.environment.project;
    return {
        // The service as well as the hostname: an operator reading this on a phone
        // should not have to look up which of their services the name belongs to.
        label: `${domain.hostname} (${project.name} / ${app.name})`,
        href: `/apps/deploy/${project.id}?service=${app.id}`,
        projectId: project.id,
        recipients: await answerableFor(project.id, project.ownerId)
    };
}

/**
 * Raise the alert for a domain that changed reachability. Never throws: it runs inside
 * the health poller, and a probe that found something broken must not also break.
 *
 * `detail` is the probe's own reason ("HTTP 502", "Timed out"), which is the difference
 * between an alert somebody can act on and one that only says something is wrong.
 */
export async function notifyDomainHealthChanged(input: {
    domainId: string;
    status: "up" | "down";
    detail: string | null;
}): Promise<void> {
    try {
        const context = await describeDomain(input.domainId);
        if (!context) return;

        const down = input.status === "down";
        const event = down ? "domain.down" : "domain.up";
        const title = down
            ? `Domain not serving: ${context.label}`
            : `Domain serving again: ${context.label}`;
        const body = down
            ? `${input.detail ?? "It stopped answering"}. The service itself may still be running - check the domain's route and the port it points at.`
            : "It is answering again.";

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
