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

/** Name how one kind of write reaches the server. Called once, at import. */
export function registerWriteKind(kind: string, deliver: (entry: AppWrite) => Promise<QueueSendResult>): void {
    kinds.set(kind, deliver);
}

export const appWrites: WriteQueue<AppWrite> = createWriteQueue<AppWrite>({
    store: offlineStore,
    kind: "writes",
    lock: "polaris-offline-writes",
    // A kind this build no longer knows is not sendable, and must not hold up
    // everything after it: it is shown as not sent instead.
    deliver: (entry) => kinds.get(entry.kind)?.(entry) ?? Promise.resolve({ refused: "" })
});

/** The waiting and failed writes to one target, oldest first. */
export async function writesFor(kind: string, target: string): Promise<AppWrite[]> {
    return (await appWrites.readAll()).filter((entry) => entry.kind === kind && entry.target === target);
}

/**
 * Keep a write that replaces whatever of the same kind is still waiting for the
 * same target - the newest text of a note is the only one worth sending. Only a
 * pending entry is replaced; a failed one stays for the reader to decide on.
 */
export async function replaceWrite(entry: Omit<AppWrite, "state" | "attempts" | "createdAt">): Promise<boolean> {
    const kept = await appWrites.enqueue(entry);
    if (!kept) return false;
    const older = (await writesFor(entry.kind, entry.target)).filter(
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

/** Forget everything this device kept of anybody's unsent writes. */
export function dropOfflineStore(): Promise<void> {
    return offlineStore.clear();
}
