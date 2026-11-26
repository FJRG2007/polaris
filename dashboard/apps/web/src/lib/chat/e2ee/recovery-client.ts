/**
 * Quorum recovery in the browser (`@polaris/chat-crypto/recovery`): keeping
 * this account's shares current while it holds its key, approving a request as
 * a custodian, and, on a browser that lost everything, asking for the key back.
 *
 * The requester's one-off private key is a non-extractable CryptoKey kept in
 * IndexedDB for the life of the request (7 days), so closing the tab does not
 * lose the approvals already given. It is deleted as soon as the key is back.
 */

import type { KeysBody } from "./schemas";
import * as policy from "./recovery-policy";
import * as keyLog from "./key-log-client";
import * as recovery from "@polaris/chat-crypto/recovery";
import * as content from "@polaris/chat-crypto/message-content";
import { fromText, toText } from "./base64url";

const ROUTE = "/api/e2ee/keys";
const DB = "polaris-chat-recovery";
const STORE = "requester";
/** At most one share check per tab in this long: the state read is a few rows, but the MLS device asks often. */
const REFRESH_MS = 10 * 60 * 1000;
/** A log that could not vouch for a custodian is asked again sooner: usually a rotation in between. */
const RETRY_MS = 60 * 1000;

export interface RecoveryState {
    readonly scope: string;
    readonly orgName: string | null;
    readonly threshold: number;
    readonly custodians: ReadonlyArray<{ userId: string; akVersion: number; hpkePublicKey: string }>;
    readonly shares: ReadonlyArray<policy.StoredShare>;
    readonly soleCustodianOf: number;
}

export interface OwnRequest {
    readonly eligible: boolean;
    readonly request: {
        readonly id: string;
        readonly status: "pending" | "released";
        readonly akVersion: number;
        readonly threshold: number;
        readonly requesterKey: string;
        readonly expiresAt: string;
        readonly approvals: number;
        readonly declines: number;
        readonly released: ReadonlyArray<{ custodianId: string; envelope: string }>;
    } | null;
}

export interface InboxItem {
    readonly id: string;
    readonly ownerId: string;
    readonly ownerName: string | null;
    readonly ownerEmail: string | null;
    readonly akVersion: number;
    readonly splitId: string;
    readonly threshold: number;
    readonly requesterKey: string;
    readonly custodianAkVersion: number;
    readonly envelope: string;
    readonly createdAt: string;
    readonly expiresAt: string;
}

async function post<T>(body: KeysBody): Promise<T | null> {
    try {
        const response = await fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body)
        });
        return response.ok ? ((await response.json()) as T) : null;
    } catch {
        return null;
    }
}

export function recoveryState(): Promise<RecoveryState | null> {
    return post<RecoveryState>({ op: "recovery-state" });
}

let lastRefresh = 0;

/**
 * Split the held key again when the custodians, the threshold or a key version
 * changed. `accountKey` is a copy this function zeroes; it never throws.
 */
export async function refreshShares(ownerId: string, accountKey: Uint8Array, akVersion: number): Promise<void> {
    try {
        if (Date.now() - lastRefresh < REFRESH_MS) return;
        lastRefresh = Date.now();
        await ensureRecoveryKeys(ownerId);
        const state = await recoveryState();
        if (!state || !policy.needsSplit(akVersion, state, state.shares) || state.custodians.length === 0) return;
        const custodians = state.custodians.map((c) => ({
            userId: c.userId,
            akVersion: c.akVersion,
            hpkePublicKey: fromText(c.hpkePublicKey)
        }));
        // Fail closed: a share sealed to a key the log does not hold could be the server's own.
        if (!(await keyLog.vouchedCustodians(ownerId, custodians))) {
            lastRefresh = Date.now() - REFRESH_MS + RETRY_MS;
            return;
        }
        const splitId = crypto.randomUUID();
        const shares = await recovery.splitAccountKey(
            accountKey,
            custodians,
            state.threshold,
            { ownerId, akVersion, splitId }
        );
        await post({
            op: "put-recovery-shares",
            akVersion,
            splitId,
            threshold: state.threshold,
            scope: state.scope,
            shares: shares.map((share) => ({ ...share, envelope: toText(share.envelope) }))
        });
    } catch (caught) {
        console.error("polaris: recovery shares could not be refreshed:", caught);
    } finally {
        accountKey.fill(0);
    }
}

export interface KeyOpening {
    readonly id: string;
    readonly keyId: string;
    /** Raised by this account (only its browser that raised it can finish it). */
    readonly mine: boolean;
    readonly openerName: string | null;
    readonly openerEmail: string | null;
    readonly status: "pending" | "released";
    readonly splitId: string;
    readonly threshold: number;
    readonly requesterKey: string;
    readonly expiresAt: string;
    readonly released: number;
    readonly declined: number;
    readonly ownReleased: boolean;
    readonly shares: ReadonlyArray<{ custodianId: string; envelope: string }>;
}

