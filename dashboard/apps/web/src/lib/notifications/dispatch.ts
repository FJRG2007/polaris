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
import { queueOutboundHooks } from "./outbound-hooks";
import { sendAuthEmail } from "@/lib/auth-mail";
import { appBaseUrl } from "@/lib/domain-service";
import { wordsFor } from "./notice-words";
import { getNotificationHolds, getNotificationPreferences, getQuietHours } from "./preferences";
import {
    createNotification,
    raiseCondition,
    type NotificationAudience
} from "@/lib/notification-service";
import { destinationSummary, recordDestinationResult, resolveDestination } from "./destinations";
import {
    clearsMinLevel,
    heldByQuietHours,
    holdReason,
    notificationEvent,
    resolveRule,
    type NotificationLevel,
    type NotificationRule,
    type WebhookFormat
} from "@polaris/core";
import { recipientShelf } from "@/lib/workspace-scope";
import { deliveryText } from "./delivery-words";

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
    /**
     * The shelf the work this is about sits on: the organization that owns the
     * task, project or mailbox, or null for somebody's own. Left out for an
     * alert about the account or the instance, which every shelf shows. Given,
     * the bell counts it only while that shelf is open - so a company's deploy
     * failing is not a number on somebody's personal shelf that opening Deploy
     * there cannot explain.
     */
    shelf?: { readonly orgId: string | null };
    /**
     * Write the bell row and nothing else the account's rule names (its email
     * and destinations). For a caller that was told exactly where to deliver,
     * such as an automation step with its own channels, and delivers the rest
     * itself through `emailNotice` and `deliverToDestination`.
     */
    bellOnly?: boolean;
    /**
     * The ongoing condition this alert is about, for a checker that runs on a
     * clock. The first raise is an ordinary alert; while the condition holds,
     * every later one rewrites that same notice in place and goes nowhere else -
     * no second row, no mail, no webhook. End it with `resolveCondition`.
     */
    condition?: string;
    /** With `condition`: put a rewritten notice back to unread (it got worse). */
    resurface?: boolean;
}

/** What one attempt came to, as the delivery log recorded it. */
export interface DeliveryOutcome {
    status: "sent" | "failed" | "skipped";
    detail: string | null;
}

/**
 * What became of the bell row. `read`: written, but already marked read because
 * the page it points at was open; `off`: the account turned this event off;
 * `refused`: the event is not in the catalogue, so nothing was written;
 * `updated`: a condition already open, whose notice was rewritten in place.
 */
