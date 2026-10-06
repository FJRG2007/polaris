/**
 * Hearing devices change the moment they do, where their make says so.
 *
 * The background reads (`device-watch.ts`) find a change at the next turn of an
 * account's timer: ten seconds on the same network, a minute for SwitchBot.
 * Some makes do not have to be asked: Home Assistant pushes every entity change
 * over its WebSocket, a DIRIGERA hub has an event stream, and a broker hands a
 * subscriber everything published to it - the discovery convention's devices
 * and Nuki's locks alike. For an account whose driver has such a channel
 * (`DeviceDriver.listen`), one is held open for as long as the coordinator
 * keeps the install read, and a change on it is a read of that account now.
 *
 * A change is only ever a reason to read. What a device changed to is read
 * through the same path as every other reading (`readAccounts`, then
 * `syncDevices`), which is what publishes it to the open screens
 * (`device-live`) and stores it - so a pushed message can never put a state on
 * a screen that a read would not have, and the vocabulary stays the driver's.
 * The timer keeps going underneath, for whatever a channel misses while it is
 * reconnecting.
 *
 * Bounded both ways. Changes are gathered for `PUSH_DEBOUNCE_MS` and an
 * account is read for them at most once every `PUSH_MIN_GAP_MS`, so a power
 * meter reporting every second costs one read every few seconds, not one per
 * message; and a change about nothing Polaris shows (an entity it does not
 * draw) costs a lookup, not a read. A channel that drops is opened again after
 * a wait that doubles with each failure, up to `MAX_BACKOFF_MS`.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as accounts from "./device-accounts";
import { DriverError } from "./drivers/contract";

/** How long changes are gathered before the account is read for them. */
export const PUSH_DEBOUNCE_MS = 250;
/** The least time between two reads of one account for its pushed changes. */
export const PUSH_MIN_GAP_MS = 3000;
/** The first wait before a dropped channel is opened again. */
export const PUSH_RETRY_MS = 5000;
/** The longest wait between attempts. */
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** A channel that stayed open this long and then closed was working: the
 *  next one starts from the first wait again. */
const HEALTHY_MS = 60 * 1000;
/** The most changed ids looked up at once; past that, the account is read. */
const LOOKUP_MAX = 200;

/** Reads one account now, through the one path. */
export type ReadAccount = (accountId: string) => Promise<unknown>;

interface Channel {
    readonly installedAppId: string;
    readonly accountId: string;
    readonly connection: string;
    controller: AbortController;
    failures: number;
    /** Opening again after a drop, or waiting to. */
    retry: ReturnType<typeof setTimeout> | null;
    /** What changed since the last read: ids, or "all" when a change could
     *  not say which. */
    pending: Set<string> | "all";
    flush: ReturnType<typeof setTimeout> | null;
    lastReadAt: number;
    read: ReadAccount;
    closed: boolean;
}

const REGISTRY = Symbol.for("polaris.places.devices.push");

function channels(): Map<string, Channel> {
    const holder = globalThis as unknown as Record<symbol, Map<string, Channel> | undefined>;
    holder[REGISTRY] ??= new Map();
    return holder[REGISTRY];
}

/** How long to wait before opening a channel again after `failures` drops. */
export function retryDelay(failures: number): number {
    return Math.min(MAX_BACKOFF_MS, PUSH_RETRY_MS * 2 ** Math.max(0, Math.min(failures - 1, 10)));
}

/** Whether an account's make can tell Polaris when it changes. */
export function pushes(connection: string): boolean {
    return accounts.isConnectable(connection) && Boolean(accounts.driverFor(connection).listen);
}

/** Whether a change names a device this account has. */
async function concernsKnown(accountId: string, ids: ReadonlySet<string>): Promise<boolean> {
    if (ids.size > LOOKUP_MAX) return true;
    const known = await prisma.placeDevice.findFirst({
        where: { accountId, externalId: { in: [...ids] } },
        select: { id: true }
    });
    return known !== null;
}

