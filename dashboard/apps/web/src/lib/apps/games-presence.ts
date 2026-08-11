/**
 * Who is playing, watched once for everybody looking.
 *
 * Reading presence is not free: each server is a command inside its container,
 * and against a machine over SSH that is a round trip per server per read. With
 * every screen polling for itself, two tabs and a phone meant three times that
 * work for the same answer - and the answer still arrived a poll late, because
 * nothing pushed it.
 *
 * So there is one watcher per audience instead. It reads while at least one
 * person is listening, hands each reading to all of them, and stops the moment
 * the last one goes away: a dashboard nobody has open costs nothing, which is
 * what makes it safe to read every few seconds while somebody does.
 *
 * Readings are chained rather than timed - the next one starts when the last has
 * finished - so a slow server stretches the cadence instead of stacking reads on
 * top of each other. Only a change is handed on; an unchanged reading is the
 * common case and nobody needs to be told about it.
 */

import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import { listGameServerPresence, type ServerPresence } from "@/lib/apps/games-service";

/** How long after one reading before the next. Presence is the one thing on these
 *  screens that changes by itself, so it is read at about the rate somebody would
 *  notice - and never faster than the servers can answer. */
const READ_EVERY_MS = 3000;

export interface PresenceReading {
    /** When the servers were asked, so a screen holding a second source can tell
     *  which of the two is older. */
    readonly at: number;
    readonly servers: readonly ServerPresence[];
}

type Listener = (reading: PresenceReading) => void;

interface Watch {
    readonly listeners: Set<Listener>;
    /** The last reading, handed to whoever joins so a new screen paints at once
     *  rather than waiting out a whole cycle. */
    last: PresenceReading | null;
    /** What that reading looked like, for deciding whether anything moved. */
    fingerprint: string;
    timer: ReturnType<typeof setTimeout> | null;
    stopped: boolean;
}

/** One watch per audience: the same owner asked about the same servers. Two people
 *  with different grants see different lists and cannot share a reading. */
const watches = new Map<string, Watch>();

function keyFor(ownerId: string, alsoIds: readonly string[], only: readonly string[] | undefined): string {
    return `${ownerId}|${[...alsoIds].sort().join(",")}|${only ? [...only].sort().join(",") : "*"}`;
}

/**
 * Follow who is playing on this owner's servers. Returns the unsubscribe, which
 * is what eventually stops the reading.
 */
export function subscribeGamePresence(
    ownerId: string,
    alsoIds: readonly string[],
    listener: Listener,
    /** Only these servers. A server's own page watches itself rather than every
     *  server the account has. */
    only?: readonly string[]
): () => void {
    const key = keyFor(ownerId, alsoIds, only);
    const watch: Watch = watches.get(key) ?? {
        listeners: new Set(),
        last: null,
        fingerprint: "",
        timer: null,
        stopped: false
    };
    watches.set(key, watch);
    watch.listeners.add(listener);
    // Whoever arrives late gets what is already known before anything is read.
    if (watch.last) listener(watch.last);
    if (watch.listeners.size === 1) void cycle(key, watch, ownerId, alsoIds, only);

    return () => {
        watch.listeners.delete(listener);
        if (watch.listeners.size > 0) return;
        watch.stopped = true;
        if (watch.timer) clearTimeout(watch.timer);
        watch.timer = null;
        watches.delete(key);
    };
}

async function cycle(
    key: string,
    watch: Watch,
    ownerId: string,
    alsoIds: readonly string[],
    only: readonly string[] | undefined
): Promise<void> {
    if (watch.stopped || watches.get(key) !== watch) return;
    const servers = await listGameServerPresence(ownerId, alsoIds, only).catch(() => null);
    if (watch.stopped || watches.get(key) !== watch) return;
    if (servers) {
        // The schedule is decided from the count this reading already paid for, so
        // a sleeping server stops on time for whoever is watching it, on an
        // instance with no cron configured as much as on one that has it. Silence
        // is passed on as silence: nought would be a server stopped for being
        // quiet when it was only unreachable.
        await sweepGameSchedules(ownerId, new Date(), {
            // Narrowed to what was actually read: a sweep over the rest would have
            // to ask each of those servers who is on it, which is the cost this
            // whole file exists to avoid paying more than once.
            ...(only ? { only } : {}),
            known: new Map(servers.map((server) => [server.id, server.answering ? server.online : null]))
        }).catch(() => undefined);
        const fingerprint = JSON.stringify(servers);
        const reading: PresenceReading = { at: Date.now(), servers };
        watch.last = reading;
        if (fingerprint !== watch.fingerprint) {
            watch.fingerprint = fingerprint;
            for (const listener of watch.listeners) {
                try {
                    listener(reading);
                } catch {
                    // A listener that throws is a connection already going away.
                }
            }
        }
    }
    if (watch.stopped || watches.get(key) !== watch) return;
    watch.timer = setTimeout(() => void cycle(key, watch, ownerId, alsoIds, only), READ_EVERY_MS);
    watch.timer.unref?.();
}
