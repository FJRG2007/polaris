/**
 * The notification catalogue's names in the reader's language.
 *
 * `NOTIFICATION_EVENTS` in @polaris/core is data read on the server too - by
 * dispatch, by the rules - and stays English there. The words are translated
 * where they are drawn, keyed by the event's id (`deploy.failed` is
 * `events.deployFailed`); an event this catalog does not know yet keeps the
 * name core gives it rather than showing a key.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import { NOTIFICATION_GROUP_LABEL, notificationEvent, type NotificationGroup } from "@polaris/core";

type Translate = NamespaceTranslator<"accountNotifications">;

function eventKey(id: string): string {
    return id.replace(/\.(\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** An event's name, or null for one core does not list. */
export function eventLabel(t: Translate, id: string): string | null {
    const key = `events.${eventKey(id)}.label`;
    return t.has(key) ? t(key) : (notificationEvent(id)?.label ?? null);
}

/** What an event is for, in a sentence. */
export function eventDescription(t: Translate, id: string): string {
    const key = `events.${eventKey(id)}.description`;
    return t.has(key) ? t(key) : (notificationEvent(id)?.description ?? "");
}

/** A group's heading. */
export function groupLabel(t: Translate, group: NotificationGroup): string {
    const key = `groups.${group}`;
    return t.has(key) ? t(key) : NOTIFICATION_GROUP_LABEL[group];
}