async function flush(channel: Channel): Promise<void> {
    channel.flush = null;
    if (channel.closed) return;
    const pending = channel.pending;
    channel.pending = new Set();
    if (pending !== "all" && pending.size === 0) return;
    try {
        if (pending !== "all" && !(await concernsKnown(channel.accountId, pending))) return;
        channel.lastReadAt = Date.now();
        await channel.read(channel.accountId);
    } catch (error) {
        console.error("places: a device change could not be read:", error);
    }
}

function changed(channel: Channel, externalIds: readonly string[]): void {
    if (channel.closed) return;
    if (externalIds.length === 0) channel.pending = "all";
    else if (channel.pending !== "all") for (const id of externalIds) channel.pending.add(id);
    if (channel.flush) return;
    const wait = Math.max(PUSH_DEBOUNCE_MS, channel.lastReadAt + PUSH_MIN_GAP_MS - Date.now());
    channel.flush = setTimeout(() => void flush(channel), wait);
    channel.flush.unref?.();
}

function reopenLater(channel: Channel): void {
    if (channel.closed) return;
    channel.retry = setTimeout(() => {
        channel.retry = null;
        void open(channel);
    }, retryDelay(channel.failures));
    channel.retry.unref?.();
}

async function open(channel: Channel): Promise<void> {
    if (channel.closed) return;
    channel.controller = new AbortController();
    const { signal } = channel.controller;
    const openedAt = Date.now();
    try {
        const { credentials } = await accounts.accountWithCredentials(
            channel.installedAppId,
            channel.accountId
        );
        await accounts.driverFor(channel.connection).listen!(
            credentials,
            (ids) => changed(channel, ids),
            signal
        );
        // It closed. One that had been working starts over; one that closes as
        // soon as it opens is a failure like any other.
        channel.failures = Date.now() - openedAt >= HEALTHY_MS ? 1 : channel.failures + 1;
    } catch (error) {
        channel.failures += 1;
        // A refused sign-in is the account's to show, at its next read; this
        // only waits the longest before asking again.
        if (error instanceof DriverError && error.kind === "unauthorized")
            channel.failures = Math.max(channel.failures, 10);
        if (!(error instanceof DriverError))
            console.error("places: a device channel could not be opened:", error);
    }
    reopenLater(channel);
}

function close(key: string, channel: Channel): void {
    channel.closed = true;
    channel.controller.abort();
    if (channel.retry) clearTimeout(channel.retry);
    if (channel.flush) clearTimeout(channel.flush);
    channels().delete(key);
}

/**
 * Hold a channel open for each of this install's accounts whose make pushes,
 * and close the ones of accounts it no longer has. Called on every pass of
 * the coordinator, so an account connected since is listened to from the next
 * one; does nothing for an account already listened to.
 */
export function keepListening(
    installedAppId: string,
    list: readonly Pick<accounts.DeviceAccountView, "id" | "connection">[],
    read: ReadAccount
): void {
    const wanted = new Map(
        list
            .filter((account) => pushes(account.connection))
            .map((account) => [`${installedAppId}:${account.id}`, account])
    );
    for (const [key, channel] of channels()) {
        if (channel.installedAppId === installedAppId && !wanted.has(key)) close(key, channel);
    }
    for (const [key, account] of wanted) {
        const held = channels().get(key);
        if (held) {
            held.read = read;
            continue;
        }
        const channel: Channel = {
            installedAppId,
            accountId: account.id,
            connection: account.connection,
            controller: new AbortController(),
            failures: 0,
            retry: null,
            pending: new Set(),
            flush: null,
            lastReadAt: 0,
            read,
            closed: false
        };
        channels().set(key, channel);
        void open(channel);
    }
}

/** Close every channel of an install: nothing keeps it read any more. */
export function stopListening(installedAppId: string): void {
    for (const [key, channel] of channels()) {
        if (channel.installedAppId === installedAppId) close(key, channel);
    }
}

/** The accounts of an install with a channel held for them, open or
 *  reopening. */
export function listening(installedAppId: string): string[] {
    return [...channels().values()]
        .filter((channel) => channel.installedAppId === installedAppId)
        .map((channel) => channel.accountId);
}
