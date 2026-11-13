/**
 * Raise an alert on one of the run-as account's topics, as a post to its
 * address would. The account must still hold `alerts.topics` and still manage
 * the topic (its own, or one of an organization it runs) on every run.
 */

import * as core from "@polaris/core";
import { StepError, StepRefusal, type ServerNode } from "../types";

type AlertConfig = ReturnType<(typeof core.CORE_NODE_CONFIGS)["core.alert"]["parse"]>;

export const alertNode: ServerNode<AlertConfig> = {
    type: "core.alert",
    meta: core.CORE_NODE_META["core.alert"],
    config: core.CORE_NODE_CONFIGS["core.alert"],
    run: async (config, _context, io) => {
        const [{ actingUser }, { sessionCan }, topics, { parseAlertJson }] = await Promise.all([
            import("@/lib/mcp/acting-user"),
            import("@/lib/session"),
            import("@/lib/alerts/topics"),
            import("@/lib/alerts/parse")
        ]);
        io.recordInput({ topicId: config.topicId, priority: config.priority });
        const user = await actingUser(io.actor.id);
        if (!user) throw new StepRefusal("runAsGone");
        if (!(await sessionCan(user, "alerts.topics"))) throw new StepRefusal("alertForbidden");
        const topic = await topics.managedTopic(user.id, config.topicId).catch(() => null);
        if (!topic) throw new StepRefusal("alertTopicGone");
        const parsed = parseAlertJson({
            title: config.title,
            message: config.body,
            priority: config.priority,
            tags: config.tags,
            click: config.click,
            dedupKey: config.dedupKey || undefined
        });
        if (!parsed.ok) throw new StepError("alertInvalid");
        const result = await topics.deliverAlert(topic, parsed.alert, "automation");
        return { output: { deliveryId: result.id, recipients: result.recipients } };
    }
};
