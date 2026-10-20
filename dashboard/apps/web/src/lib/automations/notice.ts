/**
 * What an automation's "tell somebody" step does: deliver one message on the
 * channels the step names, and say which of them it reached.
 *
 * The step's output is what the run screen shows, so it is only `sent` when a
 * channel actually took the message. A bell row written already read, an
 * event switched off, a destination held back by quiet hours or a webhook that
 * refused: each is listed under `missed` with the reason, and when nothing got
 * through at all the step fails instead of reporting Done.
 *
 * Shared by core's Notify node and the Places "tell somebody" step, so both
 * offer the same channels and report them the same way.
 */

import { StepError } from "./types";
import * as core from "@polaris/core";

export interface AutomationNotice {
    /** The account the automation runs as: who is told, and whose channels are used. */
    readonly userId: string;
    /** A catalogue event, such as `automations.message`. */
    readonly event: string;
    readonly title: string;
    readonly body: string | null;
    readonly href: string;
    readonly metadata: Record<string, unknown>;
    /** Left out: the bell, plus whatever the account's rule for the event adds. */
    readonly delivery?: core.NoticeDelivery;
}

export type NoticeChannel =
    | "bell"
    | "email"
    | "destination"
    | "chat"
    | "projectWebhook"
    | "messaging";

export interface NoticeMiss {
    readonly channel: NoticeChannel;
    /** A short code the run screen puts into words; never a URL or a secret. */
    readonly reason: string;
}

export interface NoticeResult {
    readonly sent: true;
    readonly delivered: readonly NoticeChannel[];
    readonly missed: readonly NoticeMiss[];
}

/** The delivery log's English reason, as a code. */
function reasonOf(detail: string | null, fallback: string): string {
    if (!detail) return fallback;
    if (/quiet hours/i.test(detail)) return "quietHours";
    if (/no email channel/i.test(detail)) return "noMailChannel";
    if (/no confirmed address/i.test(detail)) return "noAddress";
    if (/switched off, deleted/i.test(detail)) return "destinationGone";
    return fallback;
}

/**
 * Deliver one automation message. Throws `StepError("noticeNotDelivered")`,
 * carrying what was missed, when no channel took it.
 */
export async function deliverAutomationNotice(notice: AutomationNotice): Promise<NoticeResult> {
    const dispatch = await import("@/lib/notifications/dispatch");
    const delivery = notice.delivery ?? core.DEFAULT_NOTICE_DELIVERY;
    const input = {
        userId: notice.userId,
        event: notice.event,
        title: notice.title,
        body: notice.body,
        href: notice.href,
        metadata: notice.metadata,
        // A step that names its channels gets exactly those; one saved before
        // there was a choice keeps the account's rule for the event.
        bellOnly: notice.delivery !== undefined
    };
    const delivered: NoticeChannel[] = [];
    const missed: NoticeMiss[] = [];

    if (delivery.bell) {
        const report = await dispatch.notify(input);
        if (report.inapp === "sent") delivered.push("bell");
        else missed.push({ channel: "bell", reason: `bell.${report.inapp}` });
        delivered.push(...(report.handedOff ?? []));
    }

    const work: Array<Promise<void>> = [];
    /** Run one channel; a throw counts as a miss on that channel, not a failed step. */
    const attempt = (channel: NoticeChannel, task: () => Promise<void>) =>
        work.push(
            task().catch((caught: unknown) => {
                console.error(`polaris: an automation notice could not use ${channel}:`, caught);
                missed.push({ channel, reason: "failed" });
            })
        );
    if (delivery.email) {
        attempt("email", async () => {
            const { getAuthMailStatus } = await import("@/lib/auth-mail");
            if (!(await getAuthMailStatus()).channelId) {
                missed.push({ channel: "email", reason: "noMailChannel" });
                return;
            }
            const outcome = await dispatch.emailNotice(input);
            if (outcome.status === "sent") delivered.push("email");
            else missed.push({ channel: "email", reason: reasonOf(outcome.detail, "failed") });
        });
    }
    for (const destinationId of delivery.destinations) {
        attempt("destination", async () => {
            const outcome = await dispatch.deliverToDestination(input, destinationId);
            if (outcome.status === "sent") delivered.push("destination");
            else
                missed.push({ channel: "destination", reason: reasonOf(outcome.detail, "failed") });
        });
    }
    if (delivery.chat) {
        const chat = delivery.chat;
        attempt("chat", async () => {
            const reason = await postToChat(notice, chat);
            if (reason) missed.push({ channel: "chat", reason });
            else delivered.push("chat");
        });
    }
    for (const webhookId of delivery.projectWebhooks ?? []) {
        attempt("projectWebhook", async () => {
            const reason = await postToProjectWebhook(notice, webhookId);
            if (reason) missed.push({ channel: "projectWebhook", reason });
            else delivered.push("projectWebhook");
        });
    }
    if (delivery.messaging) {
        const messaging = delivery.messaging;
        attempt("messaging", async () => {
            const reason = await sendToMessaging(notice, messaging);
            if (reason) missed.push({ channel: "messaging", reason });
            else delivered.push("messaging");
        });
    }
    await Promise.all(work);

    if (delivered.length === 0) throw new StepError("noticeNotDelivered", { sent: false, missed });
    return { sent: true, delivered, missed };
}

