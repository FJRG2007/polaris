"use client";

/**
 * The offline write queue every app other than chat shares: a note's text, a
 * document, a task. One queue, one order, one place it is kept - each app adds
 * a kind (what an entry is and which server call takes it) and nothing else.
 *
 * Kept in the account's own local store (`polaris-offline`), deleted on
 * sign-out with everything else the account left here (`account-switch`).
 * Entries are what only exists on this device, so no update of Polaris makes
 * them unreadable (`buildBound: false`), and they wait a year, not a month: a
 * laptop left in a drawer still has the note that was written on the train.
 */

import { snapshotBuild } from "@/lib/snapshot-cache";
import type { QueuedEntry, QueueSendResult } from "./outbox";
import { createWriteQueue, type WriteQueue } from "./write-queue";
import { createLocalStore, indexedDbStore, type LocalStoreLimits } from "@/lib/chat/offline/local-store";

export interface AppWrite extends QueuedEntry {
    /** Which kind of write, as registered with `registerWriteKind`. */
    readonly kind: string;
    /** What it writes to - a note id, a document id: what the screen asks about. */
    readonly target: string;
    readonly payload: unknown;
}

const DAY_MS = 24 * 3_600_000;

export const OFFLINE_STORE_LIMITS: LocalStoreLimits = {
    writes: { entries: 2_000, maxAgeMs: 365 * DAY_MS, buildBound: false },
    /** Per target, the server's version after this device's last write it took. */
    acks: { entries: 1_000, maxAgeMs: 365 * DAY_MS, buildBound: false }
};

export const offlineStore = createLocalStore(indexedDbStore("polaris-offline"), OFFLINE_STORE_LIMITS, snapshotBuild);

const kinds = new Map<string, (entry: AppWrite) => Promise<QueueSendResult>>();
/** Kinds whose writes add to each other (a document's changes) rather than
 *  replace each other (a note's whole text). */
const additive = new Set<string>();

/**
 * Name how one kind of write reaches the server. Called once, at import.
 * `additive` when each write is part of the whole rather than all of it, so
 * what a closing tab left is put in line beside what was already waiting.
 */
export function registerWriteKind(
    kind: string,
    deliver: (entry: AppWrite) => Promise<QueueSendResult>,
    options: { additive?: boolean } = {}
): void {
    kinds.set(kind, deliver);
    if (options.additive) additive.add(kind);
}

export const appWrites: WriteQueue<AppWrite> = createWriteQueue<AppWrite>({
    store: offlineStore,
    kind: "writes",
    lock: "polaris-offline-writes",
    // A kind this build no longer knows is not sendable, and must not hold up
    // everything after it: it is shown as not sent instead.
    deliver: (entry) => kinds.get(entry.kind)?.(entry) ?? Promise.resolve({ refused: "" })
});

export type NewWrite = Omit<AppWrite, "state" | "attempts" | "createdAt">;

async function keptFor(kind: string, target: string): Promise<AppWrite[]> {
    return (await appWrites.readAll()).filter((entry) => entry.kind === kind && entry.target === target);
}

/** The waiting and failed writes to one target, oldest first - what was left
 *  unsaved when the tab last closed included. */
export async function writesFor(kind: string, target: string): Promise<AppWrite[]> {
    await recoverUnloaded();
    return keptFor(kind, target);
}

/**
 * Keep a write that replaces whatever of the same kind is still waiting for the
 * same target - the newest text of a note is the only one worth sending. Only a
 * pending entry is replaced; a failed one stays for the reader to decide on.
 */
export async function replaceWrite(entry: NewWrite): Promise<boolean> {
    const kept = await appWrites.enqueue(entry);
    if (!kept) return false;
    // A later save of the same thing supersedes what a closing tab left behind.
    forgetUnloaded(entry.kind, entry.target);
    const older = (await keptFor(entry.kind, entry.target)).filter(
        (other) => other.key !== entry.key && other.state === "pending"
    );
    for (const other of older) await offlineStore.forget("writes", other.key);
    return true;
}

export function readAck(target: string): Promise<string | null> {
    return offlineStore.read<string>("acks", target);
}

export function writeAck(target: string, version: string): void {
    void offlineStore.write("acks", target, version);
}

