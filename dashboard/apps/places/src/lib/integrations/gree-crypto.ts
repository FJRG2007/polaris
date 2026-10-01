/**
 * How a Gree air conditioner seals what it says on the LAN.
 *
 * Written from `greeclimate` (cmroche/greeclimate, `greeclimate/cipher.py`),
 * the library Home Assistant's `gree` integration uses, and pinned in
 * `test/home/gree-local.test.ts` to values its own `CipherV1`/`CipherV2` produced.
 *
 * Two generations, and a unit speaks one of them:
 *
 * - **V1**: AES-128-ECB, the JSON padded PKCS#7-style to the block, base64. The
 *   key everybody starts with is `a3K8Bx%2r8Y7#xDh`; binding hands back the
 *   unit's own, and every later message is sealed with that.
 * - **V2**, on recent firmware: AES-128-GCM with a nonce and associated data that
 *   are fixed constants of the protocol, a generic key of `{yxAHAY_Lm6pbC/<`,
 *   and the tag sent beside the payload as `tag`.
 *
 * Neither is secrecy in any real sense - both generic keys are public and the
 * GCM nonce never changes - which is why the unit's own key is still treated as
 * a credential here: it is what lets anything on the network drive the unit.
 *
 * Server-only (node's crypto).
 */

import { createCipheriv, createDecipheriv } from "node:crypto";

export type GreeCipher = "v1" | "v2";

/** The keys every unit accepts before it has been bound. */
export const GREE_GENERIC_KEYS: Readonly<Record<GreeCipher, string>> = {
    v1: "a3K8Bx%2r8Y7#xDh",
    v2: "{yxAHAY_Lm6pbC/<"
};

/** `CipherV2.GCM_NONCE` and `CipherV2.GCM_AEAD`. */
const GCM_NONCE = Buffer.from([
    0x54, 0x40, 0x78, 0x44, 0x49, 0x67, 0x5a, 0x51, 0x6c, 0x5e, 0x63, 0x13
]);
const GCM_AEAD = Buffer.from("qualcomm-test", "utf8");

export interface Sealed {
    readonly pack: string;
    /** Only for V2. */
    readonly tag?: string;
}

function keyOf(key: string): Buffer {
    const bytes = Buffer.from(key, "utf8");
    if (bytes.length !== 16) throw new Error("A Gree key is sixteen bytes");
    return bytes;
}

/** Seal one JSON text, exactly as given. */
export function sealGreeText(text: string, key: string, cipher: GreeCipher): Sealed {
    const plain = Buffer.from(text, "utf8");
    if (cipher === "v1") {
        // `CipherV1.__pad`: pad to the block with the count as each byte, a whole
        // block of sixteen when it already fits. The padding is done here rather
        // than by the cipher so the bytes are the library's to the letter.
        const pad = 16 - (plain.length % 16);
        const padded = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
        const aes = createCipheriv("aes-128-ecb", keyOf(key), null);
        aes.setAutoPadding(false);
        return { pack: Buffer.concat([aes.update(padded), aes.final()]).toString("base64") };
    }
    const aes = createCipheriv("aes-128-gcm", keyOf(key), GCM_NONCE);
    aes.setAAD(GCM_AEAD);
    const body = Buffer.concat([aes.update(plain), aes.final()]);
    return { pack: body.toString("base64"), tag: aes.getAuthTag().toString("base64") };
}

/** Seal a message's `pack`. */
export function sealGree(value: unknown, key: string, cipher: GreeCipher): Sealed {
    return sealGreeText(JSON.stringify(value), key, cipher);
}

/**
 * Open a `pack`, or null when it does not open into JSON under this key.
 *
 * Like the library, the text is cut after its last closing brace - whatever
 * follows is padding - and the GCM tag is not insisted on: the library never
 * checks it, and a unit whose tag Polaris refused would be a unit that works in
 * Home Assistant and not here. A wrong key is caught anyway, because what comes
 * out is not JSON.
 */
export function openGree(pack: string, key: string, cipher: GreeCipher): unknown {
    try {
        const sealed = Buffer.from(pack, "base64");
        let plain: Buffer;
        if (cipher === "v1") {
            if (sealed.length === 0 || sealed.length % 16 !== 0) return null;
            const aes = createDecipheriv("aes-128-ecb", keyOf(key), null);
            aes.setAutoPadding(false);
            plain = Buffer.concat([aes.update(sealed), aes.final()]);
        } else {
            const aes = createDecipheriv("aes-128-gcm", keyOf(key), GCM_NONCE);
            aes.setAAD(GCM_AEAD);
            plain = aes.update(sealed);
        }
        const text = plain.toString("utf8");
        const end = text.lastIndexOf("}");
        if (end < 0) return null;
        return JSON.parse(text.slice(0, end + 1)) as unknown;
    } catch {
        return null;
    }
}
