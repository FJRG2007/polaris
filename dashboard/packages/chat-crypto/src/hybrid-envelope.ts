/**
 * The hybrid post-quantum envelope for keys that stay stored for years (design
 * 4.5, owner decision 6): RFC 9180 HPKE, base mode, with X-Wing (X25519 +
 * ML-KEM-768) as the KEM, HKDF-SHA256 and AES-256-GCM.
 *
 *     envelope = version(1) || kem(2) || kdf(2) || aead(2) || enc || ciphertext
 *     info     = canonical(label, purpose, ...binding)
 *     aad      = the 7 header bytes
 *
 * The suite is a closed list of one (11.1 items 7 and 13): an envelope naming
 * any other suite is refused, never negotiated down. `info` carries what the
 * envelope is for, so a history-key envelope sealed for one account and one
 * conversation cannot be replayed as another's (item 2).
 */

import { XWing } from "@hpke/hybridkem-x-wing";
import { canonical, concat, owned } from "./bytes";
import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";

export const HYBRID_ENVELOPE_VERSION = 1;
/** X-Wing's HPKE KEM id (draft-connolly-cfrg-xwing-kem), HKDF-SHA256, AES-256-GCM. */
const SUITE = { kem: 0x647a, kdf: 0x0001, aead: 0x0002 } as const;
const HEADER_BYTES = 7;
/** X-Wing's encapsulation: ML-KEM-768 ciphertext (1088) + X25519 share (32). */
const ENC_BYTES = 1120;
const LABEL = "polaris/chat-e2ee/hpke/v1";

export class HybridOpenError extends Error {
    constructor() {
        super("The envelope could not be opened");
        this.name = "HybridOpenError";
    }
}

function suite(): CipherSuite {
    return new CipherSuite({ kem: new XWing(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
}

function header(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(HEADER_BYTES);
    const view = new DataView(out.buffer);
    out[0] = HYBRID_ENVELOPE_VERSION;
    view.setUint16(1, SUITE.kem);
    view.setUint16(3, SUITE.kdf);
    view.setUint16(5, SUITE.aead);
    return out;
}

function infoOf(purpose: string, binding: ReadonlyArray<string | number>): Uint8Array<ArrayBuffer> {
    if (!purpose) throw new RangeError("An envelope names its purpose");
    return owned(canonical(LABEL, purpose, ...binding));
}

/** Seal `plaintext` to an account's serialized X-Wing public key. */
export async function sealHybrid(
    recipientPublicKey: Uint8Array,
    plaintext: Uint8Array,
    purpose: string,
    binding: ReadonlyArray<string | number>
): Promise<Uint8Array> {
    const cipherSuite = suite();
    const publicKey = await cipherSuite.kem.deserializePublicKey(owned(recipientPublicKey));
    const aad = header();
    const sender = await cipherSuite.createSenderContext({
        recipientPublicKey: publicKey,
        info: infoOf(purpose, binding)
    });
    const sealed = await sender.seal(owned(plaintext), aad);
    return concat(aad, new Uint8Array(sender.enc), new Uint8Array(sealed));
}

/** Open an envelope with the account's private X-Wing key. */
export async function openHybrid(
    recipientPrivateKey: CryptoKey,
    envelope: Uint8Array,
    purpose: string,
    binding: ReadonlyArray<string | number>
): Promise<Uint8Array> {
    if (envelope.length < HEADER_BYTES + ENC_BYTES + 16) throw new HybridOpenError();
    const expected = header();
    for (let index = 0; index < HEADER_BYTES; index++)
        if (envelope[index] !== expected[index]) throw new HybridOpenError();
    try {
        const recipient = await suite().createRecipientContext({
            recipientKey: recipientPrivateKey,
            enc: owned(envelope.subarray(HEADER_BYTES, HEADER_BYTES + ENC_BYTES)),
            info: infoOf(purpose, binding)
        });
        const opened = await recipient.open(
            owned(envelope.subarray(HEADER_BYTES + ENC_BYTES)),
            expected
        );
        return new Uint8Array(opened);
    } catch {
        throw new HybridOpenError();
    }
}
