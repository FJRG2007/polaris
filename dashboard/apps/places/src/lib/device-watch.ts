/**
 * Keeping the devices fresh while somebody is looking at them.
 *
 * The browser used to do this: every open devices screen asked every account
 * again on a half-minute timer, so two tabs were two calls to each account, and
 * nothing changed on the screen until the timer came round. Now the server reads
 * - once per account however many screens are open - and pushes what changed to
 * all of them (`device-live`). It is Home Assistant's split: integrations poll
 * on the backend through one coordinator, and the frontend only ever subscribes.
 *
 * Paced per account, by how it is reached. Something on the same network
 * answers in milliseconds and costs nobody anything, so it is read every ten
 * seconds; a cloud account is somebody else's quota and keeps the half minute
 * the screen used; SwitchBot's is ten thousand calls a day for everything, so
 * once a minute. An account that fails is read less and less often - doubling up
 * to five minutes - until it answers again, and an account any other path just
 * read (an automation, the button, a press) is not read again until it is due.
 *
 * None of this wakes a device: it is the same quiet read the timer made. The
 * button that does wake them is still the person's to press.
 *
 * Runs only while a stream that may sync is open; the last one closing stops
 * it. Server-only.
 */

import * as accounts from "./device-accounts";
import { deviceConnection } from "./device-connections";

const SECOND = 1000;

/** A unit on the same network. */
export const LOCAL_POLL_MS = 10 * SECOND;
/** Somebody else's servers: the cadence the screen itself used. */
export const CLOUD_POLL_MS = 30 * SECOND;
/** The ceiling a failing account backs off to. */
export const MAX_BACKOFF_MS = 5 * 60 * SECOND;

/** Accounts whose quota is too small for the cloud cadence. SwitchBot allows
 *  10,000 calls a day per account, across every device on it. */
const SLOW_CONNECTIONS: Readonly<Record<string, number>> = {
    "switchbot-cloud": 60 * SECOND
};

/** Units that wedge when they are asked too often are read at the cloud
 *  cadence even on the same network: a Philips unit's network processor serves
 *  one request at a time. */
const CAREFUL_CONNECTIONS = new Set(["philips-coap", "philips-dynalite"]);

/** How often one account is read while somebody is watching. */
export function pollInterval(connection: string): number {
    const slow = SLOW_CONNECTIONS[connection];
    if (slow) return slow;
    if (CAREFUL_CONNECTIONS.has(connection)) return CLOUD_POLL_MS;
    return deviceConnection(connection)?.reach === "same-network" ? LOCAL_POLL_MS : CLOUD_POLL_MS;
}

/** How long to wait after `failures` failures in a row. */
export function backoff(interval: number, failures: number): number {
    if (failures <= 0) return interval;
    return Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 10));
}

/**
 * The accounts due a read now, and how long until the next one is.
 *
 * Pure, so the pacing can be asserted without a clock: `lastSyncedAt` is when
 * anything last read the account, `failures` is this watcher's own count.
 */
export function dueAccounts(
    list: readonly Pick<accounts.DeviceAccountView, "id" | "connection" | "lastSyncedAt">[],
    failures: ReadonlyMap<string, { count: number; at: number }>,
    now: number
): { due: string[]; nextInMs: number } {
    const due: string[] = [];
    let nextInMs = MAX_BACKOFF_MS;
    for (const account of list) {
        if (!accounts.isConnectable(account.connection)) continue;
        const interval = pollInterval(account.connection);
        const failed = failures.get(account.id);
        const last = Math.max(
            account.lastSyncedAt ? Date.parse(account.lastSyncedAt) || 0 : 0,
            failed?.at ?? 0
        );
        const wait = backoff(interval, failed?.count ?? 0) - (now - last);
        if (wait <= 0) {
            due.push(account.id);
            nextInMs = Math.min(nextInMs, interval);
        } else {
            nextInMs = Math.min(nextInMs, wait);
        }
    }
    return { due, nextInMs: Math.max(SECOND, nextInMs) };
}

interface Watch {
    viewers: number;
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    failures: Map<string, { count: number; at: number }>;
}

const REGISTRY = Symbol.for("polaris.places.devices.watch");

function watches(): Map<string, Watch> {
    const holder = globalThis as unknown as Record<symbol, Map<string, Watch> | undefined>;
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}

async function tick(installedAppId: string, watch: Watch): Promise<void> {
    watch.timer = null;
    if (watch.viewers <= 0) return;
    watch.running = true;
    let nextInMs = CLOUD_POLL_MS;
    try {
        const list = await accounts.listAccounts(installedAppId);
        const now = Date.now();
        const plan = dueAccounts(list, watch.failures, now);
        if (plan.due.length > 0) {
            // Loaded when needed: `devices` publishes through `device-live`, and
            // the stream route that starts this loads both.
            const devices = await import("./devices");
            const outcome = await devices.syncDevices(installedAppId, {
                probe: false,
                only: plan.due
            });
            const failed = new Set(outcome.failed);
            for (const id of plan.due) {
                if (failed.has(id)) {
                    const count = (watch.failures.get(id)?.count ?? 0) + 1;
                    watch.failures.set(id, { count, at: Date.now() });
                } else {
                    watch.failures.delete(id);
                }
            }
            // Planned again as of now, so a fast account is not held to the pace
            // of the slow one read beside it. What was just read counts as read
            // now; what failed is paced by its failure.
            const readAt = new Date().toISOString();
            const after = list.map((account) =>
                plan.due.includes(account.id) && !failed.has(account.id)
                    ? { ...account, lastSyncedAt: readAt }
                    : account
            );
            nextInMs = dueAccounts(after, watch.failures, Date.now()).nextInMs;
        } else {
            nextInMs = plan.nextInMs;
        }
    } catch (error) {
        console.error("places: the devices could not be read for an open screen:", error);
        nextInMs = MAX_BACKOFF_MS / 5;
    } finally {
        watch.running = false;
    }
    schedule(installedAppId, watch, nextInMs);
}

function schedule(installedAppId: string, watch: Watch, delayMs: number): void {
    if (watch.viewers <= 0 || watch.timer || watch.running) return;
    watch.timer = setTimeout(() => void tick(installedAppId, watch), delayMs);
    watch.timer.unref?.();
}

/**
 * Keep an install's devices fresh for as long as the returned release has not
 * been called. Any number of screens share one loop.
 */
export function watchDevices(installedAppId: string): () => void {
    const all = watches();
    let watch = all.get(installedAppId);
    if (!watch) {
        watch = { viewers: 0, timer: null, running: false, failures: new Map() };
        all.set(installedAppId, watch);
    }
    watch.viewers += 1;
    // The first screen is read for at once, where an account is due: it was
    // drawn from the last stored read, and the sooner that is confirmed the
    // sooner anything stale on it is put right.
    schedule(installedAppId, watch, 0);
    let released = false;
    const held = watch;
    return () => {
        if (released) return;
        released = true;
        held.viewers -= 1;
        if (held.viewers > 0) return;
        if (held.timer) clearTimeout(held.timer);
        held.timer = null;
        held.failures.clear();
    };
}
