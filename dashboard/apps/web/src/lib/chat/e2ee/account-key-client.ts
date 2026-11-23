/**
 * The browser half of the account key's life after a sign-in (docs/chat-e2ee-
 * phase1.md): create `AK` for an account that has none, open it from whichever
 * lock the sign-in produced, keep it behind this browser's device lock, and
 * seal the locks that are missing or stale - the passkey PRF lock after a
 * passkey sign-in, the password lock after a password sign-in (which is also
 * what re-seals it after a password reset).
 *
 * Only ever loaded by screens the server rendered with the internal flag on.
 * Nothing here can fail a sign-in or show anything: every function swallows
 * its failures and returns false/null, and the account simply has one lock
 * fewer until the next sign-in tries again.
 *
 * Every `AK` this module obtains - from a lock, from the device store, from a
 * QR approval - is checked against the account's published public keys before
 * it is kept or sealed under another lock, so a stale device copy or an
 * envelope the server swapped never spreads.
 */

import * as qr from "@polaris/chat-crypto/qr-approval";
import { fromText, toText } from "@/lib/chat/e2ee/base64url";
import type { KeysBody } from "@/lib/chat/e2ee/schemas";
import * as account from "@polaris/chat-crypto/account-key";
import * as deviceLock from "@polaris/chat-crypto/device-lock";
import * as passkeyLock from "@polaris/chat-crypto/passkey-lock";
import { LOCK_ENVELOPE_BYTES } from "@polaris/chat-crypto/locks";
import * as passwordLock from "@polaris/chat-crypto/password-lock";
import * as passwordWorker from "@/lib/chat/e2ee/password-worker-client";
import { platformSealedStore } from "@polaris/chat-crypto/platform-store";
import { platformKeyWrap } from "@/lib/chat/e2ee/platform-key-wrap";

const ROUTE = "/api/e2ee/keys";
/** The first key version of an account. Rotation is a later phase. */
const FIRST_VERSION = 1;

/** What `/api/e2ee/keys` answers to `state`. */
export interface KeyState {
    readonly userId: string;
    readonly accountKey: {
        readonly akVersion: number;
        readonly signPublicKey: string;
        readonly hpkePublicKey: string;
        readonly hasPasswordLock: boolean;
        readonly passkeyLocks: ReadonlyArray<{ lockId: string; akVersion: number; envelope: string }>;
    } | null;
    readonly adopted: boolean;
    /** Absent from a host that predates the password flows over OPAQUE. */
    readonly identity?: { readonly name: string | null; readonly email: string | null };
}

interface HeldKey {
    readonly accountKey: Uint8Array;
    readonly akVersion: number;
}


async function post<T>(body: KeysBody): Promise<{ status: number; data: T | null }> {
    try {
        const response = await fetch(ROUTE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify(body)
        });
        return { status: response.status, data: response.ok ? ((await response.json()) as T) : null };
    } catch {
        return { status: 0, data: null };
    }
}

export async function keyState(): Promise<KeyState | null> {
    return (await post<KeyState>({ op: "state" })).data;
}

function publishedOf(state: KeyState): account.AccountPublicKeys | null {
    if (!state.accountKey) return null;
    return {
        signPublicKey: fromText(state.accountKey.signPublicKey),
        hpkePublicKey: fromText(state.accountKey.hpkePublicKey)
    };
}

/** Whether `held` is the key the account published, at the published version. */
async function isPublished(state: KeyState, held: HeldKey): Promise<boolean> {
    const published = publishedOf(state);
    if (!published || state.accountKey?.akVersion !== held.akVersion) return false;
    return account.samePublicKeys(published, await account.accountPublicKeys(held.accountKey));
}

/**
 * The phase 1 `AccountKeyVerifier`: the account's keys as the server publishes
 * them, read with the session the sign-in just issued.
 *
 * enigma: phase 3 swaps this for the key transparency log (design 4.6). Until
 * then a server that lies consistently - publishing the key it forged - is not
 * caught here; every other substitution (a stale or swapped envelope, a relay
 * that changed bytes, another account's key) is.
 */
