/**
 * The node types core contributes that need nothing but Polaris itself:
 * the triggers, If, Choose, At the same time, Wait, Notify, Post to a chat
 * channel, Answer and Announce. HTTP and the chat presets live in
 * `http-node.ts`; the nodes that steer the run itself (Join, loops, Stop, Wait
 * for an event, Run another automation) are listed here with their config and
 * run by the engine.
 */

import * as core from "@polaris/core";
import { StepError, StepRefusal, type ServerNode } from "../types";

const C = core.CORE_NODE_CONFIGS;

type Declared =
    | "core.manual"
    | "core.schedule"
    | "core.webhook"
    | "core.called"
    | "core.onEvent"
    | "core.failed"
    | "core.join"
    | "core.forEach"
    | "core.repeat"
    | "core.stop"
    | "core.waitEvent"
    | "core.run"
    | "core.try"
    | "core.waitCondition";

/** A node with no work of its own here: a trigger (its step is written when the run starts) or one the engine runs. */
function declared(type: Declared): ServerNode {
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

const switchNode: ServerNode<core.SwitchConfig> = {
    type: "core.switch",
    meta: core.CORE_NODE_META["core.switch"],
    config: C["core.switch"],
    run: async (config, context) => {
        const ports = core.switchPorts(config);
        const fallback = config.fallback ? "otherwise" : "";
        if (config.kind === "rules") {
            const held = config.cases
                .map((entry, index) => (core.checkCondition(entry.condition, context) ? index : -1))
                .filter((index) => index >= 0);
            const taken = config.every ? held : held.slice(0, 1);
            return {
                output: { matched: taken.map((index) => index + 1) },
                port: taken.length ? taken.map((index) => ports[index]!).join(",") : fallback
            };
        }
        const fold = (value: string) => (config.ignoreCase ? value.toLowerCase() : value);
        const value = fold(core.interpolate(config.value, context).trim());
        const index = config.cases.findIndex(
            (entry) => fold(core.interpolate(entry.equals, context).trim()) === value
        );
        return {
            output: { matched: index >= 0 ? [index + 1] : [] },
            port: index >= 0 ? ports[index]! : fallback
        };
    }
};

type ParallelConfig = ReturnType<(typeof C)["core.parallel"]["parse"]>;

const parallelNode: ServerNode<ParallelConfig> = {
    type: "core.parallel",
    meta: core.CORE_NODE_META["core.parallel"],
    config: C["core.parallel"],
    run: async (config) => ({
        output: { lanes: config.lanes },
        port: core.parallelPorts(config).join(",")
    })
};

type Pairs = { name: string; value: string }[];

function pairValues(pairs: Pairs, context: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const pair of pairs) out[pair.name] = core.referenceValue(pair.value, context) ?? null;
    return out;
}

const answerNode: ServerNode<{ outputs: Pairs }> = {
    type: "core.answer",
    meta: core.CORE_NODE_META["core.answer"],
    config: C["core.answer"],
    run: async (config, context) => {
        const outputs = pairValues(config.outputs, context);
        if (core.byteLength(JSON.stringify(outputs)) > core.AUTOMATION_LIMITS.eventPayloadBytes)
            throw new StepError("answerTooLarge");
        return { output: { outputs } };
    }
};

const setNode: ServerNode<{ values: Pairs }> = {
    type: "core.set",
    meta: core.CORE_NODE_META["core.set"],
    config: C["core.set"],
    run: async (config, context) => {
        const values = pairValues(config.values, context);
        if (core.byteLength(JSON.stringify(values)) > core.AUTOMATION_LIMITS.stepDataBytes)
            throw new StepError("valuesTooLarge");
        return { output: { values } };
    }
};

type AnnounceConfig = ReturnType<(typeof C)["core.announce"]["parse"]>;

