/**
 * Saying what the line did: one bell notification per event to the people who
 * can act on the connection, each under its own catalogue entry so a reader can
 * mute any of them in their notification settings, and one automation event, so
 * "Internet comes back" and the rest can start whatever somebody built on them.
 *
 * The sampler raises each event once (it runs under a lease and the transition
 * lives in its stored state); the automation event also carries a dedupe key, so
 * a pass that died after announcing and is run again starts nothing twice.
 *
 * Server-only.
 */

import { formatSpan } from "./outages";
import { translatorFor } from "@/lib/i18n/translate";
import type { ConnectivityEvent } from "./line-samples";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { emitAutomationEvent } from "@/lib/automations/outbox";
import { DEFAULT_LOCALE, type Permission } from "@polaris/core";
import { notifyOperators } from "@/lib/notifications/operators";

/** Who hears about the line: the people the "cannot reach the internet" alert goes to. */
const PERMISSION: Permission = "system.manage";
const HREF = "/watch/connectivity";

/** The automation event type behind the "connectivity" triggers. */
export const CONNECTIVITY_EVENT_TYPE = "core.connectivity";

/** The notification catalogue entry of each event. */
export const CONNECTIVITY_NOTICES = {
    down: "network.internetDown",
    up: "network.internetBack",
    ipChanged: "network.publicIp",
    unreachable: "network.unreachable"
} as const;

type Words = (t: NamespaceTranslator<"notices">) => { title: string; body: string };

function spanOf(seconds: number, t: NamespaceTranslator<"notices">): string {
    return formatSpan(seconds * 1000, (form, values) => t(`span.${form}`, values));
}

/** The event as an automation sees it: "up" also says how long, in words. */
export function automationPayload(event: ConnectivityEvent): Record<string, unknown> {
    if (event.event !== "up") return event;
    return {
        ...event,
        duration: spanOf(event.durationSeconds, translatorFor(DEFAULT_LOCALE, "notices"))
    };
}

function wordsOf(event: ConnectivityEvent): Words {
    switch (event.event) {
        case "down":
            return (t) => ({
                title: t("connectivity.downTitle"),
                body: t(event.kind === "dns" ? "connectivity.downBodyDns" : "connectivity.downBody")
            });
        case "up":
            return (t) => ({
                title: t("connectivity.backTitle"),
                body: t("connectivity.backBody", { duration: spanOf(event.durationSeconds, t) })
            });
        case "ipChanged":
            return (t) => ({
                title: t("connectivity.ipTitle"),
                body: t("connectivity.ipBody", { previous: event.previous, current: event.current })
            });
        case "unreachable":
            return (t) => ({
                title: t("connectivity.unreachableTitle"),
                body: t("connectivity.unreachableBody")
            });
    }
}

/** A key that is the same for the same event, however often it is announced. */
export function eventKey(event: ConnectivityEvent): string {
    switch (event.event) {
        case "down":
            return `down:${event.since}`;
        case "up":
            return `up:${event.since}`;
        case "ipChanged":
            return `ip:${event.current}:${event.at}`;
        case "unreachable":
            return `unreachable:${event.at}`;
    }
}

export async function announceConnectivity(event: ConnectivityEvent): Promise<void> {
    const say = wordsOf(event);
    const fallback = say(translatorFor(DEFAULT_LOCALE, "notices"));
    await Promise.all([
        notifyOperators({
            permission: PERMISSION,
            event: CONNECTIVITY_NOTICES[event.event],
            title: fallback.title,
            body: fallback.body,
            say,
            href: HREF,
            level: event.event === "up" ? "success" : "warning",
            actionRequired: event.event === "unreachable",
            metadata: { connectivity: event }
        }).catch((error: unknown) =>
            console.error("polaris: a connectivity notification failed:", error)
        ),
        emitAutomationEvent(CONNECTIVITY_EVENT_TYPE, {
            subjectKey: event.event,
            payload: automationPayload(event),
            dedupeKey: `connectivity:${eventKey(event)}`
        })
    ]);
}
