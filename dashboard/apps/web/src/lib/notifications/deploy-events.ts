/**
 * Telling somebody how a deploy went.
 *
 * Both outcomes go through the same call so the two are never described
 * differently, and both are raised from the one place a deploy can finish
 * (executeDeployment) rather than from each caller - a failure that only alerts
 * when it happens to be an application, or only on the manual path, is the exact
 * gap this exists to close.
 *
 * The owner is always told. Whoever pressed deploy is told as well when that is
 * somebody else, because they are the one standing in front of the screen; each
 * of them gets it routed by their own rules.
 */

import { prisma } from "@polaris/db";
import { notify } from "./dispatch";

/** What was being deployed, in words, plus where to look at it. */
interface Deployable {
    label: string;
    href: string;
}

async function describeDeployable(type: string, id: string): Promise<Deployable | null> {
    if (type === "application") {
        const app = await prisma.application.findUnique({
            where: { id },
            select: { name: true, environment: { select: { project: { select: { id: true, name: true } } } } }
        });
        if (!app) return null;
        const project = app.environment.project;
        return { label: `${project.name} / ${app.name}`, href: `/apps/deploy/${project.id}` };
    }
    if (type === "database") {
        const database = await prisma.managedDatabase.findUnique({
            where: { id },
            select: { name: true, environment: { select: { project: { select: { id: true, name: true } } } } }
        });
        if (!database) return null;
        const project = database.environment.project;
        return { label: `${project.name} / ${database.name}`, href: `/apps/deploy/${project.id}` };
    }
    return null;
}

/** The failure reason, trimmed to something a phone or a chat card can carry.
 *  The full log is a click away, and the first line is nearly always the cause. */
function summarize(error: string | null): string {
    const first = (error ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    if (!first) return "No reason was reported. Open the deploy log for the detail.";
    return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

/**
 * Raise the alert for a finished deploy. Never throws: it runs inside the
 * deploy's own completion path, and a deploy that already failed must not also
 * fail to record itself.
 */
export async function notifyDeployFinished(input: {
    deploymentId: string;
    ownerId: string;
    ok: boolean;
}): Promise<void> {
    try {
        const deployment = await prisma.deployment.findUnique({
            where: { id: input.deploymentId },
            select: {
                deployableType: true,
                deployableId: true,
                error: true,
                commitSha: true,
                triggeredById: true
            }
        });
        if (!deployment) return;

        const deployable = await describeDeployable(deployment.deployableType, deployment.deployableId);
        if (!deployable) return;

        const event = input.ok ? "deploy.succeeded" : "deploy.failed";
        const title = input.ok ? `Deployed ${deployable.label}` : `Deploy failed: ${deployable.label}`;
        const body = input.ok
            ? `${deployable.label} is serving the new release.`
            : summarize(deployment.error);

        // The owner, plus whoever triggered it when that is somebody else - each
        // by their own rules, so one person's muted webhook does not silence the
        // other's.
        const recipients = new Set([input.ownerId]);
        if (deployment.triggeredById) recipients.add(deployment.triggeredById);

        for (const userId of recipients) {
            await notify({
                userId,
                event,
                title,
                body,
                href: deployable.href,
                actionRequired: !input.ok,
                metadata: {
                    deploymentId: input.deploymentId,
                    deployableType: deployment.deployableType,
                    deployableId: deployment.deployableId,
                    commitSha: deployment.commitSha
                }
            });
        }
    } catch (error) {
        console.error("polaris: could not raise the deploy notification:", error);
    }
}
