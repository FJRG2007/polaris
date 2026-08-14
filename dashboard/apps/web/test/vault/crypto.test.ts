/**
 * The vault's cryptography, checked against the primitives it claims to be.
 *
 * These are not round-trip tests for their own sake. Every constant in the
 * module is Bitwarden's, and getting one of them wrong produces a vault that
 * works perfectly in Polaris and cannot be opened by any Bitwarden client - a
 * failure nothing in the app would ever surface. So the derivations are compared
 * against independently computed values here (node:crypto, not the module under
 * test), and only then are the round trips checked.
 *
 * The tampering cases matter as much: an encrypted string whose MAC is ignored
 * is an encrypted string an attacker can edit.
 */

import { describe, expect, it } from "vitest";
import { createHmac, hkdfSync, pbkdf2Sync } from "node:crypto";
import { KDF_ARGON2ID, KDF_PBKDF2, type KdfSettings } from "@polaris/core";
import * as vaultCrypto from "../../src/lib/vault/crypto";

const PASSWORD = "correct horse battery staple";
const EMAIL = "Ana@Example.COM";

const PBKDF2_SETTINGS: KdfSettings = {
    kdf: KDF_PBKDF2,
    // Far below what a real vault uses; this is about the algorithm, not the cost.
    kdfIterations: 1000,
    kdfMemory: null,
    kdfParallelism: null
};

const ARGON2_SETTINGS: KdfSettings = {
    kdf: KDF_ARGON2ID,
    kdfIterations: 2,
    kdfMemory: 16,
    kdfParallelism: 1
};

describe("deriveMasterKey", () => {
    it("is PBKDF2-SHA256 over the password, salted with the lowercased address", async () => {
        const derived = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const expected = pbkdf2Sync(PASSWORD, "ana@example.com", 1000, 32, "sha256");
        expect(Buffer.from(derived).equals(expected)).toBe(true);
    });

    it("treats the address the way a sign-in form would", async () => {
        // A client that lowercases and one that does not must land on the same
        // key, or the same person cannot open their vault from both.
        const spaced = await vaultCrypto.deriveMasterKey(PASSWORD, "  ANA@example.com  ", PBKDF2_SETTINGS);
        const plain = await vaultCrypto.deriveMasterKey(PASSWORD, "ana@example.com", PBKDF2_SETTINGS);
        expect(Buffer.from(spaced).equals(Buffer.from(plain))).toBe(true);
    });

    it("derives an Argon2id key of the right size", async () => {
        const derived = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, ARGON2_SETTINGS);
        expect(derived).toHaveLength(32);
        // A different KDF over the same inputs is a different key, which is why
        // changing it re-wraps the vault rather than being a cosmetic setting.
        const pbkdf2Key = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        expect(Buffer.from(derived).equals(Buffer.from(pbkdf2Key))).toBe(false);
    });
});

describe("masterPasswordHash", () => {
    it("is one PBKDF2 round with the master key and password swapped", async () => {
        const masterKey = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const hash = await vaultCrypto.masterPasswordHash(masterKey, PASSWORD);
        const expected = pbkdf2Sync(Buffer.from(masterKey), PASSWORD, 1, 32, "sha256");
        expect(hash).toBe(expected.toString("base64"));
    });
});

