/**
 * A machine's alarm history as spans of time: when each alarm went off and when
 * it cleared. Uptime Kuma and Netdata both draw a monitor's past this way - a
 * strip of days shaded by how long it was down, over a list of the incidents -
 * so this turns Watch's alarm events into the spans the downtime heatmap reads.
 *
 * Pure and client-safe: the Places device screens draw from it, and so does the
 * test.
 */

import type { OutageSpan } from "@/lib/connectivity/outages";

/** One alarm event, oldest first, as the server sends it. */
export interface AlarmEventPoint {
    readonly alarmId: string;
    readonly alarmName: string;
    readonly kind: string;
    readonly at: number;
}

/** One time an alarm was firing. `endedAt` is null while it still is. */
export interface AlarmEpisode {
    readonly alarmId: string;
    readonly alarmName: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
}

/**
 * Pair each alarm's `triggered` with the `resolved` after it. A resolve whose
 * trigger is older than the window starts at the window, since that is all the
 * events say; a second trigger with no resolve between is the same episode.
 * Newest first, because the table is read from the top.
 */
export function episodesFrom(events: readonly AlarmEventPoint[], since: number): AlarmEpisode[] {
    const open = new Map<string, AlarmEpisode>();
    const done: AlarmEpisode[] = [];
    for (const event of [...events].sort((left, right) => left.at - right.at)) {
        const started = open.get(event.alarmId);
        if (event.kind === "triggered") {
            if (!started) {
                open.set(event.alarmId, {
                    alarmId: event.alarmId,
                    alarmName: event.alarmName,
                    startedAt: event.at,
                    endedAt: null
                });
            }
        } else if (event.kind === "resolved") {
            done.push({
                alarmId: event.alarmId,
                alarmName: event.alarmName,
                startedAt: started?.startedAt ?? since,
                endedAt: event.at
            });
            open.delete(event.alarmId);
        }
    }
    return [...done, ...open.values()].sort((left, right) => right.startedAt - left.startedAt);
}

/**
 * The episodes as one set of spans, overlaps joined, so two alarms firing over
 * the same hour shade the day for an hour and not for two.
 */
export function mergedSpans(episodes: readonly AlarmEpisode[], now: number): OutageSpan[] {
    const sorted = [...episodes].sort((left, right) => left.startedAt - right.startedAt);
    const spans: { startedAt: number; endedAt: number | null; lastSeenAt: number }[] = [];
    for (const episode of sorted) {
        const end = episode.endedAt ?? now;
        const last = spans[spans.length - 1];
        if (last && episode.startedAt <= (last.endedAt ?? now)) {
            const reach = Math.max(last.endedAt ?? now, end);
            last.endedAt = last.endedAt === null || episode.endedAt === null ? null : reach;
            last.lastSeenAt = reach;
            continue;
        }
        spans.push({ startedAt: episode.startedAt, endedAt: episode.endedAt, lastSeenAt: end });
    }
    return spans;
}