export interface RecoveryKeyScope {
    readonly scope: string;
    readonly orgName: string | null;
    readonly threshold: number;
    readonly custodians: ReadonlyArray<{ userId: string; akVersion: number; hpkePublicKey: string }>;
    readonly key: {
        readonly id: string;
        /** Its shares match today's custodians and threshold. */
        readonly current: boolean;
        readonly splitId: string;
        readonly keyThreshold: number;
        readonly hpkePublicKey: string;
        readonly holders: number;
        /** A quorum of today's custodians can still open it. */
        readonly openable: boolean;
        /** This account's share, when it is one of the holders. */
        readonly share: { custodianAkVersion: number; envelope: string } | null;
    } | null;
    /** Members who came back with a key and wait for history only this key holds. */
    readonly waiting: number;
    readonly openings: ReadonlyArray<KeyOpening>;
}

export async function recoveryKeyState(): Promise<RecoveryKeyScope[] | null> {
    return (await post<{ scopes: RecoveryKeyScope[] }>({ op: "recovery-key-state" }))?.scopes ?? null;
}

/**
 * As a custodian, create the organisation recovery key of every scope that has
 * none, or whose key no quorum of today's custodians can open any more: a
 * fresh seed split to the scope's custodians, each checked against the key log
 * first, exactly as an account's own shares are. Then finish any opening this
 * browser raised that the quorum released (`finishOpening`). Never throws.
 */
export async function ensureRecoveryKeys(userId: string): Promise<void> {
    try {
        const scopes = (await recoveryKeyState()) ?? [];
        for (const entry of scopes) {
            for (const opening of entry.openings) if (opening.mine && opening.status === "released") await finishOpening(userId, entry, opening);
            if ((entry.key && entry.key.openable) || entry.custodians.length === 0) continue;
            const custodians = entry.custodians.map((c) => ({ userId: c.userId, akVersion: c.akVersion, hpkePublicKey: fromText(c.hpkePublicKey) }));
            // Fail closed, as for an account's shares: a key the log does not hold could be the server's own.
            if (!(await keyLog.vouchedCustodians(userId, custodians))) continue;
            const id = crypto.randomUUID();
            const created = await recovery.createRecoveryKey(id, custodians, entry.threshold);
            await post({
                op: "put-recovery-key",
                id,
                scope: entry.scope,
                hpkePublicKey: toText(created.publicKey),
                threshold: entry.threshold,
                shares: created.shares.map((share) => ({ ...share, envelope: toText(share.envelope) }))
            });
        }
    } catch (caught) {
        console.error("polaris: an organisation recovery key could not be created:", caught);
    }
}

const openingSlot = (openingId: string) => `ork-opening:${openingId}`;
/** Work pages one finish reads at most (ten conversations each); the next refresh carries on. */
const MAX_WORK_PAGES = 100;

/** Open this account's seed share of `key` and seal it to an opening's key. */
async function releaseOwnShare(
    custodianId: string,
    key: NonNullable<RecoveryKeyScope["key"]>,
    openingId: string,
    requesterKey: Uint8Array,
    accountHpke: () => Promise<{ hpkePrivateKey: CryptoKey } | null>
): Promise<boolean> {
    if (!key.share) return false;
    const own = await accountHpke();
    if (!own) return false;
    const share = await recovery.openShare(
        own.hpkePrivateKey,
        fromText(key.share.envelope),
        recovery.recoveryKeyBinding(key.id, key.splitId),
        custodianId,
        key.share.custodianAkVersion
    );
    try {
        const envelope = await recovery.releaseShare(requesterKey, share, recovery.openingBinding(openingId, key.id), custodianId);
        return (await post({ op: "recovery-key-release", openingId, envelope: toText(envelope) })) !== null;
    } finally {
        share.fill(0);
    }
}

/**
 * Raise an opening of a scope's recovery key from this browser and release
 * this account's own share to it. Answers the code the other custodians
 * compare, or null when refused.
 */
export async function startOpening(
    userId: string,
    entry: RecoveryKeyScope,
    accountHpke: () => Promise<{ hpkePrivateKey: CryptoKey } | null>
): Promise<{ openingId: string; code: string } | null> {
    if (!entry.key?.share) return null;
    const pair = await recovery.requesterKeyPair();
    const answer = await post<{ openingId: string }>({ op: "recovery-key-open", keyId: entry.key.id, requesterKey: toText(pair.publicKey) });
    if (!answer) return null;
    await stored("put", openingSlot(answer.openingId), { privateKey: pair.privateKey });
    if (!(await releaseOwnShare(userId, entry.key, answer.openingId, pair.publicKey, accountHpke))) return null;
    return { openingId: answer.openingId, code: await recovery.requestCode(answer.openingId, pair.publicKey) };
}