export interface NotifyReport {
    inapp: "sent" | "read" | "off" | "refused" | "updated";
    /**
     * The channels of the account's rule the alert was handed to in the
     * background (never with `bellOnly`). Left out when there were none.
     */
    handedOff?: ReadonlyArray<"email" | "destination">;
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

async function deliverEmail(
    input: NotifyInput,
    level: NotificationLevel
): Promise<DeliveryOutcome> {
    const address = await mailTarget(input.userId);
    if (!address) {
        const outcome: DeliveryOutcome = {
            status: "skipped",
            detail: "No confirmed address on the account."
        };
        await record({ userId: input.userId, event: input.event, kind: "email", ...outcome });
        return outcome;
    }
    const link = await absoluteHref(input.href);
    const { text, html } = emailBody(input, link);
    const prefix = level === "danger" ? "[Alert] " : "";
    const result = await sendAuthEmail({
        to: address,
        subject: `${prefix}${input.title}`,
        text,
        html
    });
    const outcome: DeliveryOutcome = {
        status: result.error ? "failed" : "sent",
        detail: result.error ?? null
    };
    await record({ userId: input.userId, event: input.event, kind: "email", ...outcome });
    return outcome;
}

async function deliverDestination(
    input: NotifyInput,
    level: NotificationLevel,
    destinationId: string,
    critical: boolean
): Promise<DeliveryOutcome> {
    const destination = await resolveDestination(input.userId, destinationId);
    if (!destination) {
        const summary = await destinationSummary(input.userId, destinationId);
        const outcome: DeliveryOutcome = {
            status: "skipped",
            detail: "The destination is switched off, deleted, or its target cannot be read."
        };
        await record({
            userId: input.userId,
            event: input.event,
            kind: summary?.kind ?? "webhook",
            destinationId,
            destinationHint: summary?.targetHint ?? null,
            ...outcome
        });
        return outcome;
    }

    if (!clearsMinLevel(level, destination.minLevel, critical)) {
        const outcome: DeliveryOutcome = { status: "skipped", detail: QUIET_SEVERITY };
        await record({
            userId: input.userId,
            event: input.event,
            kind: destination.kind,
            destinationId: destination.id,
            destinationHint: destination.targetHint,
            ...outcome
        });
        return outcome;
    }

    const result =
        destination.kind === "sms"
            ? await sendSms(
                  input.userId,
                  destination.target,
                  input.body ? `${input.title}\n${input.body}` : input.title
              )
            : await sendWebhook(
                  destination.target,
                  (destination.format ?? "generic") as WebhookFormat,
                  {
                      openLabel: (await wordsFor(input.userId, "notices"))(
                          "delivery.openInPolaris"
                      ),
                      event: input.event,
                      level,
                      title: input.title,
                      body: input.body ?? null,
                      url: await absoluteHref(input.href),
                      at: new Date().toISOString()
                  }
              );

    await recordDestinationResult(destination.id, result.error ?? null);
    const outcome: DeliveryOutcome = {
        status: result.error ? "failed" : "sent",
        detail: result.error ?? null
    };
    await record({
        userId: input.userId,
        event: input.event,
        kind: destination.kind,
        destinationId: destination.id,
        destinationHint: destination.targetHint,
        ...outcome
    });
    return outcome;
}

/** The delivery log's reasons for an alert held back on purpose. Matched back
 *  to the reader's words by delivery-words. */
export const QUIET_SEVERITY = "Below the lowest severity set for this destination.";
export const QUIET_HOURS = "Held back: it arrived during your quiet hours.";

export const MUTED = "Held back: you muted it.";
export const OUTSIDE_SCHEDULE = "Held back: outside the hours you set for it.";
/** The bell's line for a held alert: kept, without a sound or a badge. */
export const RECORDED_QUIETLY =
    "Recorded without a sound or badge: it is muted or outside its hours.";

/**
 * Why this alert is held back now, as the delivery log's reason, or null to send
 * it. The one place every channel asks: a mute or the event's schedule first,
 * then quiet hours, all read on the account's own clock. Unreadable settings
 * never hold anything back: a missed alert costs more than an untimely one.
 */
async function heldNow(userId: string, eventId: string, critical: boolean): Promise<string | null> {
    try {
        // Loaded here rather than at the top: it reads the deployment's settings
        // on import, and most alerts never need a clock at all.
        const { resolveDisplayPreferencesFor } = await import("@/lib/display-prefs-service");
        const [holds, quiet, display] = await Promise.all([
            // A mute that cannot be read must not switch quiet hours off too.
            Promise.resolve()
                .then(() => getNotificationHolds(userId))
                .catch(() => null),
            getQuietHours(userId),
            resolveDisplayPreferencesFor(userId)
        ]);
        const now = new Date();
        const reason = holds ? holdReason(holds, eventId, now, display.timeZone) : null;
        if (reason === "muted") return MUTED;
        if (reason === "schedule") return OUTSIDE_SCHEDULE;
        return heldByQuietHours(quiet, now, display.timeZone, critical) ? QUIET_HOURS : null;
    } catch {
        return null;
    }
}

/** Everything the rule asks for beyond the bell, run together. */
async function fanOut(
    input: NotifyInput,
    level: NotificationLevel,
    rule: NotificationRule,
    critical: boolean,
    held: string | null
): Promise<void> {
    if (held && (rule.email || rule.destinations.length > 0)) {
        const skipped: Array<Promise<void>> = [];
        if (rule.email) {
            skipped.push(
                record({
                    userId: input.userId,
                    event: input.event,
                    kind: "email",
                    status: "skipped",
                    detail: held
                })
            );
        }
        for (const destinationId of rule.destinations) {
            skipped.push(
                destinationSummary(input.userId, destinationId).then((summary) =>
                    record({
                        userId: input.userId,
                        event: input.event,
                        kind: summary?.kind ?? "webhook",
                        destinationId,
                        destinationHint: summary?.targetHint ?? null,
                        status: "skipped",
                        detail: held
                    })
                )
            );
        }
        await Promise.allSettled(skipped);
        return;
    }
    const work: Array<Promise<unknown>> = [];
    if (rule.email) work.push(deliverEmail(input, level));
    for (const destinationId of rule.destinations) {
        work.push(deliverDestination(input, level, destinationId, critical));
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
export async function notify(input: NotifyInput): Promise<NotifyReport> {
    const event = notificationEvent(input.event);
    if (!event) {
        console.error(`polaris: refusing to raise undeclared notification event "${input.event}"`);
        return { inapp: "refused" };
    }
    const level = input.level ?? event.level;

    let rule: NotificationRule;
    try {
        rule = resolveRule(await getNotificationPreferences(input.userId), input.event);
    } catch (error) {
        console.error("polaris: could not resolve notification rules:", error);
        rule = { inapp: event.offBell !== true, email: false, destinations: [] };
    }

    // Asked once, before the bell is written: a muted or out-of-hours alert is
    // still recorded, read, so it rings nothing and badges nothing - Slack's
    // behaviour. Quiet hours leave the bell alone, as they always have.
    const held = await heldNow(input.userId, input.event, event.critical === true);
    const silenced = held === MUTED || held === OUTSIDE_SCHEDULE;

    let watching = false;
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
        //
        // Nor for one the page does not show (`unreadWhenViewing`): an
        // automation's message links to the automation, and somebody pressing
        // Test in its editor is looking at the editor, not at the message.
        watching =
            !event.critical && !event.unreadWhenViewing && isViewing(input.userId, input.href);
        const row = {
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
            shelf: await recipientShelf(input.userId, input.shelf).catch(() => null),
            read: watching || silenced
        };
        if (input.condition) {
            // Still the same condition: the open notice now says the latest, and
            // that is all. Telling every channel again is the spam this prevents.
            const outcome = await raiseCondition(input.condition, row, {
                resurface: input.resurface
            });
            if (outcome === "updated") return { inapp: "updated" };
        } else {
            await createNotification(row);
        }
        await record({
            userId: input.userId,
            event: input.event,
            kind: "inapp",
            status: "sent",
            detail: watching
                ? "Marked read: you had the page it points at open."
                : silenced
                  ? RECORDED_QUIETLY
                  : null
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

    const extras = input.bellOnly ? { ...rule, email: false, destinations: [] } : rule;
    void fanOut(input, level, extras, event.critical === true, held).catch((error) => {
        console.error("polaris: notification fan-out failed:", error);
    });

    // The account's signed webhooks choose their own events, so they follow
    // neither the rule above nor quiet hours: a program does not sleep.
    void (async () =>
        queueOutboundHooks(input.userId, {
            event: input.event,
            level,
            title: input.title,
            body: input.body ?? null,
            url: await absoluteHref(input.href),
            at: new Date().toISOString()
        }))().catch((error) => {
        console.error("polaris: queueing signed webhooks failed:", error);
    });

    const handedOff: Array<"email" | "destination"> = [];
    if (extras.email) handedOff.push("email");
    if (extras.destinations.length > 0) handedOff.push("destination");
    const inapp = !rule.inapp ? "off" : watching || silenced ? "read" : "sent";
    return handedOff.length > 0 ? { inapp, handedOff } : { inapp };
}

/**
 * Email one alert to the account's confirmed address now, recorded in the
 * delivery log like the rule's own email, and held back by a mute, a schedule or
 * quiet hours as that one is. For a caller that names its channels (see `bellOnly`).
 */
export async function emailNotice(input: NotifyInput): Promise<DeliveryOutcome> {
    const event = notificationEvent(input.event);
    if (!event) return { status: "skipped", detail: "Undeclared event." };
    const held = await heldNow(input.userId, input.event, event.critical === true);
    if (held) {
        const outcome: DeliveryOutcome = { status: "skipped", detail: held };
        await record({ userId: input.userId, event: input.event, kind: "email", ...outcome });
        return outcome;
    }
    return deliverEmail(input, input.level ?? event.level);
}

/**
 * Send one alert to one of the account's own destinations now. The caller
 * chose it by name, so its lowest-severity setting does not hold it back;
 * a mute, a schedule and quiet hours still do.
 */
export async function deliverToDestination(
    input: NotifyInput,
    destinationId: string
): Promise<DeliveryOutcome> {
    const event = notificationEvent(input.event);
    if (!event) return { status: "skipped", detail: "Undeclared event." };
    const held = await heldNow(input.userId, input.event, event.critical === true);
    if (held) {
        const summary = await destinationSummary(input.userId, destinationId);
        const outcome: DeliveryOutcome = { status: "skipped", detail: held };
        await record({
            userId: input.userId,
            event: input.event,
            kind: summary?.kind ?? "webhook",
            destinationId,
            destinationHint: summary?.targetHint ?? null,
            ...outcome
        });
        return outcome;
    }
    return deliverDestination(input, input.level ?? event.level, destinationId, true);
}

/**
 * Send a sample alert to one destination, so somebody adding a webhook or a
 * number finds out it works before an incident does. Returns the provider's
 * reason on failure, which is the whole point of the button.
 */
export async function testDestination(
    userId: string,
    destinationId: string
): Promise<{ error?: string }> {
    const destination = await resolveDestination(userId, destinationId);
    const t = await wordsFor(userId, "notices");
    if (!destination) return { error: t("test.gone") };

    const title = t("test.title");
    const body = t("test.body");
    const result =
        destination.kind === "sms"
            ? await sendSms(userId, destination.target, `${title}: ${body}`)
            : await sendWebhook(
                  destination.target,
                  (destination.format ?? "generic") as WebhookFormat,
                  {
                      openLabel: t("delivery.openInPolaris"),
                      event: "test",
                      level: "info",
                      title,
                      body,
                      url: await absoluteHref("/account/notifications"),
                      at: new Date().toISOString()
                  }
              );

    await recordDestinationResult(destination.id, result.error ?? null);
    return result.error
        ? { error: deliveryText(await wordsFor(userId, "components"), result.error) }
        : result;
}
