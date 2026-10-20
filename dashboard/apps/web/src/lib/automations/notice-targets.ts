/**
 * The notify-step targets that used to be Watch's own: a Deploy project's
 * webhooks (the endpoints listed under Watch > Webhooks) and a connected
 * messaging channel with the peer an alarm told. The rows stay where they are -
 * a step names them by id - so nothing is copied and nothing has to move back.
 *
 * Who may use one is the same standing as managing it: `deploy.manage` and the
 * project's settings for a project webhook, owning the channel for a messaging
 * channel. Checked when a graph is saved and published, and again on every send.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { userHasPermission } from "@polaris/auth";
import { AutomationAccessError } from "./access-error";

/** At most this many project webhooks are offered to pick from. */
const MAX_CHOICES = 50;

/** Rows of the channel table that are not a chat platform an alarm can message. */
const NOT_MESSAGING = [core.EMAIL_PLATFORM, core.SMS_PLATFORM];

export interface ProjectWebhookChoice {
    readonly id: string;
    readonly name: string;
    readonly projectName: string;
    readonly targetHint: string;
    readonly enabled: boolean;
}

export interface MessagingChannelChoice {
    readonly id: string;
    readonly name: string;
    readonly platform: string;
}

/** Whether this account may post through this project webhook. */
export async function mayUseProjectWebhook(userId: string, webhookId: string): Promise<boolean> {
    const hook = await prisma.projectWebhook.findUnique({
        where: { id: webhookId },
        select: { projectId: true }
    });
    if (!hook) return false;
    if (!(await userHasPermission(userId, "deploy.manage"))) return false;
    const { projectAccess, accessCan } = await import("@/lib/deploy-project-access");
    const access = await projectAccess(hook.projectId, userId);
    return access !== null && accessCan(access, "project.settings");
}

/** Whether this account owns this messaging channel. */
export async function mayUseMessagingChannel(userId: string, channelId: string): Promise<boolean> {
    const channel = await prisma.channel.findFirst({
        where: { id: channelId, ownerId: userId, platform: { notIn: NOT_MESSAGING } },
        select: { id: true }
    });
    return channel !== null;
}

/** The project webhooks this account could pick: on projects it runs. */
export async function projectWebhooksToPostThrough(
    userId: string
): Promise<readonly ProjectWebhookChoice[]> {
    if (!(await userHasPermission(userId, "deploy.manage"))) return [];
    const { managedProjectWhere } = await import("@/lib/deploy-project-access");
    const rows = await prisma.projectWebhook.findMany({
        where: { project: await managedProjectWhere(userId) },
        orderBy: { createdAt: "asc" },
        take: MAX_CHOICES,
        select: {
            id: true,
            name: true,
            targetHint: true,
            enabled: true,
            project: { select: { name: true } }
        }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        projectName: row.project.name,
        targetHint: row.targetHint,
        enabled: row.enabled
    }));
}

/** The messaging channels this account owns. */
export async function messagingChannelsToPostThrough(
    userId: string
): Promise<readonly MessagingChannelChoice[]> {
    return prisma.channel.findMany({
        where: { ownerId: userId, platform: { notIn: NOT_MESSAGING } },
        orderBy: { createdAt: "asc" },
        take: MAX_CHOICES,
        select: { id: true, name: true, platform: true }
    });
}

/** Every delivery the graph's notify steps name, as `kind:id` entries. */
function chosenTargets(graph: unknown): Set<string> {
    const parsed = core.automationGraphSchema.safeParse(graph);
    const found = new Set<string>();
    if (!parsed.success) return found;
    for (const node of parsed.data.nodes) {
        if (node.type !== "core.notify") continue;
        const config = core.CORE_NODE_CONFIGS["core.notify"].safeParse(node.config);
        const delivery = config.success ? config.data.delivery : undefined;
        if (!delivery) continue;
        for (const id of delivery.projectWebhooks) found.add(`project:${id}`);
        if (delivery.messaging) found.add(`messaging:${delivery.messaging.channelId}`);
    }
    return found;
}

/**
 * Every project webhook and messaging channel the graph's notify steps name
 * must be one the actor may use. `already` is the graph being replaced: a
 * target it already named passes unasked, as with chat webhooks
 * (`chat-webhooks.ts`), so somebody else editing does not lose a step its owner
 * set up. Each send asks again.
 */
export async function checkNoticeTargets(
    actor: RunActor,
    graph: core.AutomationGraph,
    already?: unknown
): Promise<void> {
    const kept = already === undefined ? new Set<string>() : chosenTargets(already);
    for (const entry of chosenTargets(graph)) {
        if (kept.has(entry)) continue;
        const [kind, id] = entry.split(":") as [string, string];
        const allowed =
            kind === "project"
                ? await mayUseProjectWebhook(actor.id, id)
                : await mayUseMessagingChannel(actor.id, id);
        if (!allowed) throw new AutomationAccessError("webhookUnavailable");
    }
}
