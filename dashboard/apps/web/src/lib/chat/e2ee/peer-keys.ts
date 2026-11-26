/**
 * What this browser remembers about the other person's account key in a
 * one-to-one conversation (design 4.6): the key it last saw, whether that
 * changed since, and which safety number this account checked with them.
 *
 * Trust on first use, as Signal and WhatsApp do: the first key seen is
 * remembered without a word; a different one later is a key change, shown as a
 * line in the conversation until it is acknowledged, and it takes away a
 * verification made against the old one. The memory is per browser and per
 * signed-in account, like Signal's per device.
 *
 * Kept in `localStorage`: small, synchronous for the first frame, and a
 * failure to read or write it (private window, storage blocked) only means no
 * notice and no mark - never a refused message.
 */

import { fromText } from "@/lib/chat/e2ee/base64url";
import * as keyLog from "@/lib/chat/e2ee/key-log-client";

/** One peer as this browser knows them. */
export interface PeerKeyRecord {
    /** SHA-256 of the peer's published public keys, hex. */
    readonly fp: string;
    /** When this browser last saw the key, ms since epoch: what pruning keeps. */
    readonly seenAt: number;
    /** The key changed since it was first seen and nobody has acknowledged it yet. */
    readonly changed: boolean;
    /** The safety number verified with this peer, or null. */
    readonly verifiedDigits: string | null;
}

export type PeerKeyBook = Readonly<Record<string, PeerKeyRecord>>;

/** Peers kept per account; the least recently seen go first. */
export const MAX_PEERS = 2000;

/**
 * The book after seeing `fp` for `peerId`: remembered on first sight, marked
 * changed - and unverified - when it differs from the one remembered.
 */
export function observePeer(book: PeerKeyBook, peerId: string, fp: string, now: number): PeerKeyBook {
    const known = book[peerId];
    const record: PeerKeyRecord = !known
        ? { fp, seenAt: now, changed: false, verifiedDigits: null }
        : known.fp === fp
          ? { ...known, seenAt: now }
          : { fp, seenAt: now, changed: true, verifiedDigits: null };
    return prune({ ...book, [peerId]: record });
}

/** The book with the change notice for `peerId` put away. */
export function acknowledgePeer(book: PeerKeyBook, peerId: string): PeerKeyBook {
    const known = book[peerId];
    return known?.changed ? { ...book, [peerId]: { ...known, changed: false } } : book;
}

/**
 * The book with `digits` verified for `peerId` - only while `fp` is still the
 * key remembered, so a verification made on a stale screen never lands on a
 * newer key. `null` takes a verification away. Verifying also settles a change.
 */
export function verifyPeer(book: PeerKeyBook, peerId: string, fp: string, digits: string | null): PeerKeyBook {
    const known = book[peerId];
    if (!known || known.fp !== fp) return book;
    return { ...book, [peerId]: { ...known, verifiedDigits: digits, changed: digits ? false : known.changed } };
}

function prune(book: PeerKeyBook): PeerKeyBook {
    const ids = Object.keys(book);
    if (ids.length <= MAX_PEERS) return book;
    const kept = ids.sort((a, b) => book[b]!.seenAt - book[a]!.seenAt).slice(0, MAX_PEERS);
    return Object.fromEntries(kept.map((id) => [id, book[id]!]));
}

/** The fingerprint of a published key pair, as the routes send it (base64url texts). */
export async function keyFingerprint(signPublicKey: string, hpkePublicKey: string): Promise<string> {
    const bytes = new TextEncoder().encode(`${signPublicKey}.${hpkePublicKey}`);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const PREFIX = "polaris:chat:peer-keys:";
const listeners = new Set<() => void>();

function parse(raw: string | null): PeerKeyBook {
    if (!raw) return {};
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const book: Record<string, PeerKeyRecord> = {};
        for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
            const e = entry as Partial<PeerKeyRecord> | null;
            if (!e || typeof e.fp !== "string" || !/^[0-9a-f]{64}$/.test(e.fp)) continue;
            book[id] = {
                fp: e.fp,
                seenAt: typeof e.seenAt === "number" ? e.seenAt : 0,
                changed: e.changed === true,
                verifiedDigits: typeof e.verifiedDigits === "string" && /^\d{60}$/.test(e.verifiedDigits) ? e.verifiedDigits : null
            };
        }
        return book;
    } catch {
        return {};
    }
}

