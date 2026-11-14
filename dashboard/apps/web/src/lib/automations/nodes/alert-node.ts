/**
 * The alert steps.
 *
 * "Send an alert" posts to another automation's alert address, as a system
 * posting to it would: that automation runs. The run-as account must still hold
 * `alerts.topics` and still be allowed to edit that automation on every run.
 *
 * "Notify about the alert" tells people about one, graded by its severity: the
 * same `alerts.*` notification events alert topics raised, so quiet hours, muted
 * severities and push to devices behave as they did.
 */

import * as core from "@polaris/core";
import { StepError, StepRefusal, type ServerNode } from "../types";

type AlertConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.alert"]["parse"]>;
type NotifyConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.alertNotify"]["parse"]>;

export const alertNode: ServerNode<AlertConfig> = {
    type: "core.alert",
    meta: core.CORE_NODE_META["core.alert"],
    config: core.CORE_NODE_CONFIGS["core.alert"],
    run: async (config, context, io) => {
        const [{ actingUser }, { sessionCan }, addresses, { parseAlertJson }, { load }] = await Promise.all([
            import("@/lib/mcp/acting-user"),
            import("@/lib/session"),
            import("@/lib/alerts/addresses"),
            import("@/lib/alerts/parse"),
            import("../service")
        ]);
        const title = core.interpolate(config.title, context);
        const body = core.interpolate(config.body, context);
        io.recordInput({ topicId: config.topicId, priority: config.priority, title, body });
        const user = await actingUser(io.actor.id);
        if (!user) throw new StepRefusal("runAsGone");
        if (!(await sessionCan(user, "alerts.topics"))) throw new StepRefusal("alertForbidden");
        const address = await addresses.addressById(config.topicId);
        const editable = address ? await load(io.actor, address.automationId, true).then(() => true, () => false) : false;
        if (!address || !editable) throw new StepRefusal("alertTopicGone");
        const parsed = parseAlertJson({
            title,
            message: body,
            priority: config.priority,
            tags: core.interpolate(config.tags, context),
            click: core.interpolate(config.click, context),
            dedupKey: core.interpolate(config.dedupKey, context) || undefined
        });
        if (!parsed.ok) throw new StepError("alertInvalid");
        const fired = await addresses.fireAlert(address, parsed.alert, "automation", io.depth + 1);
        if (!fired.ok) throw new StepError("alertTopicOff");
        return { output: { started: true } };
    }
};

export const alertNotifyNode: ServerNode<NotifyConfig> = {
    type: "core.alertNotify",
    meta: core.CORE_NODE_META["core.alertNotify"],
    config: core.CORE_NODE_CONFIGS["core.alertNotify"],
    run: async (config, context, io) => {
        const [{ prisma }, { notify }, addresses] = await Promise.all([
            import("@polaris/db"),
            import("@/lib/notifications/dispatch"),
            import("@/lib/alerts/addresses")
        ]);
        const priority: core.AlertPriority = core.alertPriority(core.interpolate(config.priority, context)) ?? 3;
        const automation = await prisma.automation.findUnique({
            where: { id: io.automationId },
            select: { name: true }
        });
        const name = automation?.name ?? "";
        const title = (core.interpolate(config.title, context).trim() || name).slice(0, core.ALERT_LIMITS.title);
        const body = core.interpolate(config.body, context).slice(0, 1000);
        const dedupKey = core.interpolate(config.dedupKey, context).trim().slice(0, core.ALERT_LIMITS.dedupKey);
        const click = core.interpolate(config.click, context).trim();
        io.recordInput({ title, body, priority, dedupKey: dedupKey || null });
        const recipients = await addresses.alertRecipients({
            runAsId: io.actor.id,
            orgId: io.shelf.orgId,
            recipientUserIds: config.recipientUserIds,
            recipientTeamIds: config.recipientTeamIds
        });
        const pushing = priority > 1 && priority >= config.pushFrom;
        const fold = dedupKey ? `alert:${io.automationId}:${dedupKey}` : undefined;
        await Promise.all(
            recipients.map((userId) =>
                notify({
                    userId,
                    event: core.alertEventId(priority),
                    title,
                    body,
                    href: `/automations/runs/${io.runId}`,
                    level: addresses.levelOf(priority),
                    shelf: { orgId: io.shelf.orgId },
                    audienceLabel: name,
                    // A sender's dedup key folds its repeats into the row already on
                    // the bell for an hour; without one every alert is its own.
                    dedupKey: fold,
                    metadata: { automationId: io.automationId, runId: io.runId, priority, click: click || undefined },
                    push: pushing ? { tag: fold ?? `alert:${io.runId}`, requireInteraction: priority === 5 } : undefined
                }).catch(() => null)
            )
        );
        return { output: { recipients: recipients.length, priority } };
    }
};
