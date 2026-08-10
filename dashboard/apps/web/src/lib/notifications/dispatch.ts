/**
 * The one way an alert leaves Polaris.
 *
 * Everything that wants to tell somebody something calls `notify` with a
 * catalogue event. This resolves that account's rule for it, writes the in-app
 * row, and fans out to mail and to whatever destinations the rule names,
 * recording each attempt so the history can say whether the alert actually
 * arrived rather than only that it was raised.
 *
 * Nothing here throws at its caller. An alert is a side effect of the thing that
 * happened, and a deploy must not fail twice because a webhook is down. The
 * fan-out is also not awaited by the caller's critical path beyond the in-app
 * write - see `notify`, which resolves once the record exists.
 */

import { prisma } from "@polaris/db";
import { isViewing } from "./presence";
import { sendSms } from "./sms-service";
import { sendWebhook } from "./webhook-sender";
import { sendAuthEmail } from "@/lib/auth-mail";
import { appBaseUrl } from "@/lib/domain-service";
import { getNotificationPreferences } from "./preferences";
import { createNotification, type NotificationAudience } from "@/lib/notification-service";
import { destinationSummary, recordDestinationResult, resolveDestination } from "./destinations";
import {
    notificationEvent,
    resolveRule,
    type NotificationLevel,
    type NotificationRule,
    type WebhookFormat
} from "@polaris/core";

/** One thing worth telling somebody about. */
export interface NotifyInput {
    userId: string;
    /** A catalogue event id. An id nothing declares is refused. */
    event: string;
    title: string;
    body?: string | null;
    /** In-app path the alert points at, e.g. "/apps/deploy". */
    href?: string | null;
    /** Overrides the catalogue severity when one event covers several outcomes. */
    level?: NotificationLevel;
    audience?: NotificationAudience;
    audienceLabel?: string | null;
    actionRequired?: boolean;
    metadata?: Record<string, unknown> | null;
}

/** Log one attempt. Best effort: a history row is never worth failing over. */
async function record(input: {
    userId: string;
    event: string;
    kind: string;
    destinationId?: string | null;
    destinationHint?: string | null;
    status: "sent" | "failed" | "skipped";
    detail?: string | null;
}): Promise<void> {
    try {
        await prisma.notificationDelivery.create({
            data: {
                userId: input.userId,
                event: input.event,
                kind: input.kind,
                destinationId: input.destinationId ?? null,
                destinationHint: input.destinationHint ?? null,
                status: input.status,
                detail: input.detail ?? null
            }
        });
    } catch {
        // The delivery happened either way; losing its audit line is not fatal.
    }
}

/** The absolute link a webhook or an email points at. */
async function absoluteHref(href: string | null | undefined): Promise<string | null> {
    if (!href) return null;
    if (!href.startsWith("/")) return href;
    try {
        return `${(await appBaseUrl()).replace(/\/+$/, "")}${href}`;
    } catch {
        return null;
    }
}

function emailBody(input: NotifyInput, link: string | null): { text: string; html: string } {
    const lines = [input.title];
    if (input.body) lines.push("", input.body);
    if (link) lines.push("", link);
    const escape = (value: string): string =>
        value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = [
        `<p><strong>${escape(input.title)}</strong></p>`,
        input.body ? `<p>${escape(input.body)}</p>` : "",
        link ? `<p><a href="${escape(link)}">Open in Polaris</a></p>` : ""
    ].join("");
    return { text: lines.join("\n"), html };
}

/** The address account mail goes to: the sign-in address, once it is proved. */
async function mailTarget(userId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, emailVerified: true }
    });
    if (user?.emailVerified) return user.email;
    const alternate = await prisma.userEmail.findFirst({
        where: { userId, verifiedAt: { not: null } },
        orderBy: { createdAt: "asc" },
        select: { email: true }
    });
    return alternate?.email ?? null;
}

async function deliverEmail(input: NotifyInput, level: NotificationLevel): Promise<void> {
    const address = await mailTarget(input.userId);
    if (!address) {
        await record({
            userId: input.userId,
            event: input.event,
            kind: "email",
            status: "skipped",
            detail: "No confirmed address on the account."
        });
        return;
    }
    const link = await absoluteHref(input.href);
    const { text, html } = emailBody(input, link);
    const prefix = level === "danger" ? "[Alert] " : "";
    const result = await sendAuthEmail({ to: address, subject: `${prefix}${input.title}`, text, html });
    await record({
        userId: input.userId,
        event: input.event,
        kind: "email",
        status: result.error ? "failed" : "sent",
        detail: result.error ?? null
    });
}

