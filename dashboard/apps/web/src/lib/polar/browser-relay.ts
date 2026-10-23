/**
 * The road between Polar and the person's own browser.
 *
 * Nothing can push to a browser extension, so the extension asks: while it is
 * connected to this Polaris, its worker holds one
 * long poll open here (`/api/extension/browser/next`) with its connection's
 * token, picks up a command when Polar has one for that account, runs it in the
 * browser and posts the answer back (`/api/extension/browser/result`). A
 * browser that has polled recently is one Polar can use; one that has not is
 * not there, and a tool call says so at once instead of waiting.
 *
 * Commands go to one browser per account at a time: the one that was used last
 * while it is still polling, otherwise whichever polled most recently - a tab
 * number means nothing in any other browser. An answer is only taken from the
 * connection the command was handed to.
 *
 * Held in memory, on `globalThis` so every route bundle in this process shares
 * one copy. The dashboard runs as one process; a command in flight across a
 * restart is lost, and the tool call that sent it times out and says so.
 *
 * Server-only.
 */

import { randomBytes } from "node:crypto";
import { browserSite, type BrowserCommand, type BrowserResult } from "@polaris/core/browser-agent";

/** How long a browser counts as there after its last poll. A poll is held for
 *  `POLL_HOLD_MS`, so this is a little over two of them. */
export const PRESENT_MS = 45_000;
/** How long one poll is held open waiting for a command. */
export const POLL_HOLD_MS = 20_000;
/** How long a command may take in the browser - including the person deciding
 *  whether Polar may use a site the first time it asks. */
export const COMMAND_TIMEOUT_MS = 120_000;
/** Commands queued for one account at most; more is a loop, not a person. */
const QUEUE_MOST = 20;

interface Waiting {
    readonly connectionId: string;
    readonly hand: (envelope: { id: string; command: BrowserCommand } | null) => void;
}

interface InFlight {
    readonly userId: string;
    readonly command: BrowserCommand;
    connectionId: string | null;
    readonly settle: (result: RelayOutcome) => void;
}

interface RelayState {
    /** userId -> connectionId -> last poll time. */
    readonly seen: Map<string, Map<string, number>>;
    /** userId -> the connection the last command went to. */
    readonly pinned: Map<string, string>;
    /** userId -> polls waiting for a command. */
    readonly waiting: Map<string, Waiting[]>;
    /** userId -> command ids not yet handed to a browser, oldest first. */
    readonly queued: Map<string, string[]>;
    readonly inFlight: Map<string, InFlight>;
    /** connectionId -> the sites that browser says the person allowed always. */
    readonly sites: Map<string, readonly string[]>;
    /** When `seen` was last cleared of browsers that stopped polling. */
    sweptAt: number;
}

const KEY = Symbol.for("polaris.polarBrowserRelay");

function state(): RelayState {
    const holder = globalThis as unknown as Record<symbol, RelayState | undefined>;
    holder[KEY] ??= {
        seen: new Map(),
        pinned: new Map(),
        waiting: new Map(),
        queued: new Map(),
        inFlight: new Map(),
        sites: new Map(),
        sweptAt: 0
    };
    return holder[KEY];
}

/** What running a command came to. */
export type RelayOutcome =
    | { kind: "answered"; result: BrowserResult }
    | { kind: "absent" }
    | { kind: "timeout" }
    | { kind: "busy" };

