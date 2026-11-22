/**
 * The account key and its non-password locks: round trips, own known-answer
 * vectors, and the tamper cases a malicious server would try - an envelope
 * swapped between accounts, locks or versions, a flipped byte, an unknown
 * version - each of which must fail closed rather than open to another key.
 */

import "fake-indexeddb/auto";
import { join } from "node:path";
import * as bytes from "../src/bytes";
import * as locks from "../src/locks";
import * as device from "../src/device-lock";
import { describe, expect, it } from "vitest";
import * as account from "../src/account-key";
import * as passkey from "../src/passkey-lock";
import * as hybrid from "../src/hybrid-envelope";
import { readdir, readFile } from "node:fs/promises";

const AK = new Uint8Array(32).map((_, index) => index);
const SALT = new Uint8Array(32).fill(9);
const SECRET = new Uint8Array(32).fill(5);
const BINDING: locks.LockBinding = {
    userId: "0190a1b2-0000-7000-8000-000000000001",
    kind: "passkey-prf",
    lockId: "credential-a",
    akVersion: 1
};

function hex(value: Uint8Array): string {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("lock envelope", () => {
    it("round-trips and has the documented size", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, BINDING);
        expect(envelope.length).toBe(locks.LOCK_ENVELOPE_BYTES);
        expect(Array.from(await locks.openAccountKey(envelope, key, BINDING))).toEqual(Array.from(AK));
    });

    it("matches its own known-answer vector for a fixed salt", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, BINDING, SALT);
        // Own vector (design 11.3): any client implementing the format must
        // produce exactly these bytes from these inputs.
        expect(hex(envelope)).toBe(KAT_LOCK_ENVELOPE);
    });

    it("draws a fresh salt, so key and nonce never repeat across envelopes", async () => {
        const key = await locks.importLockSecret(SECRET);
        const seen = new Set<string>();
        for (let round = 0; round < 64; round++)
            seen.add(hex(await locks.sealAccountKey(AK, key, BINDING)));
        expect(seen.size).toBe(64);
        // The same salt is the only way to the same bytes: forcing the
        // collision shows the derivation is deterministic, not that it repeats.
        const a = await locks.sealAccountKey(AK, key, BINDING, SALT);
        const b = await locks.sealAccountKey(AK, key, BINDING, SALT);
        expect(hex(a)).toBe(hex(b));
    });

    const swaps: ReadonlyArray<[string, Partial<locks.LockBinding>]> = [
        ["another account", { userId: "0190a1b2-0000-7000-8000-000000000002" }],
        ["another lock id", { lockId: "credential-b" }],
        ["another kind", { kind: "device" }],
        ["another key version", { akVersion: 2 }]
    ];
    for (const [label, change] of swaps) {
        it(`refuses an envelope moved to ${label}`, async () => {
            const key = await locks.importLockSecret(SECRET);
            const envelope = await locks.sealAccountKey(AK, key, BINDING);
            await expect(
                locks.openAccountKey(envelope, key, { ...BINDING, ...change })
            ).rejects.toBeInstanceOf(locks.LockOpenError);
        });
    }

    it("refuses a boundary shift between account and lock id", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, { ...BINDING, userId: "ab", lockId: "c" });
        await expect(
            locks.openAccountKey(envelope, key, { ...BINDING, userId: "a", lockId: "bc" })
        ).rejects.toBeInstanceOf(locks.LockOpenError);
    });

    it("refuses every single flipped byte, a wrong key, an unknown version, a truncation", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, BINDING);
        for (let index = 0; index < envelope.length; index++) {
            const tampered = envelope.slice();
            tampered[index] = tampered[index]! ^ 0x01;
            await expect(locks.openAccountKey(tampered, key, BINDING)).rejects.toBeInstanceOf(
                locks.LockOpenError
            );
        }
        const other = await locks.importLockSecret(new Uint8Array(32).fill(6));
        await expect(locks.openAccountKey(envelope, other, BINDING)).rejects.toBeInstanceOf(
            locks.LockOpenError
        );
        await expect(
            locks.openAccountKey(envelope.subarray(0, 40), key, BINDING)
        ).rejects.toBeInstanceOf(locks.LockOpenError);
    });

    it("says nothing about why it failed", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, BINDING);
        const tampered = envelope.slice();
        tampered[40] = tampered[40]! ^ 1;
        const messages = new Set<string>();
        for (const attempt of [
            () => locks.openAccountKey(tampered, key, BINDING),
            () => locks.openAccountKey(envelope, key, { ...BINDING, userId: "x" }),
            () => locks.openAccountKey(new Uint8Array(3), key, BINDING)
        ])
            await attempt().catch((caught: Error) => messages.add(caught.message));
        expect(messages.size).toBe(1);
    });
});