/** This account's book in this browser; empty when storage is unavailable. */
export function readBook(ownId: string): PeerKeyBook {
    try {
        return parse(window.localStorage.getItem(PREFIX + ownId));
    } catch {
        return {};
    }
}

/** Applies `change` to this account's book and tells every screen showing it. */
export function updateBook(ownId: string, change: (book: PeerKeyBook) => PeerKeyBook): PeerKeyBook {
    const before = readBook(ownId);
    const after = change(before);
    if (after !== before) {
        try {
            window.localStorage.setItem(PREFIX + ownId, JSON.stringify(after));
        } catch {
            // Storage refused: the notice and the mark live for this page only.
        }
        for (const listener of listeners) listener();
    }
    return after;
}

/** Calls `listener` when any book changes, in this tab or another. */
export function subscribeBooks(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key.startsWith(PREFIX)) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
    };
}

/** A page of `account-keys`: the most people one check covers. */
export const PEERS_PER_CHECK = 100;

type PublishedPair = { signPublicKey: string; hpkePublicKey: string };

/** The published keys of `peerIds` in `channelId`, as `/api/e2ee/mls` answers them; null when unreachable. */
export async function fetchPeersKeys(channelId: string, peerIds: ReadonlyArray<string>): Promise<Map<string, PublishedPair> | null> {
    try {
        const response = await fetch("/api/e2ee/mls", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ op: "account-keys", channelId, userIds: peerIds.slice(0, PEERS_PER_CHECK) })
        });
        if (!response.ok) return null;
        const answer = (await response.json()) as { accountKeys?: ({ userId: string } & PublishedPair)[] };
        return new Map((answer.accountKeys ?? []).map((entry) => [entry.userId, { signPublicKey: entry.signPublicKey, hpkePublicKey: entry.hpkePublicKey }]));
    } catch {
        return null;
    }
}

/** The peer's published keys in `channelId`; "none" when they have none, null when unreachable. */
export async function fetchPeerKeys(channelId: string, peerId: string): Promise<PublishedPair | "none" | null> {
    const found = await fetchPeersKeys(channelId, [peerId]);
    return found ? (found.get(peerId) ?? "none") : null;
}

/**
 * Fetches the keys of `peerIds` and records each one the key log vouches for
 * (`key-log-client.ts`); a key the log contradicts is never remembered, so it
 * cannot become the trusted first sight. When the log cannot be asked the key
 * is recorded as before, on first use. The fingerprints recorded, by account.
 */
export async function checkPeers(ownId: string, channelId: string, peerIds: ReadonlyArray<string>): Promise<Map<string, string>> {
    const recorded = new Map<string, string>();
    const keys = await fetchPeersKeys(channelId, peerIds);
    if (!keys?.size) return recorded;
    const served = [...keys].map(([userId, pair]) => ({ userId, hpkePublicKey: fromText(pair.hpkePublicKey) }));
    const vouched = await keyLog.vouchedAccounts(ownId, channelId, served);
    const now = Date.now();
    for (const [userId, pair] of keys) {
        if (vouched && !vouched.has(userId)) continue;
        recorded.set(userId, await keyFingerprint(pair.signPublicKey, pair.hpkePublicKey));
    }
    updateBook(ownId, (book) => [...recorded].reduce((next, [userId, fp]) => observePeer(next, userId, fp, now), book));
    return recorded;
}

/** Fetches the peer's key and records it; the peer's fingerprint, or null when there is none to record. */
export async function checkPeer(ownId: string, channelId: string, peerId: string): Promise<string | null> {
    return (await checkPeers(ownId, channelId, [peerId])).get(peerId) ?? null;
}