/** Post the message through a channel webhook - never as the person. Null when it went. */
async function postToChat(
    notice: AutomationNotice,
    chat: { webhookId: string; stamp: string }
): Promise<string | null> {
    const webhooks = await import("@/lib/chat/webhooks");
    const chosen = await webhooks.webhookToPostThrough(
        { id: notice.userId },
        chat.webhookId,
        chat.stamp
    );
    if (!chosen.ok) {
        if (chosen.reason === "forbidden") return "webhookForbidden";
        return chosen.reason === "gone" ? "webhookGone" : "webhookReset";
    }
    if (!(await webhooks.webhookPostAllowed(chosen.webhook.id)).ok) return "webhookLimited";
    const content = (notice.body ? `**${notice.title}**\n${notice.body}` : notice.title)
        .slice(0, core.MAX_CHAT_MESSAGE)
        .trim();
    try {
        await webhooks.postThroughWebhook(chosen.webhook, { content });
        return null;
    } catch (caught) {
        console.error("polaris: an automation notice could not post to chat:", caught);
        return "messageRefused";
    }
}

/** Post through a Deploy project's webhook, still the account's to use. Null when it went. */
async function postToProjectWebhook(
    notice: AutomationNotice,
    webhookId: string
): Promise<string | null> {
    const targets = await import("./notice-targets");
    if (!(await targets.mayUseProjectWebhook(notice.userId, webhookId))) {
        const { prisma } = await import("@polaris/db");
        const exists = await prisma.projectWebhook.findUnique({
            where: { id: webhookId },
            select: { id: true }
        });
        return exists ? "webhookForbidden" : "webhookGone";
    }
    const { sendToProjectWebhook } = await import("@/lib/deploy-project-service");
    const reason = await sendToProjectWebhook(webhookId, {
        event: notice.event,
        title: notice.title,
        body: notice.body,
        url: null
    });
    return reason === "gone" ? "webhookGone" : reason;
}

/** Send through a messaging channel the account owns. Null when it went. */
async function sendToMessaging(
    notice: AutomationNotice,
    messaging: { channelId: string; peerId: string }
): Promise<string | null> {
    const targets = await import("./notice-targets");
    if (!(await targets.mayUseMessagingChannel(notice.userId, messaging.channelId)))
        return "webhookGone";
    const { bridgeSend } = await import("@/lib/messaging/bridge-client");
    const text = (notice.body ? `${notice.title}\n${notice.body}` : notice.title).slice(
        0,
        core.AUTOMATION_LIMITS.textLength
    );
    try {
        await bridgeSend(messaging.channelId, { peerId: messaging.peerId, text });
        return null;
    } catch (caught) {
        console.error("polaris: an automation notice could not use a messaging channel:", caught);
        return "messageRefused";
    }
}