export function publishedKeyVerifier(): account.AccountKeyVerifier {
    return {
        async verify(userId, akVersion, keys) {
            const state = await keyState();
            const published = state ? publishedOf(state) : null;
            if (!state || !published || state.userId !== userId) return false;
            return state.accountKey?.akVersion === akVersion && account.samePublicKeys(published, keys);
        }
    };
}

/**
 * This device's lock store: IndexedDB, with the envelope sealed by the
 * operating system's key store when a Polaris app offers one.
 */
export function deviceStore(): deviceLock.DeviceLockStore {
    const inner = deviceLock.indexedDbDeviceLockStore();
    const wrap = platformKeyWrap();
    return wrap ? platformSealedStore(inner, wrap) : inner;
}

/**
 * The account key's HPKE pair from this browser's own lock, for the MLS
 * device to seal and open history keys with; null when this browser holds no
 * copy of the account's published key. The key itself is not kept.
 */
export async function deviceAccountHpke(): Promise<{ hpkePublicKey: Uint8Array; hpkePrivateKey: CryptoKey } | null> {
    const state = await keyState();
    const held = state ? await fromDevice(state) : null;
    if (!held) return null;
    try {
        const [published, pair] = await Promise.all([account.accountPublicKeys(held.accountKey), account.accountHpkeKeyPair(held.accountKey)]);
        return { hpkePublicKey: published.hpkePublicKey, hpkePrivateKey: pair.privateKey };
    } finally {
        held.accountKey.fill(0);
    }
}

async function keepOnDevice(userId: string, held: HeldKey): Promise<void> {
    await deviceLock.createDeviceLock(deviceStore(), userId, held.accountKey, held.akVersion);
}

/** This browser's copy, only when it is still the account's published key. */
async function fromDevice(state: KeyState): Promise<HeldKey | null> {
    try {
        const held = await deviceLock.openDeviceLock(deviceStore(), state.userId);
        if (!held) return null;
        if (await isPublished(state, held)) return held;
        held.accountKey.fill(0);
        return null;
    } catch {
        return null;
    }
}

/**
 * A first key for an account that has none. Two sign-ins racing both get here;
 * the server keeps exactly one key per account, and the one whose publish was
 * refused discards its key without sealing a single lock under it.
 */
async function createFirstKey(): Promise<HeldKey | null> {
    const accountKey = account.generateAccountKey();
    const keys = await account.accountPublicKeys(accountKey);
    const created = await post<{ created: boolean }>({
        op: "create-account-key",
        akVersion: FIRST_VERSION,
        signPublicKey: toText(keys.signPublicKey),
        hpkePublicKey: toText(keys.hpkePublicKey)
    });
    if (created.data?.created === true) return { accountKey, akVersion: FIRST_VERSION };
    accountKey.fill(0);
    return null;
}

/** The key this browser can reach without a new lock: its device copy, or a
 *  brand-new one when the account has none at all. */
async function reachableKey(state: KeyState): Promise<HeldKey | null> {
    if (!state.accountKey) {
        const created = await createFirstKey();
        if (created) await keepOnDevice(state.userId, created);
        return created;
    }
    return fromDevice(state);
}

/**
 * After a passkey sign-in that returned PRF output: open `AK` from this
 * passkey's lock, or seal that lock when it does not exist yet (creating `AK`
 * first when the account has none). A passkey without PRF never gets here.
 */