describe("account key", () => {
    it("derives the same public keys from the same AK, and others from another", async () => {
        const first = await account.accountPublicKeys(AK);
        const again = await account.accountPublicKeys(AK);
        const other = await account.accountPublicKeys(account.generateAccountKey());
        expect(first.signPublicKey.length).toBe(32);
        expect(first.hpkePublicKey.length).toBe(1216);
        expect(hex(first.signPublicKey)).toBe(hex(again.signPublicKey));
        expect(hex(first.hpkePublicKey)).toBe(hex(again.hpkePublicKey));
        expect(hex(first.signPublicKey)).not.toBe(hex(other.signPublicKey));
        expect(hex(first.signPublicKey)).toBe(KAT_SIGN_PUBLIC);
    });

    it("signs with a non-extractable key that verifies under the published half", async () => {
        const { privateKey, publicKey } = await account.accountSigningKeyPair(AK);
        expect(privateKey.extractable).toBe(false);
        const message = new TextEncoder().encode("polaris");
        const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
        const verifier = await crypto.subtle.importKey("raw", bytes.owned(publicKey), "Ed25519", true, [
            "verify"
        ]);
        expect(await crypto.subtle.verify("Ed25519", verifier, signature, message)).toBe(true);
    });
});

describe("device lock", () => {
    const store = device.indexedDbDeviceLockStore();

    it("keeps a non-extractable key in IndexedDB and opens AK with it", async () => {
        await device.createDeviceLock(store, "user-1", AK, 1);
        const record = await store.read("user-1");
        expect(record?.key.extractable).toBe(false);
        const opened = await device.openDeviceLock(store, "user-1");
        expect(opened && Array.from(opened.accountKey)).toEqual(Array.from(AK));
    });

    it("keeps one store per account and sign-out forgets only that one", async () => {
        const otherKey = account.generateAccountKey();
        await device.createDeviceLock(store, "user-a", AK, 1);
        await device.createDeviceLock(store, "user-b", otherKey, 3);
        await device.forgetDeviceLock(store, "user-a");
        expect(await device.openDeviceLock(store, "user-a")).toBeNull();
        const b = await device.openDeviceLock(store, "user-b");
        expect(b && Array.from(b.accountKey)).toEqual(Array.from(otherKey));
        expect(b?.akVersion).toBe(3);
    });

    it("refuses one account's record copied into another account's store", async () => {
        await device.createDeviceLock(store, "user-c", AK, 1);
        const record = (await store.read("user-c"))!;
        await store.write("user-d", record);
        await expect(device.openDeviceLock(store, "user-d")).rejects.toBeInstanceOf(
            locks.LockOpenError
        );
    });
});

describe("passkey lock", () => {
    const PRF = new Uint8Array(32).fill(7);

    it("round-trips with the PRF output and fails on another credential or output", async () => {
        const envelope = await passkey.sealWithPasskey(AK, PRF, "user-1", "cred-1", 1);
        expect(Array.from(await passkey.openWithPasskey(envelope, PRF, "user-1", "cred-1", 1))).toEqual(
            Array.from(AK)
        );
        await expect(
            passkey.openWithPasskey(envelope, PRF, "user-1", "cred-2", 1)
        ).rejects.toBeInstanceOf(locks.LockOpenError);
        await expect(
            passkey.openWithPasskey(envelope, new Uint8Array(32).fill(8), "user-1", "cred-1", 1)
        ).rejects.toBeInstanceOf(locks.LockOpenError);
    });

    it("treats an assertion without PRF as no lock, never as an error", () => {
        expect(passkey.prfOutputOf({})).toBeNull();
        expect(passkey.prfOutputOf(null)).toBeNull();
        expect(passkey.prfOutputOf({ prf: { enabled: false } })).toBeNull();
        expect(passkey.prfOutputOf({ prf: { results: { first: new Uint8Array(8) } } })).toBeNull();
        expect(passkey.prfOutputOf({ prf: { results: { first: PRF.buffer } } })?.length).toBe(32);
    });

    it("asks one fixed, labelled PRF input, usable before the account is known", async () => {
        // One fixed, labelled input: asked for before the account is known.
        const input = await passkey.prfInput();
        expect(input.length).toBe(32);
        expect(hex(input)).toBe(hex(await passkey.prfInput()));
        const label = bytes.canonical("polaris/chat-e2ee/ak-lock/v1/passkey-prf-input");
        expect(hex(input)).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.owned(label)))));
        expect((await passkey.prfExtension()).prf.eval.first.length).toBe(32);
    });
});