const announceNode: ServerNode<AnnounceConfig> = {
    type: "core.announce",
    meta: core.CORE_NODE_META["core.announce"],
    config: C["core.announce"],
    run: async (config, context, io) => {
        const { prisma } = await import("@polaris/db");
        const { emitAutomationEvent } = await import("../outbox");
        const payload = pairValues(config.payload, context);
        io.recordInput({ name: config.name, payload });
        // Run again after a crash, the same step finds the event it already announced.
        const before = await prisma.automationEvent.findFirst({
            where: { type: "core.event", dedupeKey: io.idempotencyKey },
            select: { id: true }
        });
        if (before) return { output: { name: config.name, eventId: before.id } };
        if (io.depth + 1 > core.AUTOMATION_LIMITS.depth) throw new StepRefusal("loop");
        const recent = await prisma.automationEvent.count({
            where: {
                type: "core.event",
                orgId: io.shelf.orgId,
                ...(io.shelf.orgId ? {} : { userId: io.shelf.userId }),
                createdAt: { gte: new Date(Date.now() - core.RATE_WINDOW_MS) }
            }
        });
        if (recent >= core.AUTOMATION_LIMITS.announceRate) throw new StepError("announceLimited");
        const eventId = await emitAutomationEvent("core.event", {
            orgId: io.shelf.orgId,
            userId: io.shelf.userId,
            subjectKey: config.name,
            payload: { name: config.name, payload },
            dedupeKey: io.idempotencyKey,
            depth: io.depth + 1,
            originRunId: io.runId
        });
        if (!eventId) throw new StepError("announceFailed");
        return { output: { name: config.name, eventId } };
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
            return {
                wait: {
                    until: new Date(now.getTime() + core.durationSeconds(config.duration) * 1000)
                }
            };
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
        const body = core
            .interpolate(config.body, context)
            .slice(0, core.AUTOMATION_LIMITS.textLength);
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

type MessageConfig = ReturnType<(typeof C)["core.message"]["parse"]>;

/**
 * Post into a space channel through one of its webhooks.
 *
 * The message carries the webhook's name and the bot tag, the way a CI run or
 * a monitor posting to the webhook's address would: an automation never
 * speaks as a person, and has no way into a direct message or a group. Which
 * webhook, and whether the account the automation runs as still runs its
 * channel, is asked again on every run - a webhook deleted or given a new
 * secret since, or a channel its owner no longer runs, stops the run with the
 * reason instead of posting.
 */
const messageNode: ServerNode<MessageConfig> = {
    type: "core.message",
    meta: core.CORE_NODE_META["core.message"],
    config: C["core.message"],
    run: async (config, context, io) => {
        const webhooks = await import("@/lib/chat/webhooks");
        const { ChatAccessError } = await import("@/lib/chat/access");
        const body = core.interpolate(config.body, context).slice(0, core.MAX_CHAT_MESSAGE).trim();
        io.recordInput({ webhookId: config.webhookId, body });
        if (!body) throw new StepError("messageEmpty");
        const chosen = await webhooks.webhookToPostThrough(
            io.actor,
            config.webhookId,
            config.stamp
        );
        if (!chosen.ok) {
            if (chosen.reason === "forbidden") throw new StepRefusal("webhookForbidden");
            throw new StepError(chosen.reason === "gone" ? "webhookGone" : "webhookReset");
        }
        if (!(await webhooks.webhookPostAllowed(chosen.webhook.id)).ok)
            throw new StepError("webhookLimited");
        try {
            const messageId = await webhooks.postThroughWebhook(chosen.webhook, { content: body });
            return { output: { messageId, channelId: chosen.webhook.channelId } };
        } catch (caught) {
            if (caught instanceof ChatAccessError) throw new StepError("messageRefused");
            throw caught;
        }
    }
};

export const CORE_SERVER_NODES: readonly ServerNode[] = [
    declared("core.manual"),
    declared("core.schedule"),
    declared("core.webhook"),
    declared("core.called"),
    declared("core.onEvent"),
    declared("core.failed"),
    ifNode as ServerNode,
    switchNode as ServerNode,
    parallelNode as ServerNode,
    declared("core.join"),
    declared("core.forEach"),
    declared("core.repeat"),
    declared("core.stop"),
    waitNode as ServerNode,
    declared("core.waitEvent"),
    declared("core.run"),
    declared("core.try"),
    declared("core.waitCondition"),
    notifyNode as ServerNode,
    answerNode as ServerNode,
    setNode as ServerNode,
    announceNode as ServerNode,
    messageNode as ServerNode
];