async function deliverDestination(
    input: NotifyInput,
    level: NotificationLevel,
    destinationId: string
): Promise<void> {
    const destination = await resolveDestination(input.userId, destinationId);
    if (!destination) {
        const summary = await destinationSummary(input.userId, destinationId);
        await record({
            userId: input.userId,
            event: input.event,
            kind: summary?.kind ?? "webhook",
            destinationId,
            destinationHint: summary?.targetHint ?? null,
            status: "skipped",
            detail: "The destination is switched off, deleted, or its target cannot be read."
        });
        return;
    }

    const result =
        destination.kind === "sms"
            ? await sendSms(
                  input.userId,
                  destination.target,
                  input.body ? `${input.title}\n${input.body}` : input.title
              )
            : await sendWebhook(destination.target, (destination.format ?? "generic") as WebhookFormat, {
                  event: input.event,
                  level,
                  title: input.title,
                  body: input.body ?? null,
                  url: await absoluteHref(input.href),
                  at: new Date().toISOString()
              });

    await recordDestinationResult(destination.id, result.error ?? null);
    await record({
        userId: input.userId,
        event: input.event,
        kind: destination.kind,
        destinationId: destination.id,
        destinationHint: destination.targetHint,
        status: result.error ? "failed" : "sent",
        detail: result.error ?? null
    });
}

/** Everything the rule asks for beyond the bell, run together. */
async function fanOut(input: NotifyInput, level: NotificationLevel, rule: NotificationRule): Promise<void> {
    const work: Array<Promise<void>> = [];
    if (rule.email) work.push(deliverEmail(input, level));
    for (const destinationId of rule.destinations) {
        work.push(deliverDestination(input, level, destinationId));
    }
    await Promise.allSettled(work);
}

/**
 * Raise one alert.
 *
 * Resolves once the in-app record is written, because that is the part a caller
 * could reasonably want to have happened before it moves on. Mail, webhooks and
 * texts are handed off and left running: they talk to other people's servers,
 * and none of them is worth holding a deploy or an alarm sweep open for.
 */
export async function notify(input: NotifyInput): Promise<void> {
    const event = notificationEvent(input.event);
    if (!event) {
        console.error(`polaris: refusing to raise undeclared notification event "${input.event}"`);
        return;
    }
    const level = input.level ?? event.level;

    let rule: NotificationRule;
    try {
        rule = resolveRule(await getNotificationPreferences(input.userId), input.event);
    } catch (error) {
        console.error("polaris: could not resolve notification rules:", error);
        rule = { inapp: true, email: false, destinations: [] };
    }

    if (rule.inapp) {
        // Somebody with the page open has already been told by the page. The
        // record still belongs in their history, so it is written and marked
        // read rather than dropped: the bell stays quiet, and the alert is still
        // there to be found afterwards.
        //
        // Never for a critical event. Those are the ones the catalogue keeps on
        // the bell however the account's rules are set, because they are what a
        // break-in looks like - and whoever is holding the session is also
        // whoever would be reporting the page as watched.
        const watching = !event.critical && isViewing(input.userId, input.href);
        await createNotification({
            userId: input.userId,
            type: input.event,
            title: input.title,
            body: input.body ?? null,
            href: input.href ?? null,
            level,
            audience: input.audience,
            audienceLabel: input.audienceLabel,
            actionRequired: input.actionRequired,
            metadata: input.metadata,
            read: watching
        });
        await record({
            userId: input.userId,
            event: input.event,
            kind: "inapp",
            status: "sent",
            detail: watching ? "Marked read: you had the page it points at open." : null
        });
    } else {
        await record({
            userId: input.userId,
            event: input.event,
            kind: "inapp",
            status: "skipped",
            detail: "Turned off for this event."
        });
    }

    void fanOut(input, level, rule).catch((error) => {
        console.error("polaris: notification fan-out failed:", error);
    });
}

/**
 * Send a sample alert to one destination, so somebody adding a webhook or a
 * number finds out it works before an incident does. Returns the provider's
 * reason on failure, which is the whole point of the button.
 */
export async function testDestination(userId: string, destinationId: string): Promise<{ error?: string }> {
    const destination = await resolveDestination(userId, destinationId);
    if (!destination) return { error: "That destination is switched off or no longer exists." };

    const title = "Polaris test alert";
    const body = "If you are reading this, alerts sent here will arrive.";
    const result =
        destination.kind === "sms"
            ? await sendSms(userId, destination.target, `${title}: ${body}`)
            : await sendWebhook(destination.target, (destination.format ?? "generic") as WebhookFormat, {
                  event: "test",
                  level: "info",
                  title,
                  body,
                  url: await absoluteHref("/account/notifications"),
                  at: new Date().toISOString()
              });

    await recordDestinationResult(destination.id, result.error ?? null);
    return result;
}