/*
 * The last words before a tab closes. A screen saves a moment after typing
 * stops, and the device store answers asynchronously - neither finishes once
 * the page is going away. So whatever a screen still holds unsaved is written
 * synchronously, to localStorage, as the page is hidden or closed, and moved
 * into the queue the next time any Polaris page opens for that account.
 */

const UNLOAD_PREFIX = "polaris-offline-unload:";
const unloadSources = new Set<() => NewWrite | null>();

function unloadKey(): string | null {
    const owner = offlineStore.owner();
    return owner ? `${UNLOAD_PREFIX}${owner}` : null;
}

function readUnloaded(key: string): NewWrite[] {
    try {
        const kept: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
        return Array.isArray(kept) ? (kept as NewWrite[]) : [];
    } catch {
        return [];
    }
}

function storeUnloaded(key: string, entries: readonly NewWrite[]): void {
    try {
        if (entries.length === 0) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, JSON.stringify(entries));
    } catch {
        // Storage refused or full: what the screen holds is all there is.
    }
}

const sameTarget = (a: NewWrite, b: Pick<NewWrite, "kind" | "target">): boolean =>
    a.kind === b.kind && a.target === b.target;

function forgetUnloaded(kind: string, target: string): void {
    const key = typeof window === "undefined" ? null : unloadKey();
    if (!key) return;
    const kept = readUnloaded(key);
    const rest = kept.filter((entry) => !sameTarget(entry, { kind, target }));
    if (rest.length !== kept.length) storeUnloaded(key, rest);
}

/** Synchronously keep what every open screen has not saved yet. */
export function keepUnsavedNow(): void {
    const key = unloadKey();
    if (!key) return;
    const fresh = [...unloadSources].map((read) => read()).filter((entry): entry is NewWrite => entry !== null);
    if (fresh.length === 0) return;
    const older = readUnloaded(key).filter((entry) => !fresh.some((write) => sameTarget(entry, write)));
    storeUnloaded(key, [...older, ...fresh]);
}

const onHidden = (): void => {
    if (document.visibilityState === "hidden") keepUnsavedNow();
};

/**
 * Have what a screen holds unsaved kept if the page goes away before it saves.
 * `read` answers the write it would make now, or null when nothing is unsaved.
 * Answers the function that stops it.
 */
export function keepOnUnload(read: () => NewWrite | null): () => void {
    if (unloadSources.size === 0) {
        // A phone discards a hidden tab without a pagehide, so hidden counts too.
        window.addEventListener("pagehide", keepUnsavedNow);
        document.addEventListener("visibilitychange", onHidden);
    }
    unloadSources.add(read);
    return () => {
        unloadSources.delete(read);
        if (unloadSources.size > 0) return;
        window.removeEventListener("pagehide", keepUnsavedNow);
        document.removeEventListener("visibilitychange", onHidden);
    };
}

let recovering: { owner: string; done: Promise<void> } | null = null;

/** Move what a closing tab left behind into the queue, once per account and page. */
export function recoverUnloaded(): Promise<void> {
    const owner = offlineStore.owner();
    if (typeof window === "undefined" || !owner) return Promise.resolve();
    if (recovering?.owner === owner) return recovering.done;
    const run = async (): Promise<void> => {
        const key = `${UNLOAD_PREFIX}${owner}`;
        // Each one leaves the list as it is queued (`replaceWrite`); one the
        // device could not keep stays for the next page.
        for (const entry of readUnloaded(key)) {
            if (!additive.has(entry.kind)) {
                await replaceWrite(entry).catch(() => false);
                continue;
            }
            if (await appWrites.enqueue(entry).catch(() => false)) forgetUnloaded(entry.kind, entry.target);
        }
    };
    recovering = { owner, done: run() };
    return recovering.done;
}

/** Forget everything this device kept of anybody's unsent writes. */
export function dropOfflineStore(): Promise<void> {
    recovering = null;
    try {
        const doomed: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (key?.startsWith(UNLOAD_PREFIX)) doomed.push(key);
        }
        for (const key of doomed) window.localStorage.removeItem(key);
    } catch {
        // Storage refused: nothing was kept there.
    }
    return offlineStore.clear();
}