export async function settleAfterPasskey(credentialId: string, prfOutput: Uint8Array): Promise<boolean> {
    let held: HeldKey | null = null;
    try {
        const state = await keyState();
        if (!state) return false;
        const lock = state.accountKey?.passkeyLocks.find(
            (entry) => entry.lockId === credentialId && entry.akVersion === state.accountKey?.akVersion
        );
        if (lock) {
            const envelope = fromText(lock.envelope);
            if (envelope.length !== LOCK_ENVELOPE_BYTES) return false;
            const accountKey = await passkeyLock.openWithPasskey(
                envelope,
                prfOutput,
                state.userId,
                credentialId,
                lock.akVersion
            );
            held = { accountKey, akVersion: lock.akVersion };
            if (!(await isPublished(state, held))) return false;
            await keepOnDevice(state.userId, held);
            return true;
        }
        held = await reachableKey(state);
        if (!held) return false;
        const envelope = await passkeyLock.sealWithPasskey(
            held.accountKey,
            prfOutput,
            state.userId,
            credentialId,
            held.akVersion
        );
        const stored = await post<{ stored: boolean }>({
            op: "put-passkey-lock",
            lockId: credentialId,
            akVersion: held.akVersion,
            envelope: toText(envelope)
        });
        return stored.data?.stored === true;
    } catch {
        return false;
    } finally {
        held?.accountKey.fill(0);
        prfOutput.fill(0);
    }
}

interface ReleasedLock {
    readonly akVersion: number;
    readonly envelope: string;
}

/**
 * After a password sign-in that ended in a full session, on the page still
 * holding the password: open `AK` from the released password envelope, or -
 * when there is none, or it no longer opens because the password was reset -
 * take the key this browser can reach (creating the account's first one when
 * it has none) and seal a password lock for it through the OPAQUE unlock, the
 * only path that may write that envelope.
 */
export async function settleAfterPassword(
    password: string,
    released: { lockKey: CryptoKey; userId: string; lock: ReleasedLock | null } | null
): Promise<boolean> {
    let held: HeldKey | null = null;
    try {
        const state = await keyState();
        if (!state || !state.adopted) return false;
        if (released && released.userId === state.userId && released.lock) {
            const opened = await openReleased(state, released.lockKey, released.lock);
            if (opened) {
                held = opened;
                await keepOnDevice(state.userId, opened);
                return true;
            }
        }
        // No envelope came with this sign-in (an adoption, or a sign-in that
        // owed a second factor first): ask for it through a fresh OPAQUE
        // unlock, the only read that releases it, before deciding to seal.
        if (!released?.lock && state.accountKey?.hasPasswordLock) {
            const opened = await openWithUnlock(password, state);
            if (opened) {
                held = opened;
                await keepOnDevice(state.userId, opened);
                return true;
            }
        }
        held = await reachableKey(state);
        if (!held) return false;
        return await sealPasswordLock(password, held);
    } catch {
        return false;
    } finally {
        held?.accountKey.fill(0);
    }
}

/** The password envelope through an OPAQUE unlock that writes nothing. */
async function openWithUnlock(password: string, state: KeyState): Promise<HeldKey | null> {
    const login = await passwordWorker.startPasswordLogin(password);
    const step = await post<{
        loginId: string;
        loginResponse: string;
        userId: string;
        ksfVersion?: passwordLock.PasswordKsfVersion;
    }>({
        op: "unlock-start",
        startLoginRequest: login.startLoginRequest
    });
    if (!step.data || step.data.userId !== state.userId) return null;
    const finished = await passwordWorker.finishPasswordLogin({
        state: login.state,
        loginResponse: step.data.loginResponse,
        password,
        userId: step.data.userId,
        ksfVersion: step.data.ksfVersion
    });
    const done = await post<{ passwordLock: ReleasedLock | null }>({
        op: "unlock-finish",
        loginId: step.data.loginId,
        finishLoginRequest: finished.finishLoginRequest
    });
    if (!done.data?.passwordLock) return null;
    return openReleased(state, finished.lockKey, done.data.passwordLock);
}

