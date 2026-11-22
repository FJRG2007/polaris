/**
 * The account key carried through the QR sign-in (design 3.2, "approval from
 * another device"; docs/chat-e2ee-phase1.md, "QR approval carries AK").
 *
 * The browser being signed in (the new device) makes an ephemeral X-Wing pair
 * for this one flow. Its public key is too large for a QR a phone can read off
 * a screen (1216 bytes), so the key travels to the server with the code and the
 * QR carries a commitment to it instead:
 *
 *     commitment = SHA-256(canonical(label/commit, flowId, newDeviceId, publicKey))
 *
 * The commitment and the new device's id ride in the link's fragment, which a
 * browser never sends to a server. The approving device fetches the public key
 * from the server, recomputes the commitment from what it scanned, and seals
 * `AK` only to a key that matches - so the server, which relays the key, cannot
 * swap in its own.
 *
 *     envelope  = hybrid-envelope(purpose "qr-approval",
 *                                 binding = flowId, newDeviceId, approverDeviceId)
 *                 over  version(1) || akVersion(4) || AK(32)
 *     signature = Ed25519 under AK's signing key over
 *                 canonical(label/sign, userId, akVersion, flowId, newDeviceId,
 *                           approverDeviceId, commitment, SHA-256(envelope))
 *
 * The signature answers 11.1 item 17 (key-compromise impersonation, Threema
 * 2023 attack 1): the channel is authenticated by the account's long-term key,
 * not only by the ephemeral one. Because the server knows the ephemeral public
 * key, it could seal a key of its own making and sign it with that same key;
 * only checking the derived public key against an independent record of the
 * account's key closes that, which is what `AccountKeyVerifier` is for. Opening
 * refuses without a verifier's yes - there is no path that skips the check.
 */

import { XWing } from "@hpke/hybridkem-x-wing";
import { openHybrid, sealHybrid } from "./hybrid-envelope";
import { canonical, fromBase64Url, owned, randomBytes, toBase64Url } from "./bytes";
import {
    ACCOUNT_KEY_BYTES,
    accountPublicKeys,
    accountSigningKeyPair,
    type AccountKeyVerifier
} from "./account-key";

export const QR_APPROVAL_PURPOSE = "qr-approval";
export const QR_APPROVAL_VERSION = 1;
/** A serialized X-Wing public key: ML-KEM-768 (1184) + X25519 (32). */
export const QR_OFFER_PUBLIC_KEY_BYTES = 1216;
const DEVICE_ID_BYTES = 16;
const SIGNATURE_BYTES = 64;
const PLAINTEXT_BYTES = 1 + 4 + ACCOUNT_KEY_BYTES;

const COMMIT_LABEL = "polaris/chat-e2ee/qr-approval/v1/commit";
const SIGN_LABEL = "polaris/chat-e2ee/qr-approval/v1/sign";

/** The fragment the QR's link carries: `k=<commitment>.<newDeviceId>`. */
const FRAGMENT = /^#?k=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22})$/;

/** One coarse error for every way an approval can fail to open or verify. */
export class QrApprovalError extends Error {
    constructor() {
        super("The approval could not be accepted");
        this.name = "QrApprovalError";
    }
}

/** What the new device keeps in memory for the length of one flow. */
export interface QrOffer {
    readonly privateKey: CryptoKey;
    readonly publicKey: Uint8Array;
    readonly newDeviceId: string;
}

/** What the approving device sends back through the server. */
export interface QrApproval {
    readonly akVersion: number;
    readonly approverDeviceId: string;
    readonly envelope: Uint8Array;
    readonly signature: Uint8Array;
}

/** A fresh ephemeral pair and device id for one flow. Never reused. */
export async function createQrOffer(): Promise<QrOffer> {
    const kem = new XWing();
    const pair = await kem.generateKeyPair();
    const publicKey = new Uint8Array(await kem.serializePublicKey(pair.publicKey));
    return { privateKey: pair.privateKey, publicKey, newDeviceId: toBase64Url(randomBytes(DEVICE_ID_BYTES)) };
}

function requireId(value: string): string {
    if (!value) throw new QrApprovalError();
    return value;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", owned(value)));
}

export async function offerCommitment(
    flowId: string,
    newDeviceId: string,
    publicKey: Uint8Array
): Promise<Uint8Array> {
    if (publicKey.length !== QR_OFFER_PUBLIC_KEY_BYTES) throw new QrApprovalError();
    return sha256(canonical(COMMIT_LABEL, requireId(flowId), requireId(newDeviceId), publicKey));
}

/** The link fragment for a flow: what the QR adds to the code's address. */
export async function offerFragment(flowId: string, offer: QrOffer): Promise<string> {
    const commitment = await offerCommitment(flowId, offer.newDeviceId, offer.publicKey);
    return `#k=${toBase64Url(commitment)}.${offer.newDeviceId}`;
}

/** The commitment and device id out of a scanned fragment, or null. */
export function readOfferFragment(fragment: string): { commitment: Uint8Array; newDeviceId: string } | null {
    const match = FRAGMENT.exec(fragment);
    if (!match) return null;
    try {
        return { commitment: fromBase64Url(match[1]!), newDeviceId: match[2]! };
    } catch {
        return null;
    }
}

