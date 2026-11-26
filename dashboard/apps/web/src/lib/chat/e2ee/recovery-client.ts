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