/** The connections of this account that polled within `PRESENT_MS`, newest first. */
function presentConnections(userId: string, now: number): string[] {
    const relay = state();
    const seen = relay.seen.get(userId);
    if (!seen) return [];
    for (const [id, at] of seen) {
        if (now - at <= PRESENT_MS) continue;
        seen.delete(id);
        relay.sites.delete(id);
    }
    if (seen.size === 0) {
        relay.seen.delete(userId);
        relay.pinned.delete(userId);
        return [];
    }
    const pinned = relay.pinned.get(userId);
    if (pinned && !seen.has(pinned)) relay.pinned.delete(userId);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Whether this account has a browser Polar can use right now. */
export function browserPresent(userId: string, now = Date.now()): boolean {
    return presentConnections(userId, now).length > 0;
}

/** The most sites one browser reports. */
export const SITES_MOST = 200;

/** What a poll says the person allowed always in that browser. It only ever
 *  saves a question in the chat: the extension still decides each command. */
export function noteSites(connectionId: string, sites: readonly string[]): void {
    state().sites.set(connectionId, sites.slice(0, SITES_MOST));
}

/** The sites a poll reports, each checked; the rest dropped. */
export function sitesHeader(value: string | null): string[] {
    if (!value) return [];
    return value
        .split(",")
        .slice(0, SITES_MOST)
        .flatMap((entry) => {
            const site = browserSite.safeParse(entry);
            return site.success && site.data ? [site.data] : [];
        });
}

/** The sites the browser commands go to says are allowed always. */
export function grantedSites(userId: string, now = Date.now()): readonly string[] {
    const target = chosenConnection(userId, now);
    return (target && state().sites.get(target)) || [];
}

/** The connection commands go to: the pinned one while it is there. */
function chosenConnection(userId: string, now: number): string | null {
    const present = presentConnections(userId, now);
    const pinned = state().pinned.get(userId);
    if (pinned && present.includes(pinned)) return pinned;
    return present[0] ?? null;
}

function markSeen(userId: string, connectionId: string, now: number): void {
    const relay = state();
    let seen = relay.seen.get(userId);
    if (!seen) {
        seen = new Map();
        relay.seen.set(userId, seen);
    }
    seen.set(connectionId, now);
    if (now - relay.sweptAt > PRESENT_MS) {
        relay.sweptAt = now;
        for (const user of [...relay.seen.keys()]) presentConnections(user, now);
    }
}

/** Hand the oldest queued command to a waiting poll of the chosen connection. */
function dispatch(userId: string, now: number): void {
    const relay = state();
    const queue = relay.queued.get(userId);
    const polls = relay.waiting.get(userId);
    if (!queue?.length || !polls?.length) return;
    const target = chosenConnection(userId, now);
    const index = polls.findIndex((poll) => poll.connectionId === target);
    if (index === -1) return;
    const id = queue.shift();
    if (queue.length === 0) relay.queued.delete(userId);
    const flight = id ? relay.inFlight.get(id) : undefined;
    if (!id || !flight) return dispatch(userId, now);
    const [poll] = polls.splice(index, 1);
    if (!poll) return;
    flight.connectionId = poll.connectionId;
    relay.pinned.set(userId, poll.connectionId);
    poll.hand({ id, command: flight.command });
}

/**
 * One poll from a browser: resolves with a command as soon as there is one for
 * this account, or with null after `holdMs`. `signal` is the request's, so a
 * poll the browser gave up on stops waiting.
 */
export function nextCommand(
    userId: string,
    connectionId: string,
    holdMs = POLL_HOLD_MS,
    signal?: AbortSignal
): Promise<{ id: string; command: BrowserCommand } | null> {
    const relay = state();
    const now = Date.now();
    markSeen(userId, connectionId, now);
    return new Promise((resolve) => {
        let done = false;
        const finish = (value: { id: string; command: BrowserCommand } | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", stop);
            const polls = relay.waiting.get(userId);
            const at = polls?.findIndex((poll) => poll.hand === finish) ?? -1;
            if (polls && at !== -1) polls.splice(at, 1);
            if (polls?.length === 0) relay.waiting.delete(userId);
            // Seen at the end of the hold too, so a browser that is waiting is
            // never counted as gone in the middle of its own poll.
            markSeen(userId, connectionId, Date.now());
            resolve(value);
        };
        const stop = () => finish(null);
        const timer = setTimeout(stop, holdMs);
        signal?.addEventListener("abort", stop);
        const polls = relay.waiting.get(userId) ?? [];
        // One poll per connection: a newer one replaces a stale one.
        for (const stale of polls.filter((poll) => poll.connectionId === connectionId)) {
            stale.hand(null);
        }
        polls.push({ connectionId, hand: finish });
        relay.waiting.set(userId, polls);
        dispatch(userId, now);
    });
}

/** File a browser's answer. False when the id is not one this connection holds. */
export function deliverResult(
    userId: string,
    connectionId: string,
    id: string,
    result: BrowserResult
): boolean {
    const relay = state();
    const flight = relay.inFlight.get(id);
    if (!flight || flight.userId !== userId || flight.connectionId !== connectionId) return false;
    relay.inFlight.delete(id);
    flight.settle({ kind: "answered", result });
    return true;
}

/**
 * Run one command in this account's browser and wait for the answer. Never
 * throws: no browser, a full queue and a timeout are each an outcome the tool
 * words for the model.
 */
export function runInBrowser(
    userId: string,
    command: BrowserCommand,
    timeoutMs = COMMAND_TIMEOUT_MS
): Promise<RelayOutcome> {
    const relay = state();
    const now = Date.now();
    if (!chosenConnection(userId, now)) return Promise.resolve({ kind: "absent" });
    const queue = relay.queued.get(userId) ?? [];
    if (queue.length >= QUEUE_MOST) return Promise.resolve({ kind: "busy" });
    const id = randomBytes(12).toString("base64url");
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            relay.inFlight.delete(id);
            const waiting = relay.queued.get(userId);
            const at = waiting?.indexOf(id) ?? -1;
            if (waiting && at !== -1) waiting.splice(at, 1);
            if (waiting?.length === 0) relay.queued.delete(userId);
            resolve({ kind: "timeout" });
        }, timeoutMs);
        relay.inFlight.set(id, {
            userId,
            command,
            connectionId: null,
            settle: (outcome) => {
                clearTimeout(timer);
                resolve(outcome);
            }
        });
        queue.push(id);
        relay.queued.set(userId, queue);
        dispatch(userId, now);
    });
}

/** Forget everything. Tests only. */
export function resetRelayForTests(): void {
    const holder = globalThis as unknown as Record<symbol, RelayState | undefined>;
    holder[KEY] = undefined;
}
