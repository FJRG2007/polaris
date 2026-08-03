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
import { dispatchProjectWebhooks } from "../deploy-project-service";

/** Where a domain sits, in words, plus who is answerable for it. */
interface DomainContext {
    label: string;
    href: string;
    projectId: string;
    recipients: string[];
}

/** The project owner and its admins, deduped. Viewers and developers are left out:
 *  this is an alert about something being broken, addressed to whoever can undo it. */
async function answerableFor(projectId: string, ownerId: string): Promise<string[]> {
    const admins = await prisma.projectMember.findMany({
        where: { projectId, role: "admin" },
        select: { userId: true }
    });
    return [...new Set([ownerId, ...admins.map((member) => member.userId)])];
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
                    environment: { select: { project: { select: { id: true, name: true, ownerId: true } } } }
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
        const title = down ? `Domain not serving: ${context.label}` : `Domain serving again: ${context.label}`;
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