/** Whether this browser raised the opening (and so can finish it). */
export async function holdsOpening(openingId: string): Promise<boolean> {
    return Boolean(await stored("get", openingSlot(openingId)).catch(() => null));
}

/** Release this account's seed share to another custodian's opening, after comparing its code. */
export function approveOpening(
    userId: string,
    entry: RecoveryKeyScope,
    opening: KeyOpening,
    accountHpke: () => Promise<{ hpkePrivateKey: CryptoKey } | null>
): Promise<boolean> {
    if (!entry.key) return Promise.resolve(false);
    return releaseOwnShare(userId, entry.key, opening.id, fromText(opening.requesterKey), accountHpke);
}

/** Refuse another custodian's opening: the share is never opened. */
export async function declineOpening(opening: KeyOpening): Promise<boolean> {
    return (await post({ op: "recovery-key-decline", openingId: opening.id })) !== null;
}

/**
 * Once the quorum released its shares: rebuild the key's seed in this
 * browser, checked against the key's public half; split it again to today's
 * custodians if they changed (each checked against the key log); then seal
 * every history key sealed to it to the members missing it whose key the log
 * vouches for, and close the opening. The seed is zeroed as soon as it is
 * split; the private key lives only for this call. Answers how many history
 * copies were stored, or null when this browser cannot finish it.
 */
export async function finishOpening(userId: string, entry: RecoveryKeyScope, opening: KeyOpening): Promise<number | null> {
    if (!opening.mine || opening.status !== "released" || !entry.key || entry.key.id !== opening.keyId) return null;
    const held = (await stored("get", openingSlot(opening.id)).catch(() => null)) as { privateKey: CryptoKey } | null;
    if (!held) return null;
    const key = entry.key;
    const opened = await recovery.openRecoveryKey(
        held.privateKey,
        opening.shares.map((share) => ({ custodianId: share.custodianId, envelope: fromText(share.envelope) })),
        recovery.openingBinding(opening.id, key.id),
        fromText(key.hpkePublicKey)
    );
    try {
        if (!key.current && entry.custodians.length > 0) {
            const custodians = entry.custodians.map((c) => ({ userId: c.userId, akVersion: c.akVersion, hpkePublicKey: fromText(c.hpkePublicKey) }));
            // Fail closed: a share is never sealed to a key the log does not hold.
            if (await keyLog.vouchedCustodians(userId, custodians)) {
                const splitId = crypto.randomUUID();
                const shares = await recovery.splitAccountKey(opened.seed, custodians, entry.threshold, recovery.recoveryKeyBinding(key.id, splitId));
                await post({
                    op: "recovery-key-resplit",
                    openingId: opening.id,
                    splitId,
                    threshold: entry.threshold,
                    shares: shares.map((share) => ({ ...share, envelope: toText(share.envelope) }))
                });
            }
        }
    } finally {
        opened.seed.fill(0);
    }
    const recipient = `ork:${key.id}`;
    let sealed = 0;
    let after: string | null = null;
    for (let page = 0; page < MAX_WORK_PAGES; page++) {
        type Work = { items: Array<{ channelId: string; epoch: string; envelope: string; gaps: Array<{ userId: string; akVersion: number; hpkePublicKey: string }> }>; next: string | null };
        const work: Work | null = await post<Work>({ op: "recovery-key-work", openingId: opening.id, after });
        if (!work) return null;
        const served = new Map(work.items.flatMap((item) => item.gaps.map((g) => [g.userId, { userId: g.userId, akVersion: g.akVersion, hpkePublicKey: fromText(g.hpkePublicKey) }] as const)));
        const vouched = await keyLog.vouchedRecoveryAccounts(userId, [...served.values()]);
        const envelopes: Array<{ channelId: string; epoch: string; recipient: string; envelope: string }> = [];
        for (const item of work.items) {
            const gaps = item.gaps.filter((g) => vouched.has(g.userId));
            if (!gaps.length) continue;
            const epoch = BigInt(item.epoch);
            let historyKey: Uint8Array;
            try {
                historyKey = await content.openHistoryKey(opened.privateKey, fromText(item.envelope), { recipient, conversationId: item.channelId, epoch });
            } catch (caught) {
                console.error("polaris: a history key sealed to the recovery key did not open:", caught);
                continue;
            }
            try {
                for (const gap of gaps) {
                    const copy = await content.sealHistoryKey(served.get(gap.userId)!.hpkePublicKey, historyKey, { recipient: gap.userId, conversationId: item.channelId, epoch });
                    envelopes.push({ channelId: item.channelId, epoch: item.epoch, recipient: gap.userId, envelope: toText(copy) });
                }
            } finally {
                historyKey.fill(0);
            }
        }
        for (let at = 0; at < envelopes.length; at += 200) {
            const answer = await post<{ stored: number }>({ op: "recovery-key-seal", openingId: opening.id, envelopes: envelopes.slice(at, at + 200) });
            if (!answer) return null;
            sealed += answer.stored;
        }
        if (!work.next) {
            await post({ op: "recovery-key-complete", openingId: opening.id });
            await stored("delete", openingSlot(opening.id)).catch(() => undefined);
            return sealed;
        }
        after = work.next;
    }
    // Left open: the next refresh carries on from the start, skipping what is already sealed.
    return sealed;
}

