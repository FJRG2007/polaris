/**
 * Quorum recovery of an account key (design 3.1/3.2, owner decisions 1-2): the
 * last way back to a history when the password is forgotten and every device is
 * gone.
 *
 * Each account's own browser splits its `AK` M of N with Shamir and seals one
 * share to each custodian's account key (hybrid HPKE, X25519 + ML-KEM-768, the
 * envelope every stored key here uses). The server stores N envelopes it cannot
 * open. To recover, the requester's new browser makes a one-off X-Wing pair and
 * publishes its public half on a request; each custodian who approves opens
 * their share and seals it again to that key; with M of them the requester's
 * browser combines `AK` and checks it against the account's published keys.
 *
 * Nobody but the account ever holds its whole `AK`: not the server, not a
 * custodian, not the last approver. That is why the split is per account rather
 * than one organisation key whose private half would have to be rebuilt in some
 * browser on every recovery, handing that browser every account at once.
 *
 * What the server could still try is to swap the requester's public key for its
 * own. The request code - 12 digits from the request id and that key - is shown
 * on the requester's screen and in the custodian's approval, and the custodian
 * compares it with the person before approving (Apple's recovery contact reads a
 * code the same way).
 */

import * as shamir from "./shamir";
import { canonical, owned } from "./bytes";
import { XWing } from "@hpke/hybridkem-x-wing";
import { ACCOUNT_KEY_BYTES } from "./account-key";
import { openHybrid, sealHybrid } from "./hybrid-envelope";

const SHARE_PURPOSE = "recovery-share";
const RELEASE_PURPOSE = "recovery-release";
const CODE_LABEL = "polaris/chat-e2ee/recovery/v1/code";

export interface Custodian {
    readonly userId: string;
    readonly akVersion: number;
    /** The custodian account's X-Wing public key, checked against the key log by the caller. */
    readonly hpkePublicKey: Uint8Array;
}

/** What one share is bound to: whose key, which version, which split, which custodian. */
export interface ShareBinding {
    readonly ownerId: string;
    readonly akVersion: number;
    readonly splitId: string;
}

export interface SealedShare {
    readonly custodianId: string;
    readonly custodianAkVersion: number;
    readonly envelope: Uint8Array;
}

function shareInfo(binding: ShareBinding, custodianId: string, custodianAkVersion: number): Array<string | number> {
    return [binding.ownerId, binding.akVersion, binding.splitId, custodianId, custodianAkVersion];
}

/** Split `AK` `threshold` of `custodians.length`, one envelope per custodian. */
export async function splitAccountKey(
    accountKey: Uint8Array,
    custodians: ReadonlyArray<Custodian>,
    threshold: number,
    binding: ShareBinding
): Promise<SealedShare[]> {
    if (accountKey.length !== ACCOUNT_KEY_BYTES) throw new RangeError("An account key is 32 bytes");
    if (new Set(custodians.map((custodian) => custodian.userId)).size !== custodians.length)
        throw new RangeError("A custodian holds one share");
    if (custodians.some((custodian) => custodian.userId === binding.ownerId))
        throw new RangeError("An account is never its own custodian");
    const shares = await shamir.split(accountKey, custodians.length, threshold);
    try {
        return await Promise.all(
            custodians.map(async (custodian, index) => ({
                custodianId: custodian.userId,
                custodianAkVersion: custodian.akVersion,
                envelope: await sealHybrid(
                    custodian.hpkePublicKey,
                    shares[index]!,
                    SHARE_PURPOSE,
                    shareInfo(binding, custodian.userId, custodian.akVersion)
                )
            }))
        );
    } finally {
        for (const share of shares) share.fill(0);
    }
}

/** A custodian opens the share an account sealed to them. */
export function openShare(
    custodianPrivateKey: CryptoKey,
    envelope: Uint8Array,
    binding: ShareBinding,
    custodianId: string,
    custodianAkVersion: number
): Promise<Uint8Array> {
    return openHybrid(custodianPrivateKey, envelope, SHARE_PURPOSE, shareInfo(binding, custodianId, custodianAkVersion));
}

/** What a released share is bound to: the one request and the one account. */
export interface ReleaseBinding {
    readonly requestId: string;
    readonly ownerId: string;
    readonly akVersion: number;
}

function releaseInfo(binding: ReleaseBinding, custodianId: string): Array<string | number> {
    return [binding.requestId, binding.ownerId, binding.akVersion, custodianId];
}

/** The requester's one-off pair. The private half never leaves the tab. */
export async function requesterKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
    const kem = new XWing();
    const pair = await kem.generateKeyPair();
    return { privateKey: pair.privateKey, publicKey: new Uint8Array(await kem.serializePublicKey(pair.publicKey)) };
}

/** A custodian seals their opened share to the requester's key. */
export function releaseShare(
    requesterPublicKey: Uint8Array,
    share: Uint8Array,
    binding: ReleaseBinding,
    custodianId: string
): Promise<Uint8Array> {
    return sealHybrid(requesterPublicKey, share, RELEASE_PURPOSE, releaseInfo(binding, custodianId));
}

/** The requester opens the released shares and combines them into `AK`. */
export async function recoverAccountKey(
    requesterPrivateKey: CryptoKey,
    released: ReadonlyArray<{ custodianId: string; envelope: Uint8Array }>,
    binding: ReleaseBinding
): Promise<Uint8Array> {
    const shares = await Promise.all(
        released.map((item) =>
            openHybrid(requesterPrivateKey, item.envelope, RELEASE_PURPOSE, releaseInfo(binding, item.custodianId))
        )
    );
    try {
        const accountKey = await shamir.combine(shares);
        if (accountKey.length !== ACCOUNT_KEY_BYTES) throw new RangeError("Not an account key");
        return accountKey;
    } finally {
        for (const share of shares) share.fill(0);
    }
}

/** 12 digits from the request and the requester's key, in three groups of four. */
export async function requestCode(requestId: string, requesterPublicKey: Uint8Array): Promise<string> {
    const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", owned(canonical(CODE_LABEL, requestId, requesterPublicKey)))
    );
    const groups: string[] = [];
    for (let group = 0; group < 3; group++) {
        const view = new DataView(digest.buffer, group * 5, 5);
        const value = view.getUint32(0) * 256 + view.getUint8(4);
        groups.push(String(value % 10000).padStart(4, "0"));
    }
    return groups.join(" ");
}

const ORK_LABEL = "polaris/chat-e2ee/ork/v1/hpke-xwing";

/**
 * The organisation recovery key (`ORK`): an X-Wing pair derived from a 32-byte
 * seed, the seed split to the custodians like an account key (owner id
 * `ork:<id>`). It is only what history is sealed to for members who have no
 * account key yet (the legacy migration, design 8.4); an account's own key is
 * never sealed to it, for the reason at the top of this file.
 */
export async function recoveryKeyPair(seed: Uint8Array): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
    if (seed.length !== ACCOUNT_KEY_BYTES) throw new RangeError("A recovery key seed is 32 bytes");
    const base = await crypto.subtle.importKey("raw", owned(seed), "HKDF", false, ["deriveBits"]);
    const ikm = new Uint8Array(
        await crypto.subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: owned(canonical(ORK_LABEL)) },
            base,
            256
        )
    );
    try {
        const kem = new XWing();
        const pair = await kem.deriveKeyPair(owned(ikm));
        return { privateKey: pair.privateKey, publicKey: new Uint8Array(await kem.serializePublicKey(pair.publicKey)) };
    } finally {
        ikm.fill(0);
    }
}
