/**
 * Keeping the devices fresh, whether or not anybody is looking at them.
 *
 * The browser used to do this: every open devices screen asked every account
 * again on a half-minute timer, so two tabs were two calls to each account, and
 * nothing changed on the screen until the timer came round. Then the server read
 * - once per account however many screens were open - and pushed what changed
 * to all of them (`device-live`), but only while a screen was open: with nobody
 * looking, nothing was read, and an assistant asking about the front door was
 * told what the last open screen had seen, hours ago.
 *
 * So this is Home Assistant's DataUpdateCoordinator now. Every install with a
 * device account is read in the background from boot (`startDeviceCoordinator`),
 * at its own pace; an open screen only makes it faster. Right after a command
 * the account is read again a few times (`requestFollowUps`, HA's
 * `async_request_refresh`), stopping as soon as the device has stopped moving,
 * and a reader that cannot wait for the next turn can ask for one now
 * (`refreshAccounts`). Every read goes through the one path, shared while it is
 * in flight, so a follow-up, the timer and an assistant asking at the same
 * moment are one call to the account.
 *
 * Paced per account, by how it is reached. Something on the same network
 * answers in milliseconds and costs nobody anything, so it is read every ten
 * seconds; a cloud account is somebody else's quota and keeps the half minute
 * the screen used; SwitchBot's is ten thousand calls a day for everything, so
 * once a minute. With no screen open each of those is doubled - SwitchBot then
 * costs 720 calls a day, a fraction of its quota. An account that fails is read
 * less and less often - doubling up to five minutes - until it answers again, and
 * an account any other path just read (an automation, the button, a press) is
 * not read again until it is due.
 *
 * None of this wakes a device: it is the same quiet read the timer made. The
 * button that does wake them is still the person's to press.
 *
 * Server-only.
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
/** How much slower an account is read while no screen is open. */
export const UNWATCHED_FACTOR = 2;
/** When an account is read again after a command, counted from the command. */
export const FOLLOW_UP_MS: readonly number[] = [2 * SECOND, 6 * SECOND, 15 * SECOND];
/** How often the coordinator looks for installs that gained or lost accounts. */
export const DISCOVER_MS = 5 * 60 * SECOND;

/** Accounts whose quota is too small for the cloud cadence. SwitchBot allows
 *  10,000 calls a day per account, across every device on it. */
const SLOW_CONNECTIONS: Readonly<Record<string, number>> = {
    "switchbot-cloud": 60 * SECOND
};

/** Units that wedge when they are asked too often are read at the cloud
 *  cadence even on the same network: a Philips unit's network processor serves
 *  one request at a time. */
const CAREFUL_CONNECTIONS = new Set(["philips-coap", "philips-dynalite"]);

/** How often one account is read: at the screen's pace while somebody is
 *  watching, and `UNWATCHED_FACTOR` times slower while nobody is. */
