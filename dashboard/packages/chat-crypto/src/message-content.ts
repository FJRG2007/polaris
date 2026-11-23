/**
 * The content layer over MLS (docs/chat-e2ee-proposal.md 4.2 items 3-4,
 * docs/chat-e2ee-mls.md): one ciphertext per message under a key derived from
 * the conversation's history key `HK(c, e)`, so a device that joins later can
 * read the past once it holds `HK` - which MLS alone cannot give it.
 *
 *     K, nonce = HKDF-SHA256(HK, salt = empty,
 *                            info = canonical(LABEL, "message", conversation, epoch, messageId, sender))
 *     sealed   = version(1) || AES-256-GCM(K, nonce, plaintext, aad = version || info)
 *
 * Key and nonce both come from the derivation (11.1 item 1: no bare random
 * nonce), and the derivation is unique per message because `messageId` is the
 * sending device's own random id (the send's `clientKey`). Everything the
 * message is bound to - conversation, epoch, message, sender leaf - is in the
 * info and the AAD (11.1 item 2), so a ciphertext moved to another message,
 * conversation, epoch or sender does not open.
 *
 * `HK` travels to the group's devices as an MLS application message, and to
 * each member account (history for its next new device) and the dormant
 * members as a hybrid post-quantum envelope (`sealHistoryKey`, 4.5).
 *
 * enigma: the proposal's per-message device signature over (conversation,
 * message id, epoch, ciphertext hash) is not here yet - authenticity of a
 * message currently rests on HK being known only to group members. Upgrade:
 * sign with the device's MLS signature key once the binding exposes signing.
 */

import { openHybrid, sealHybrid } from "./hybrid-envelope";
import { canonical, concat, owned, randomBytes } from "./bytes";

export const MESSAGE_CONTENT_VERSION = 1;
const LABEL = "polaris/chat-e2ee/content/v1";
const HISTORY_KEY_PURPOSE = "history-key";
export const HISTORY_KEY_BYTES = 32;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What one message's ciphertext is bound to. */
export interface MessageBinding {
    /** The conversation (chat channel id). */
    readonly conversationId: string;
    /** The MLS epoch whose `HK` sealed it. */
    readonly epoch: bigint | number;
    /** The sending device's id for this message (the send's `clientKey`). */
    readonly messageId: string;
    /** The sender's MLS leaf index. */
    readonly senderLeaf: number;
}

export class MessageOpenError extends Error {
    constructor() {
        super("The message could not be opened");
        this.name = "MessageOpenError";
    }
}

/** A fresh history key for a new epoch, from the platform's CSPRNG only. */
export function newHistoryKey(): Uint8Array {
    return randomBytes(HISTORY_KEY_BYTES);
}

function infoOf(binding: MessageBinding): Uint8Array<ArrayBuffer> {
    const { conversationId, epoch, messageId, senderLeaf } = binding;
    if (!conversationId || !messageId) throw new RangeError("A message names its conversation and its id");
    if (!Number.isInteger(senderLeaf) || senderLeaf < 0) throw new RangeError("The sender leaf is a leaf index");
    if (BigInt(epoch) < 0n) throw new RangeError("The epoch is not negative");
    return owned(canonical(LABEL, "message", conversationId, BigInt(epoch).toString(), messageId, senderLeaf));
}

async function keyAndNonce(historyKey: Uint8Array, info: Uint8Array<ArrayBuffer>): Promise<[CryptoKey, Uint8Array<ArrayBuffer>]> {
    if (historyKey.length !== HISTORY_KEY_BYTES) throw new RangeError("A history key is 32 bytes");
    const base = await crypto.subtle.importKey("raw", owned(historyKey), "HKDF", false, ["deriveBits"]);
    const bits = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, base, (KEY_BYTES + NONCE_BYTES) * 8)
    );
    const key = await crypto.subtle.importKey("raw", owned(bits.subarray(0, KEY_BYTES)), "AES-GCM", false, ["encrypt", "decrypt"]);
    return [key, owned(bits.subarray(KEY_BYTES))];
}

/** Seal one message's content (the serialized message payload) under `HK`. */
export async function sealMessage(historyKey: Uint8Array, binding: MessageBinding, plaintext: Uint8Array): Promise<Uint8Array> {
    const info = infoOf(binding);
    const [key, iv] = await keyAndNonce(historyKey, info);
    const version = Uint8Array.of(MESSAGE_CONTENT_VERSION);
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: owned(concat(version, info)) }, key, owned(plaintext));
    return concat(version, new Uint8Array(sealed));
}

/** Open a message sealed by `sealMessage`; one coarse error for every failure. */
export async function openMessage(historyKey: Uint8Array, binding: MessageBinding, sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed.length < 1 + TAG_BYTES || sealed[0] !== MESSAGE_CONTENT_VERSION) throw new MessageOpenError();
    try {
        const info = infoOf(binding);
        const [key, iv] = await keyAndNonce(historyKey, info);
        const opened = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv, additionalData: owned(concat(sealed.subarray(0, 1), info)) },
            key,
            owned(sealed.subarray(1))
        );
        return new Uint8Array(opened);
    } catch {
        throw new MessageOpenError();
    }
}

/** Who a history-key envelope is for: an account (its `AK`), or the organisation key. */
export interface HistoryKeyBinding {
    readonly recipient: string;
    readonly conversationId: string;
    readonly epoch: bigint | number;
}

const historyBinding = (b: HistoryKeyBinding) => [b.recipient, b.conversationId, BigInt(b.epoch).toString()];

/** `HK(c, e)` sealed to an account's X-Wing public key, bound to account, conversation and epoch. */
export async function sealHistoryKey(recipientPublicKey: Uint8Array, historyKey: Uint8Array, binding: HistoryKeyBinding): Promise<Uint8Array> {
    if (historyKey.length !== HISTORY_KEY_BYTES) throw new RangeError("A history key is 32 bytes");
    return sealHybrid(recipientPublicKey, historyKey, HISTORY_KEY_PURPOSE, historyBinding(binding));
}

/** Open a history-key envelope with the account's private X-Wing key. */
export async function openHistoryKey(recipientPrivateKey: CryptoKey, envelope: Uint8Array, binding: HistoryKeyBinding): Promise<Uint8Array> {
    const key = await openHybrid(recipientPrivateKey, envelope, HISTORY_KEY_PURPOSE, historyBinding(binding));
    if (key.length !== HISTORY_KEY_BYTES) throw new MessageOpenError();
    return key;
}