async function openReleased(state: KeyState, lockKey: CryptoKey, lock: ReleasedLock): Promise<HeldKey | null> {
    try {
        const envelope = fromText(lock.envelope);
        if (envelope.length !== LOCK_ENVELOPE_BYTES) return null;
        const accountKey = await passwordLock.openWithPassword(envelope, lockKey, state.userId, lock.akVersion);
        const held = { accountKey, akVersion: lock.akVersion };
        if (await isPublished(state, held)) return held;
        accountKey.fill(0);
        return null;
    } catch {
        return null;
    }
}

async function sealPasswordLock(password: string, held: HeldKey): Promise<boolean> {
    const login = await passwordWorker.startPasswordLogin(password);
    const step = await post<{
        loginId: string;
        loginResponse: string;
        userId: string;
        ksfVersion?: passwordLock.PasswordKsfVersion;
    }>({
        op: "unlock-start",
        startLoginRequest: login.startLoginRequest
    });
    if (!step.data) return false;
    const finished = await passwordWorker.finishPasswordLogin({
        state: login.state,
        loginResponse: step.data.loginResponse,
        password,
        userId: step.data.userId,
        ksfVersion: step.data.ksfVersion
    });
    const envelope = await passwordLock.sealWithPassword(
        held.accountKey,
        finished.lockKey,
        step.data.userId,
        held.akVersion
    );
    const done = await post<{ passwordLock: ReleasedLock | null }>({
        op: "unlock-finish",
        loginId: step.data.loginId,
        finishLoginRequest: finished.finishLoginRequest,
        passwordLock: { akVersion: held.akVersion, envelope: toText(envelope) }
    });
    return done.data?.passwordLock?.envelope === toText(envelope);
}

/** The new browser's side of a QR sign-in: an offer for one flow. */
export async function createKeyOffer(): Promise<{ offer: qr.QrOffer; text: string }> {
    const offer = await qr.createQrOffer();
    return { offer, text: toText(offer.publicKey) };
}

/** The QR's link for a flow: the code's address plus the offer's fragment. */
export async function offerLink(url: string, flowId: string, offer: qr.QrOffer): Promise<string> {
    return `${url}${await qr.offerFragment(flowId, offer)}`;
}

/** The new browser, once approved: open, verify and keep what was sealed for it. */
export async function acceptKeyDelivery(
    offer: qr.QrOffer,
    delivery: { userId: string; flowId: string; transfer: Parameters<typeof qr.decodeQrApproval>[0] }
): Promise<boolean> {
    let held: HeldKey | null = null;
    try {
        held = await qr.openQrApproval({
            offer,
            flowId: delivery.flowId,
            userId: delivery.userId,
            approval: qr.decodeQrApproval(delivery.transfer),
            verifier: publishedKeyVerifier()
        });
        await keepOnDevice(delivery.userId, held);
        return true;
    } catch {
        return false;
    } finally {
        held?.accountKey.fill(0);
    }
}

/**
 * The approving device: seal this browser's `AK` for the device that showed
 * the QR. Null - and the approval goes ahead without it - when this browser
 * holds no key, the key is not the published one, or the server's copy of the
 * offer does not match what the QR committed to.
 */
export async function sealForScannedCode(input: {
    approverDeviceId: string;
    flowId: string;
    keyOffer: string;
    fragment: string;
}): Promise<ReturnType<typeof qr.encodeQrApproval> | null> {
    let held: HeldKey | null = null;
    try {
        const scanned = qr.readOfferFragment(input.fragment);
        if (!scanned) return null;
        const state = await keyState();
        if (!state) return null;
        held = await fromDevice(state);
        if (!held) return null;
        const approval = await qr.sealQrApproval({
            accountKey: held.accountKey,
            akVersion: held.akVersion,
            userId: state.userId,
            flowId: input.flowId,
            approverDeviceId: input.approverDeviceId,
            offerPublicKey: fromText(input.keyOffer),
            scanned
        });
        return qr.encodeQrApproval(approval);
    } catch {
        return null;
    } finally {
        held?.accountKey.fill(0);
    }
}