export function pollInterval(connection: string, watched = true): number {
    const slow = SLOW_CONNECTIONS[connection];
    const base =
        slow ??
        (CAREFUL_CONNECTIONS.has(connection)
            ? CLOUD_POLL_MS
            : deviceConnection(connection)?.reach === "same-network"
              ? LOCAL_POLL_MS
              : CLOUD_POLL_MS);
    return watched ? base : base * UNWATCHED_FACTOR;
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
 * anything last read the account, `failures` is the coordinator's own count.
 * `followUps` is when each account is next to be read again after a command:
 * that read is due at its time however recently the account was read, and is
 * held back only by a failing account's backoff.
 */
export function dueAccounts(
    list: readonly Pick<accounts.DeviceAccountView, "id" | "connection" | "lastSyncedAt">[],
    failures: ReadonlyMap<string, { count: number; at: number }>,
    now: number,
    options: { watched?: boolean; followUps?: ReadonlyMap<string, number> } = {}
): { due: string[]; nextInMs: number } {
    const watched = options.watched ?? true;
    const due: string[] = [];
    let nextInMs = MAX_BACKOFF_MS;
    for (const account of list) {
        if (!accounts.isConnectable(account.connection)) continue;
        const interval = pollInterval(account.connection, watched);
        const failed = failures.get(account.id);
        const last = Math.max(
            account.lastSyncedAt ? Date.parse(account.lastSyncedAt) || 0 : 0,
            failed?.at ?? 0
        );
        let wait = backoff(interval, failed?.count ?? 0) - (now - last);
        const followUp = options.followUps?.get(account.id);
        if (followUp !== undefined) {
            const held = failed ? backoff(interval, failed.count) - (now - failed.at) : 0;
            wait = Math.min(wait, Math.max(followUp - now, held));
        }
        if (wait <= 0) {
            due.push(account.id);
            nextInMs = Math.min(nextInMs, interval);
        } else {
            nextInMs = Math.min(nextInMs, wait);
        }
    }
    return { due, nextInMs: Math.max(SECOND, nextInMs) };
}

// ---------------------------------------------------------------------------
// Reading an account, once however many ask
// ---------------------------------------------------------------------------

interface Shared {
    /** Reads in flight, by account. */
    readonly inflight: Map<string, Promise<boolean>>;
    /** When each account last finished a read that worked. */
    readonly readAt: Map<string, number>;
    /** Waiting for an account's next read. */
    readonly waiters: Set<{ accountId: string; after: number; done: (read: boolean) => void }>;
}

const SHARED = Symbol.for("polaris.places.devices.reads");

function shared(): Shared {
    const holder = globalThis as unknown as Record<symbol, Shared | undefined>;
    holder[SHARED] ??= { inflight: new Map(), readAt: new Map(), waiters: new Set() };
    return holder[SHARED];
}

/**
 * Read these accounts now, through the one sync path (`syncDevices`, quietly -
 * never a probe). An account already being read is not read twice: the caller
 * waits for the read in flight. Answers the accounts that failed.
 */
export async function readAccounts(
    installedAppId: string,
    accountIds: readonly string[]
): Promise<string[]> {
    const { inflight, readAt, waiters } = shared();
    const waiting = new Map<string, Promise<boolean>>();
    const fresh: string[] = [];
    for (const id of new Set(accountIds)) {
        const running = inflight.get(id);
        if (running) waiting.set(id, running);
        else fresh.push(id);
    }
    if (fresh.length > 0) {
        // Loaded when needed: `devices` publishes through `device-live`, and
        // reaches this module itself after a command.
        const read = import("./devices").then((devices) =>
            devices.syncDevices(installedAppId, { probe: false, only: fresh })
        );
        for (const id of fresh) {
            const one = read.then(
                (outcome) => !outcome.failed.includes(id),
                () => false
            );
            inflight.set(id, one);
            void one.then((worked) => {
                inflight.delete(id);
                if (!worked) return;
                const at = Date.now();
                readAt.set(id, at);
                for (const waiter of [...waiters]) {
                    if (waiter.accountId === id && at > waiter.after) waiter.done(true);
                }
            });
            waiting.set(id, one);
        }
    }
    const failed: string[] = [];
    for (const [id, read] of waiting) if (!(await read)) failed.push(id);
    return failed;
}

/**
 * Resolve once an account has been read successfully after `after` (epoch
 * ms), or with false when `timeoutMs` passes first.
 */
export function waitForRead(accountId: string, after: number, timeoutMs: number): Promise<boolean> {
    const { readAt, waiters } = shared();
    if ((readAt.get(accountId) ?? 0) > after) return Promise.resolve(true);
    return new Promise((resolve) => {
        const waiter = {
            accountId,
            after,
            done: (read: boolean) => {
                clearTimeout(timer);
                waiters.delete(waiter);
                resolve(read);
            }
        };
        const timer = setTimeout(() => waiter.done(false), Math.max(0, timeoutMs));
        timer.unref?.();
        waiters.add(waiter);
    });
}

/**
 * Read these accounts now for a reader that cannot wait for the next turn,
 * within `timeoutMs`. "read" when every one of them answered in time,
 * "timeout" when the time ran out first (the reads carry on and land for the
 * next reader), "failed" when one refused.
 */
export async function refreshAccounts(
    installedAppId: string,
    accountIds: readonly string[],
    timeoutMs: number
): Promise<"read" | "timeout" | "failed"> {
    if (accountIds.length === 0) return "read";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
    });
    const reading = readAccounts(installedAppId, accountIds).then(
        (failed) => (failed.length > 0 ? ("failed" as const) : ("read" as const)),
        () => "failed" as const
    );
    try {
        return await Promise.race([reading, late]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ---------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------

interface FollowUp {
    /** When to read the account again, soonest first. */
    times: number[];
    /** The devices commanded, read after each pass to see whether they have
     *  stopped moving. */
    devices: Set<string>;
}

interface Watch {
    /** Open screens. */
    viewers: number;
    /** Kept read by the coordinator, whether or not anybody is looking. */
    background: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    /** When the timer fires, for bringing it forward. */
    dueAt: number;
    running: boolean;
    failures: Map<string, { count: number; at: number }>;
    followUps: Map<string, FollowUp>;
}

const REGISTRY = Symbol.for("polaris.places.devices.watch");

function watches(): Map<string, Watch> {
    const holder = globalThis as unknown as Record<symbol, Map<string, Watch> | undefined>;
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}

function watchFor(installedAppId: string): Watch {
    const all = watches();
    let watch = all.get(installedAppId);
    if (!watch) {
        watch = {
            viewers: 0,
            background: false,
            timer: null,
            dueAt: 0,
            running: false,
            failures: new Map(),
            followUps: new Map()
        };
        all.set(installedAppId, watch);
    }
    return watch;
}

function active(watch: Watch): boolean {
    return watch.viewers > 0 || watch.background || watch.followUps.size > 0;
}

function nextFollowUps(watch: Watch): Map<string, number> {
    const next = new Map<string, number>();
    for (const [id, followUp] of watch.followUps) {
        const at = followUp.times[0];
        if (at !== undefined) next.set(id, at);
    }
    return next;
}

/** After a pass: drop the follow-up times that have come, and the whole
 *  follow-up once none of its devices is still moving. */
async function settleFollowUps(
    installedAppId: string,
    watch: Watch,
    read: readonly string[]
): Promise<void> {
    const now = Date.now();
    const devices = await import("./devices");
    for (const id of read) {
        const followUp = watch.followUps.get(id);
        if (!followUp) continue;
        followUp.times = followUp.times.filter((at) => at > now);
        let moving = false;
        for (const deviceId of followUp.devices) {
            const device = await devices.getDevice(installedAppId, deviceId).catch(() => null);
            if (device?.state === "moving") moving = true;
        }
        if (!moving || followUp.times.length === 0) watch.followUps.delete(id);
    }
}

async function tick(installedAppId: string, watch: Watch): Promise<void> {
    watch.timer = null;
    if (!active(watch)) return;
    watch.running = true;
    let nextInMs = CLOUD_POLL_MS;
    try {
        const list = await accounts.listAccounts(installedAppId);
        const known = new Set(list.map((account) => account.id));
        for (const id of watch.followUps.keys()) if (!known.has(id)) watch.followUps.delete(id);
        const options = { watched: watch.viewers > 0, followUps: nextFollowUps(watch) };
        const plan = dueAccounts(list, watch.failures, Date.now(), options);
        if (plan.due.length > 0) {
            const failed = new Set(await readAccounts(installedAppId, plan.due));
            for (const id of plan.due) {
                if (failed.has(id)) {
                    const count = (watch.failures.get(id)?.count ?? 0) + 1;
                    watch.failures.set(id, { count, at: Date.now() });
                } else {
                    watch.failures.delete(id);
                }
            }
            await settleFollowUps(installedAppId, watch, plan.due);
            // Planned again as of now, so a fast account is not held to the pace
            // of the slow one read beside it. What was just read counts as read
            // now; what failed is paced by its failure.
            const readAt = new Date().toISOString();
            const after = list.map((account) =>
                plan.due.includes(account.id) && !failed.has(account.id)
                    ? { ...account, lastSyncedAt: readAt }
                    : account
            );
            nextInMs = dueAccounts(after, watch.failures, Date.now(), {
                watched: watch.viewers > 0,
                followUps: nextFollowUps(watch)
            }).nextInMs;
        } else {
            nextInMs = plan.nextInMs;
        }
    } catch (error) {
        console.error("places: the devices could not be read:", error);
        nextInMs = MAX_BACKOFF_MS / 5;
    } finally {
        watch.running = false;
    }
    schedule(installedAppId, watch, nextInMs);
}

/** Set the timer, or bring it forward when it would fire later than asked. A
 *  pass in flight plans its own next one. */
function schedule(installedAppId: string, watch: Watch, delayMs: number): void {
    if (!active(watch) || watch.running) return;
    const dueAt = Date.now() + delayMs;
    if (watch.timer) {
        if (watch.dueAt <= dueAt) return;
        clearTimeout(watch.timer);
    }
    watch.dueAt = dueAt;
    watch.timer = setTimeout(() => void tick(installedAppId, watch), delayMs);
    watch.timer.unref?.();
}

function idle(watch: Watch): void {
    if (active(watch)) return;
    if (watch.timer) clearTimeout(watch.timer);
    watch.timer = null;
    watch.failures.clear();
}

/**
 * Keep an install's devices at the screen's pace for as long as the returned
 * release has not been called. Any number of screens share one loop, which the
 * coordinator keeps going at its own pace once the last one closes.
 */
export function watchDevices(installedAppId: string): () => void {
    const watch = watchFor(installedAppId);
    watch.viewers += 1;
    // The first screen is read for at once, where an account is due: it was
    // drawn from the last stored read, and the sooner that is confirmed the
    // sooner anything stale on it is put right.
    schedule(installedAppId, watch, 0);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        watch.viewers -= 1;
        idle(watch);
    };
}

/**
 * Read a device's account again shortly after a command - at each of
 * `FOLLOW_UP_MS` - until the device has stopped moving. A lock told to lock is
 * "moving" until its account says where it got to, and without this that is
 * what it would read as until the next turn of the timer.
 */
export function requestFollowUps(
    installedAppId: string,
    accountId: string,
    deviceId: string
): void {
    const watch = watchFor(installedAppId);
    const now = Date.now();
    const current = watch.followUps.get(accountId);
    const devices = new Set(current?.devices ?? []);
    devices.add(deviceId);
    watch.followUps.set(accountId, { times: FOLLOW_UP_MS.map((ms) => now + ms), devices });
    schedule(installedAppId, watch, FOLLOW_UP_MS[0]!);
}

interface Coordinator {
    timer: ReturnType<typeof setInterval> | null;
}

const COORDINATOR = Symbol.for("polaris.places.devices.coordinator");

function coordinator(): Coordinator {
    const holder = globalThis as unknown as Record<symbol, Coordinator | undefined>;
    holder[COORDINATOR] ??= { timer: null };
    return holder[COORDINATOR];
}

/** Keep every install that has a device account read in the background, and
 *  stop keeping one that no longer has any. */
export async function discoverInstalls(): Promise<string[]> {
    const installs = new Set(await accounts.installsWithAccounts());
    for (const [installedAppId, watch] of watches()) {
        if (installs.has(installedAppId)) continue;
        watch.background = false;
        idle(watch);
    }
    for (const installedAppId of installs) {
        const watch = watchFor(installedAppId);
        if (watch.background) continue;
        watch.background = true;
        schedule(installedAppId, watch, 0);
    }
    return [...installs];
}

/**
 * Start the background coordinator: once per process, however often it is
 * called. Looks for installs with accounts now and every `DISCOVER_MS`.
 */
export function startDeviceCoordinator(): void {
    const state = coordinator();
    if (state.timer) return;
    const look = () =>
        void discoverInstalls().catch((error) =>
            console.error("places: the device accounts could not be listed:", error)
        );
    state.timer = setInterval(look, DISCOVER_MS);
    state.timer.unref?.();
    look();
}

/** Stop the background reads. Open screens and follow-ups keep their own. */
export function stopDeviceCoordinator(): void {
    const state = coordinator();
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    for (const watch of watches().values()) {
        watch.background = false;
        idle(watch);
    }
}

/** How long an install's account goes between reads right now: faster while a
 *  screen is open. What an assistant measures a device's age against. */
export function currentInterval(installedAppId: string, connection: string): number {
    return pollInterval(connection, (watches().get(installedAppId)?.viewers ?? 0) > 0);
}
