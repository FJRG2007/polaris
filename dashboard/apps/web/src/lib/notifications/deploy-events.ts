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

import { notify } from "./dispatch";
import { prisma } from "@polaris/db";
import * as follow from "../follow/follow";
import { dispatchProjectWebhooks } from "../deploy-project-service";

/** What was being deployed, in words, plus where to look at it. */
interface Deployable {
    label: string;
    href: string;
    /** The project it belongs to, so its own webhooks hear about it too. */
    projectId: string;
}

async function describeDeployable(type: string, id: string): Promise<Deployable | null> {
    if (type === "application") {
        const app = await prisma.application.findUnique({
            where: { id },
            select: { name: true, environment: { select: { project: { select: { id: true, name: true } } } } }
        });
        if (!app) return null;
        const project = app.environment.project;
        // The service, not just the project it lives in: an alert about one deploy
        // that lands on a project of a dozen services leaves the reader to find it.
        return {
            label: `${project.name} / ${app.name}`,
            href: `/apps/deploy/${project.id}?service=${id}`,
            projectId: project.id
        };
    }
    if (type === "database") {
        const database = await prisma.managedDatabase.findUnique({
            where: { id },
            select: { name: true, environment: { select: { id: true, project: { select: { id: true, name: true } } } } }
        });
        if (!database) return null;
        const project = database.environment.project;
        // A database has no panel of its own, so the environment holding it is as
        // close as a link gets - still better than defaulting to production.
        return {
            label: `${project.name} / ${database.name}`,
            href: `/apps/deploy/${project.id}?env=${database.environment.id}`,
            projectId: project.id
        };
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

        // The owner, plus whoever triggered it when that is somebody else, plus
        // anybody following the service - each by their own rules, so one
        // person's muted webhook does not silence the other's.
        //
        // The followers are why this exists as more than the owner's alert: the
        // person who spent the afternoon on a service, or who asked to be told
        // when it came back up, is not necessarily either of the first two.
        const recipients = new Set([input.ownerId]);
        if (deployment.triggeredById) recipients.add(deployment.triggeredById);
        if (deployment.deployableType === "application") {
            for (const userId of await follow.followers("app", deployment.deployableId)) {
                recipients.add(userId);
            }
        }

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

        // The project's own endpoints, alongside the people. These belong to the
        // project rather than to anyone's account, so they keep reporting when
        // whoever added them is gone - which is the point of having them.
        await dispatchProjectWebhooks({
            projectId: deployable.projectId,
            event,
            title,
            body,
            url: deployable.href,
            level: input.ok ? "success" : "danger"
        });
    } catch (error) {
        console.error("polaris: could not raise the deploy notification:", error);
    }
}
