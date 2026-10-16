/**
 * The node types core contributes that need nothing but Polaris itself:
 * the three triggers, If, Wait and Notify. HTTP and the chat presets live in
 * `http-node.ts`.
 */

import * as core from "@polaris/core";
import type { ServerNode } from "../types";

const C = core.CORE_NODE_CONFIGS;

function trigger(type: "core.manual" | "core.schedule" | "core.webhook"): ServerNode {
    return { type, meta: core.CORE_NODE_META[type], config: C[type] };
}

const ifNode: ServerNode<core.ConditionGroup> = {
    type: "core.if",
    meta: core.CORE_NODE_META["core.if"],
    config: C["core.if"].transform((config) => config.condition),
    run: async (condition, context) => {
        const matched = core.checkCondition(condition, context);
        return { output: { matched }, port: matched ? "then" : "else" };
    }
};

type WaitConfig = ReturnType<(typeof C)["core.wait"]["parse"]>;

const waitNode: ServerNode<WaitConfig> = {
    type: "core.wait",
    meta: core.CORE_NODE_META["core.wait"],
    config: C["core.wait"],
    run: async (config, _context, io) => {
        const now = new Date();
        if (config.kind === "duration") {
            io.recordInput({ seconds: core.durationSeconds(config.duration) });
            return { wait: { until: new Date(now.getTime() + core.durationSeconds(config.duration) * 1000) } };
        }
        const until = core.nextDailyDue([config.time], config.days, now, io.timeZone);
        io.recordInput({ time: config.time, days: config.days, timeZone: io.timeZone });
        if (!until) return { output: { waitedUntil: null } };
        return { wait: { until } };
    }
};

type NotifyConfig = ReturnType<(typeof C)["core.notify"]["parse"]>;

const notifyNode: ServerNode<NotifyConfig> = {
    type: "core.notify",
    meta: core.CORE_NODE_META["core.notify"],
    config: C["core.notify"],
    run: async (config, context, io) => {
        const { notify } = await import("@/lib/notifications/dispatch");
        const title = core.interpolate(config.title, context).slice(0, 200);
        const body = core.interpolate(config.body, context).slice(0, core.AUTOMATION_LIMITS.textLength);
        io.recordInput({ title, body });
        await notify({
            userId: io.actor.id,
            event: "automations.message",
            title,
            body: body || null,
            href: `/automations/${io.automationId}`,
            metadata: { automationId: io.automationId, runId: io.runId }
        });
        return { output: { sent: true } };
    }
};

export const CORE_SERVER_NODES: readonly ServerNode[] = [
    trigger("core.manual"),
    trigger("core.schedule"),
    trigger("core.webhook"),
    ifNode as ServerNode,
    waitNode as ServerNode,
    notifyNode as ServerNode
];