/** Equal lengths and every byte equal. The values compared are public digests. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
    return difference === 0;
}

async function transcript(input: {
    userId: string;
    akVersion: number;
    flowId: string;
    newDeviceId: string;
    approverDeviceId: string;
    commitment: Uint8Array;
    envelope: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
    return owned(
        canonical(
            SIGN_LABEL,
            requireId(input.userId),
            input.akVersion,
            requireId(input.flowId),
            requireId(input.newDeviceId),
            requireId(input.approverDeviceId),
            input.commitment,
            await sha256(input.envelope)
        )
    );
}

function bindingOf(flowId: string, newDeviceId: string, approverDeviceId: string): string[] {
    return [requireId(flowId), requireId(newDeviceId), requireId(approverDeviceId)];
}

/**
 * Seal `AK` for the new device, on the approving device. Refuses - and seals
 * nothing - when the server's copy of the public key does not match what the
 * QR committed to.
 */
export async function sealQrApproval(input: {
    accountKey: Uint8Array;
    akVersion: number;
    userId: string;
    flowId: string;
    approverDeviceId: string;
    offerPublicKey: Uint8Array;
    scanned: { commitment: Uint8Array; newDeviceId: string };
}): Promise<QrApproval> {
    if (input.accountKey.length !== ACCOUNT_KEY_BYTES) throw new QrApprovalError();
    const expected = await offerCommitment(input.flowId, input.scanned.newDeviceId, input.offerPublicKey);
    if (!sameBytes(expected, input.scanned.commitment)) throw new QrApprovalError();
    const plaintext = new Uint8Array(PLAINTEXT_BYTES);
    plaintext[0] = QR_APPROVAL_VERSION;
    new DataView(plaintext.buffer).setUint32(1, input.akVersion);
    plaintext.set(input.accountKey, 5);
    try {
        const envelope = await sealHybrid(
            input.offerPublicKey,
            plaintext,
            QR_APPROVAL_PURPOSE,
            bindingOf(input.flowId, input.scanned.newDeviceId, input.approverDeviceId)
        );
        const { privateKey } = await accountSigningKeyPair(input.accountKey);
        const message = await transcript({
            userId: input.userId,
            akVersion: input.akVersion,
            flowId: input.flowId,
            newDeviceId: input.scanned.newDeviceId,
            approverDeviceId: input.approverDeviceId,
            commitment: expected,
            envelope
        });
        const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, message));
        return { akVersion: input.akVersion, approverDeviceId: input.approverDeviceId, envelope, signature };
    } finally {
        plaintext.fill(0);
    }
}

/**
 * Open an approval on the new device: the envelope under this flow's binding,
 * the signature under the signing key derived from the `AK` inside, and that
 * key against the verifier. Any failure is one QrApprovalError and no key.
 */
export async function openQrApproval(input: {
    offer: QrOffer;
    flowId: string;
    userId: string;
    approval: QrApproval;
    verifier: AccountKeyVerifier;
}): Promise<{ accountKey: Uint8Array; akVersion: number }> {
    const { approval, offer } = input;
    if (approval.signature.length !== SIGNATURE_BYTES) throw new QrApprovalError();
    let plaintext: Uint8Array;
    try {
        plaintext = await openHybrid(
            offer.privateKey,
            approval.envelope,
            QR_APPROVAL_PURPOSE,
            bindingOf(input.flowId, offer.newDeviceId, approval.approverDeviceId)
        );
    } catch {
        throw new QrApprovalError();
    }
    const accountKey = plaintext.slice(5);
    try {
        const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
        if (plaintext.length !== PLAINTEXT_BYTES || plaintext[0] !== QR_APPROVAL_VERSION)
            throw new QrApprovalError();
        if (view.getUint32(1) !== approval.akVersion) throw new QrApprovalError();
        const commitment = await offerCommitment(input.flowId, offer.newDeviceId, offer.publicKey);
        const message = await transcript({
            userId: input.userId,
            akVersion: approval.akVersion,
            flowId: input.flowId,
            newDeviceId: offer.newDeviceId,
            approverDeviceId: approval.approverDeviceId,
            commitment,
            envelope: approval.envelope
        });
        const published = await accountPublicKeys(accountKey);
        const verifyKey = await crypto.subtle.importKey(
            "raw",
            owned(published.signPublicKey),
            "Ed25519",
            false,
            ["verify"]
        );
        const signed = await crypto.subtle.verify("Ed25519", verifyKey, owned(approval.signature), message);
        if (!signed) throw new QrApprovalError();
        // enigma: phase 3 replaces the server-published key behind this
        // interface with the key transparency log (design 4.6). Never skipped:
        // anything but an explicit true refuses.
        const vouched = await input.verifier
            .verify(input.userId, approval.akVersion, published)
            .catch(() => false);
        if (vouched !== true) throw new QrApprovalError();
        return { accountKey, akVersion: approval.akVersion };
    } catch {
        accountKey.fill(0);
        throw new QrApprovalError();
    } finally {
        plaintext.fill(0);
    }
}

/** An approval as it travels: base64url fields, sizes checked on the way in. */
export function encodeQrApproval(approval: QrApproval): {
    akVersion: number;
    approverDeviceId: string;
    envelope: string;
    signature: string;
} {
    return {
        akVersion: approval.akVersion,
        approverDeviceId: approval.approverDeviceId,
        envelope: toBase64Url(approval.envelope),
        signature: toBase64Url(approval.signature)
    };
}

export function decodeQrApproval(value: {
    akVersion: number;
    approverDeviceId: string;
    envelope: string;
    signature: string;
}): QrApproval {
    try {
        return {
            akVersion: value.akVersion,
            approverDeviceId: value.approverDeviceId,
            envelope: fromBase64Url(value.envelope),
            signature: fromBase64Url(value.signature)
        };
    } catch {
        throw new QrApprovalError();
    }
}
