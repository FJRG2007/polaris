/**
 * Deploy a service again from an automation, as Redeploy on its page does.
 *
 * The run-as account is asked the same two questions the page asks, on every
 * run: may it manage deployments at all (`deploy.manage`), and may it deploy
 * this service (`deploy.run` on its project). Either answered no refuses the
 * step; a service that is gone fails it.
 *
 * A deploy this step starts is marked as an automation's, and a run that a
 * deploy like that set off may not redeploy again: "deploy finished -> Redeploy"
 * would otherwise deploy forever.
 */

import * as core from "@polaris/core";
import { StepError, StepRefusal, type ServerNode } from "../types";

type RedeployConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.redeploy"]["parse"]>;

/** Whether the run was set off by a deploy that an automation started. */
function causedByAutomationDeploy(trigger: Record<string, unknown>): boolean {
    if (trigger.name !== "deploy.succeeded" && trigger.name !== "deploy.failed") return false;
    const payload = trigger.payload;
    return (
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>).trigger === "automation"
    );
}

export const redeployNode: ServerNode<RedeployConfig> = {
    type: "core.redeploy",
    meta: core.CORE_NODE_META["core.redeploy"],
    config: core.CORE_NODE_CONFIGS["core.redeploy"],
    run: async (config, context, io) => {
        const [{ actingUser }, { sessionCan }, access, deployService, activity] = await Promise.all(
            [
                import("@/lib/mcp/acting-user"),
                import("@/lib/session"),
                import("@/lib/deploy-project-access"),
                import("@/lib/deploy-service"),
                import("@/lib/activity/activity")
            ]
        );
        io.recordInput({ applicationId: config.applicationId });
        if (causedByAutomationDeploy(context.trigger)) throw new StepRefusal("deployLoop");
        const user = await actingUser(io.actor.id);
        if (!user) throw new StepRefusal("runAsGone");
        if (!(await sessionCan(user, "deploy.manage"))) throw new StepRefusal("deployForbidden");
        const exists = await access
            .requireApplicationAccess(config.applicationId, user.id, "project.read")
            .then(
                () => true,
                () => false
            );
        const granted = exists
            ? await access
                  .requireApplicationAccess(config.applicationId, user.id, "deploy.run")
                  .catch(() => null)
            : null;
        if (!exists) throw new StepError("serviceGone");
        if (!granted) throw new StepRefusal("deployForbidden");
        // A service that never got a subdomain gets one, as on its page; one
        // that cannot (no public address yet) still deploys without it.
        await deployService
            .ensureApplicationDomain(config.applicationId, granted.ownerId)
            .catch(() => undefined);
        let deploymentId: string;
        try {
            deploymentId = await deployService.deployApplication(
                config.applicationId,
                granted.ownerId,
                user.id,
                {
                    trigger: "automation",
                    audit: { automationId: io.automationId, runId: io.runId }
                }
            );
        } catch (caught) {
            console.error("polaris: an automation's redeploy did not start:", caught);
            throw new StepError("deployFailed");
        }
        await activity
            .record({
                subjectType: "app",
                subjectId: config.applicationId,
                userId: user.id,
                action: "deployed"
            })
            .catch(() => undefined);
        return { output: { deploymentId, applicationId: config.applicationId } };
    }
};
