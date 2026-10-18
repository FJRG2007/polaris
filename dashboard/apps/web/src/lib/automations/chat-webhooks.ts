/**
 * The chat webhooks an automation posts through, checked when it is saved and
 * published. Each run asks again (`core.message` in `nodes/core-nodes.ts`).
 */

import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { AutomationAccessError } from "./access-error";

/** The webhook and secret each "Post to a chat channel" step names, as `id:stamp`. */
function chosenWebhooks(graph: unknown): Set<string> {
    const parsed = core.automationGraphSchema.safeParse(graph);
    const found = new Set<string>();
    if (!parsed.success) return found;
    for (const node of parsed.data.nodes) {
        if (node.type !== "core.message") continue;
        const config = core.CORE_NODE_CONFIGS["core.message"].safeParse(node.config);
        if (config.success) found.add(`${config.data.webhookId}:${config.data.stamp}`);
    }
    return found;
}

/**
 * Every chat webhook the graph posts through must be one the actor runs the
 * channel of, the same standing as managing it in the channel's settings.
 * `already` is the graph being replaced: a webhook it already named passes
 * unasked, so somebody else editing the automation does not lose a step its
 * owner set up. Publishing passes no `already`, since the publisher is who the
 * automation runs as from then on. Each run asks again.
 */
export async function checkChatWebhooks(
    actor: RunActor,
    graph: core.AutomationGraph,
    already?: unknown
): Promise<void> {
    const kept = already === undefined ? new Set<string>() : chosenWebhooks(already);
    const fresh = [...chosenWebhooks(graph)].filter((entry) => !kept.has(entry));
    if (fresh.length === 0) return;
    // Loaded here rather than at the top, as the run does, so the automation
    // service does not pull chat in with it.
    const { webhookToPostThrough } = await import("@/lib/chat/webhooks");
    for (const entry of fresh) {
        const [webhookId, stamp] = entry.split(":") as [string, string];
        const answer = await webhookToPostThrough(actor, webhookId, stamp);
        if (!answer.ok) throw new AutomationAccessError("webhookUnavailable");
    }
}