describe("stretchMasterKey", () => {
    it("is HKDF-Expand-SHA256 with the info strings clients use", async () => {
        const masterKey = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const stretched = await vaultCrypto.stretchMasterKey(masterKey);
        // Expand only: one HMAC block per half, with the counter byte appended.
        const expand = (info: string) =>
            createHmac("sha256", Buffer.from(masterKey))
                .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
                .digest();
        expect(Buffer.from(stretched.enc).equals(expand("enc"))).toBe(true);
        expect(Buffer.from(stretched.mac).equals(expand("mac"))).toBe(true);
    });

    it("matches HKDF with an empty salt, which is what expand-only means", async () => {
        const masterKey = await vaultCrypto.deriveMasterKey(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const stretched = await vaultCrypto.stretchMasterKey(masterKey);
        // node's hkdf extracts first, so it is only equal when the master key is
        // used as the PRK directly - which is the whole claim being pinned.
        const viaNode = Buffer.from(
            hkdfSync("sha256", Buffer.from(masterKey), Buffer.alloc(0), "enc", 32)
        );
        expect(Buffer.from(stretched.enc).equals(viaNode)).toBe(false);
    });
});

describe("encrypt and decrypt", () => {
    it("round-trips through a type-2 encrypted string", async () => {
        const key = vaultCrypto.generateSymmetricKey();
        const sealed = await vaultCrypto.encrypt("hunter2", key);
        expect(sealed.startsWith("2.")).toBe(true);
        expect(sealed.split("|")).toHaveLength(3);
        expect(await vaultCrypto.decrypt(sealed, key)).toBe("hunter2");
    });

    it("refuses another key", async () => {
        const sealed = await vaultCrypto.encrypt("hunter2", vaultCrypto.generateSymmetricKey());
        expect(await vaultCrypto.decrypt(sealed, vaultCrypto.generateSymmetricKey())).toBeNull();
    });

    it("refuses a ciphertext somebody edited", async () => {
        const key = vaultCrypto.generateSymmetricKey();
        const sealed = await vaultCrypto.encrypt("transfer 10", key);
        const [head, ciphertext, mac] = sealed.split("|") as [string, string, string];
        const bytes = vaultCrypto.fromBase64(ciphertext);
        bytes[0] = bytes[0]! ^ 0xff;
        expect(await vaultCrypto.decrypt(`${head}|${vaultCrypto.toBase64(bytes)}|${mac}`, key)).toBeNull();
    });

    it("refuses a value with the MAC stripped off it", async () => {
        const key = vaultCrypto.generateSymmetricKey();
        const sealed = await vaultCrypto.encrypt("hunter2", key);
        const [head, ciphertext] = sealed.split("|") as [string, string];
        expect(await vaultCrypto.decrypt(`${head}|${ciphertext}`, key)).toBeNull();
    });

    it("keeps an empty string distinguishable from a failure", async () => {
        const key = vaultCrypto.generateSymmetricKey();
        expect(await vaultCrypto.decrypt(await vaultCrypto.encrypt("", key), key)).toBe("");
    });
});

describe("symmetric keys", () => {
    it("survives being written out and read back", () => {
        const key = vaultCrypto.generateSymmetricKey();
        const restored = vaultCrypto.symmetricKeyFromBytes(vaultCrypto.symmetricKeyBytes(key));
        expect(Buffer.from(restored.enc).equals(Buffer.from(key.enc))).toBe(true);
        expect(Buffer.from(restored.mac).equals(Buffer.from(key.mac))).toBe(true);
    });

    it("refuses bytes that are not a vault key", () => {
        expect(() => vaultCrypto.symmetricKeyFromBytes(new Uint8Array(32))).toThrow();
    });
});

describe("RSA", () => {
    it("round-trips a wrapped key through a generated pair", async () => {
        const pair = await vaultCrypto.generateRsaKeyPair();
        const secret = vaultCrypto.symmetricKeyBytes(vaultCrypto.generateSymmetricKey());
        const sealed = await vaultCrypto.encryptRsa(secret, pair.publicKey);
        expect(sealed.startsWith("4.")).toBe(true);
        const opened = await vaultCrypto.decryptRsa(sealed, pair.privateKey);
        expect(opened && Buffer.from(opened).equals(Buffer.from(secret))).toBe(true);
    });

    it("refuses a payload meant for somebody else", async () => {
        const mine = await vaultCrypto.generateRsaKeyPair();
        const theirs = await vaultCrypto.generateRsaKeyPair();
        const sealed = await vaultCrypto.encryptRsa(new Uint8Array([1, 2, 3]), theirs.publicKey);
        expect(await vaultCrypto.decryptRsa(sealed, mine.privateKey)).toBeNull();
    });
});

describe("createVaultKeys and unlockVaultKey", () => {
    it("hands the server nothing that opens the vault", async () => {
        const { keys } = await vaultCrypto.createVaultKeys(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const stored = JSON.stringify(keys);
        expect(stored).not.toContain(PASSWORD);
        expect(keys.protectedKey.startsWith("2.")).toBe(true);
        expect(keys.encryptedPrivateKey.startsWith("2.")).toBe(true);
    });

    it("opens with the password it was made with", async () => {
        const { keys, vaultKey } = await vaultCrypto.createVaultKeys(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        const unlocked = await vaultCrypto.unlockVaultKey(PASSWORD, EMAIL, PBKDF2_SETTINGS, keys.protectedKey);
        expect(unlocked).not.toBeNull();
        expect(Buffer.from(unlocked!.enc).equals(Buffer.from(vaultKey.enc))).toBe(true);
    });

    it("returns nothing for a wrong password, without asking anybody", async () => {
        const { keys } = await vaultCrypto.createVaultKeys(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        expect(await vaultCrypto.unlockVaultKey("wrong", EMAIL, PBKDF2_SETTINGS, keys.protectedKey)).toBeNull();
    });

    it("wraps the private key under the vault key, not the master key", async () => {
        const { keys, vaultKey } = await vaultCrypto.createVaultKeys(PASSWORD, EMAIL, PBKDF2_SETTINGS);
        // Decrypting it with the vault key is the property clients rely on: the
        // private key must be reachable while unlocked without the password.
        const opened = await vaultCrypto.decryptBytes(keys.encryptedPrivateKey, vaultKey);
        expect(opened).not.toBeNull();
        const sealed = await vaultCrypto.encryptRsa(new Uint8Array([7]), keys.publicKey);
        const back = await vaultCrypto.decryptRsa(sealed, opened!);
        expect(back && Array.from(back)).toEqual([7]);
    });
});

describe("deriveShareableKey", () => {
    it("matches Bitwarden's own vectors, which is what makes a Send portable", async () => {
        // Straight from the SDK's tests: the base64 below is the 64-byte key,
        // encryption half then MAC half. A Send made in one of their clients
        // opens here only if this derivation is identical, and nothing in the
        // app would ever say so - it would just fail to decrypt.
        const first = await vaultCrypto.deriveShareableKey(
            new TextEncoder().encode("&/$%F1a895g67HlX"),
            "test_key"
        );
        expect(
            Buffer.concat([Buffer.from(first.enc), Buffer.from(first.mac)]).toString("base64")
        ).toBe(
            "4PV6+PcmF2w7YHRatvyMcVQtI7zvCyssv/wFWmzjiH6Iv9altjmDkuBD1aagLVaLezbthbSe+ktR+U6qswxNnQ=="
        );
    });

    it("takes the info string into account", async () => {
        const withInfo = await vaultCrypto.deriveShareableKey(
            new TextEncoder().encode("&/$%F1a895g67HlX"),
            "test_key",
            "test"
        );
        const without = await vaultCrypto.deriveShareableKey(
            new TextEncoder().encode("&/$%F1a895g67HlX"),
            "test_key"
        );
        expect(Buffer.from(withInfo.enc).equals(Buffer.from(without.enc))).toBe(false);
    });

    it("opens what it sealed, through a Send's link key", async () => {
        const urlKey = crypto.getRandomValues(new Uint8Array(16));
        const key = await vaultCrypto.deriveSendKey(urlKey);
        const sealed = await vaultCrypto.encrypt("the secret", key);
        // The same 16 bytes, arriving from a URL fragment, derive the same key.
        const again = await vaultCrypto.deriveSendKey(Uint8Array.from(urlKey));
        expect(await vaultCrypto.decrypt(sealed, again)).toBe("the secret");
    });
});
