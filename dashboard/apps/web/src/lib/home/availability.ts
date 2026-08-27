/**
 * How long a camera has to be quiet before anybody says so.
 *
 * One rule, in one place, because two of them disagree the moment either moves:
 * the pass that reports an outage and the screens that draw one have to mean the
 * same thing by "not answering", or a tile goes red for a camera nobody has been
 * told about and the reader learns to ignore the colour.
 *
 * Pure and client-safe - the wall, the cameras list and the availability pass
 * all read it.
 */

/**
 * How long a camera has to stay quiet before anybody is told.
 *
 * One missed frame is not an outage. Cameras reboot for a firmware check, a
 * wireless one loses a second of signal, and the relay drops a source it is
 * about to redial - reporting any of those would train whoever gets the alert to
 * ignore it, which costs more than the feature is worth. Two minutes is long
 * enough that everything ordinary has resolved and short enough to still be a
 * useful thing to be told at three in the morning.
 */
export const OFFLINE_GRACE_MS = 2 * 60 * 1000;

/**
 * When a camera stopped answering, once it has been quiet long enough to say so.
 *
 * Null inside the grace window as well as when the camera is answering: the
 * column is written on the first missed frame, which is a moment earlier than
 * anything a reader should be shown. A screen that drew it raw would flash a
 * camera red for one pass every time one reboots.
 */
export function quietSince(offlineSince: string | null, now: number = Date.now()): Date | null {
    if (!offlineSince) return null;
    const since = new Date(offlineSince);
    if (Number.isNaN(since.getTime())) return null;
    return now - since.getTime() >= OFFLINE_GRACE_MS ? since : null;
}