describe("hybrid envelope (X-Wing HPKE)", () => {
    it("round-trips to the account's key and is bound to purpose and binding", async () => {
        const { hpkePublicKey } = await account.accountPublicKeys(AK);
        const pair = await account.accountHpkeKeyPair(AK);
        const secret = new Uint8Array(32).fill(1);
        const envelope = await hybrid.sealHybrid(hpkePublicKey, secret, "history-key", ["conv-1", 4]);
        expect(envelope.length).toBe(7 + 1120 + 32 + 16);
        expect(
            Array.from(await hybrid.openHybrid(pair.privateKey, envelope, "history-key", ["conv-1", 4]))
        ).toEqual(Array.from(secret));
        for (const [purpose, binding] of [
            ["history-key", ["conv-2", 4]],
            ["history-key", ["conv-1", 5]],
            ["org-recovery", ["conv-1", 4]]
        ] as const)
            await expect(
                hybrid.openHybrid(pair.privateKey, envelope, purpose, binding)
            ).rejects.toBeInstanceOf(hybrid.HybridOpenError);
    });

    it("refuses another recipient, a flipped byte, and any other suite", async () => {
        const { hpkePublicKey } = await account.accountPublicKeys(AK);
        const envelope = await hybrid.sealHybrid(hpkePublicKey, new Uint8Array(32), "p", []);
        const stranger = await account.accountHpkeKeyPair(account.generateAccountKey());
        await expect(hybrid.openHybrid(stranger.privateKey, envelope, "p", [])).rejects.toBeInstanceOf(
            hybrid.HybridOpenError
        );
        const mine = await account.accountHpkeKeyPair(AK);
        for (const index of [0, 2, 6, 7, 500, 1127, envelope.length - 1]) {
            const tampered = envelope.slice();
            tampered[index] = tampered[index]! ^ 1;
            await expect(hybrid.openHybrid(mine.privateKey, tampered, "p", [])).rejects.toBeInstanceOf(
                hybrid.HybridOpenError
            );
        }
    });
});

describe("pitfalls this phase answers (design 11.1)", () => {
    it("item 12: no Math.random anywhere in the package", async () => {
        const dir = join(__dirname, "..", "src");
        for (const name of await readdir(dir)) {
            const source = await readFile(join(dir, name), "utf8");
            expect(source, name).not.toMatch(/Math\.random/);
        }
    });

    it("item 13: unknown lock kinds and versions are refused", async () => {
        const key = await locks.importLockSecret(SECRET);
        const envelope = await locks.sealAccountKey(AK, key, BINDING);
        const future = envelope.slice();
        future[0] = 2;
        await expect(locks.openAccountKey(future, key, BINDING)).rejects.toBeInstanceOf(
            locks.LockOpenError
        );
        await expect(
            locks.openAccountKey(envelope, key, { ...BINDING, kind: "other" as locks.LockKind })
        ).rejects.toBeInstanceOf(locks.LockOpenError);
    });

    it("item 4: canonical encoding never lets two field lists collide", () => {
        expect(hex(bytes.canonical("ab", "c"))).not.toBe(hex(bytes.canonical("a", "bc")));
        expect(hex(bytes.canonical("a", 1))).not.toBe(hex(bytes.canonical("a", "\u0000\u0000\u0000\u0001")));
    });

    it("base64url decoding refuses what is not base64url", () => {
        expect(() => bytes.fromBase64Url("a+b/")).toThrow();
        expect(() => bytes.fromBase64Url("abcde")).toThrow();
        expect(Array.from(bytes.fromBase64Url(bytes.toBase64Url(AK)))).toEqual(Array.from(AK));
    });
});

const KAT_LOCK_ENVELOPE =
    "01030909090909090909090909090909090909090909090909090909090909090909b0c67ced2ec43856daa78c89fdc1f0c450f7a2e44b1bbcea9b94456f99b2e853d0c33c886247acfb520415cdae0a2b46";
const KAT_SIGN_PUBLIC = "a87dedd769f373bddd694ce8d9611d289b98bd4042364b7187741f5d9b2086d6";