export function ownRequest(): Promise<OwnRequest | null> {
    return post<OwnRequest>({ op: "recovery-own" });
}

export async function custodianInbox(): Promise<InboxItem[]> {
    return (await post<{ requests: InboxItem[] }>({ op: "recovery-inbox" }))?.requests ?? [];
}

/** The code a custodian compares with the person before approving. */
export function codeOf(requestId: string, requesterKey: string): Promise<string> {
    return recovery.requestCode(requestId, fromText(requesterKey));
}

/** Approve as a custodian: open the share with this browser's account key and seal it to the request. */
export async function approve(
    custodianId: string,
    item: InboxItem,
    accountHpke: () => Promise<{ hpkePrivateKey: CryptoKey } | null>
): Promise<boolean> {
    const own = await accountHpke();
    if (!own) return false;
    const share = await recovery.openShare(
        own.hpkePrivateKey,
        fromText(item.envelope),
        { ownerId: item.ownerId, akVersion: item.akVersion, splitId: item.splitId },
        custodianId,
        item.custodianAkVersion
    );
    try {
        const envelope = await recovery.releaseShare(
            fromText(item.requesterKey),
            share,
            { requestId: item.id, ownerId: item.ownerId, akVersion: item.akVersion },
            custodianId
        );
        return (await post({ op: "recovery-approve", requestId: item.id, envelope: toText(envelope) })) !== null;
    } finally {
        share.fill(0);
    }
}

/** Decline as a custodian: the share is never opened. */
export async function decline(item: InboxItem): Promise<boolean> {
    return (await post({ op: "recovery-decline", requestId: item.id })) !== null;
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
    });
}

async function stored(op: "get" | "put" | "delete", key: string, value?: unknown): Promise<unknown> {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const store = db.transaction(STORE, op === "get" ? "readonly" : "readwrite").objectStore(STORE);
            const request = op === "get" ? store.get(key) : op === "put" ? store.put(value, key) : store.delete(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

/** Raise a request from this browser. Answers the code to show, or null when refused. */
export async function startRequest(userId: string): Promise<{ requestId: string; code: string } | null> {
    const pair = await recovery.requesterKeyPair();
    const answer = await post<{ requestId: string }>({ op: "recovery-open", requesterKey: toText(pair.publicKey) });
    if (!answer) return null;
    await stored("put", userId, { requestId: answer.requestId, privateKey: pair.privateKey });
    return { requestId: answer.requestId, code: await recovery.requestCode(answer.requestId, pair.publicKey) };
}

/** Whether this browser raised the open request (and so can finish it). */
export async function heldRequest(userId: string): Promise<string | null> {
    const held = (await stored("get", userId).catch(() => null)) as { requestId: string } | null;
    return held?.requestId ?? null;
}

/**
 * Once the quorum is met: combine the released shares into the account key and
 * hand it to `adopt`, which checks it against the account's published keys and
 * keeps it on this device. Only then is the request closed.
 */
export async function finishRequest(
    userId: string,
    own: OwnRequest,
    adopt: (accountKey: Uint8Array, akVersion: number) => Promise<boolean>
): Promise<boolean> {
    const request = own.request;
    if (!request || request.status !== "released") return false;
    const held = (await stored("get", userId)) as { requestId: string; privateKey: CryptoKey } | undefined;
    if (!held || held.requestId !== request.id) return false;
    const accountKey = await recovery.recoverAccountKey(
        held.privateKey,
        request.released.map((r) => ({ custodianId: r.custodianId, envelope: fromText(r.envelope) })),
        { requestId: request.id, ownerId: userId, akVersion: request.akVersion }
    );
    try {
        if (!(await adopt(accountKey, request.akVersion))) return false;
    } finally {
        accountKey.fill(0);
    }
    await post({ op: "recovery-complete", requestId: request.id });
    await stored("delete", userId).catch(() => undefined);
    return true;
}
