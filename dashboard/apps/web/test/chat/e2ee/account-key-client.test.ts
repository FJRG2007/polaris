/**
 * The browser's account-key steps after a sign-in, against a fake of
 * `/api/e2ee/keys` that behaves like the real route (one key per account,
 * locks only for the current version) and the real IndexedDB store code.
 *
 * Pinned: an account with no key gets exactly one, even with two sign-ins at
 * once; the passkey PRF lock opens or is sealed; the password lock is re-sealed
 * after a reset; and no key the server swapped, nor a stale device copy, is
 * ever kept or spread under another lock.
 */

import "fake-indexeddb/auto";
import * as locks from "@polaris/chat-crypto/locks";
import * as qr from "@polaris/chat-crypto/qr-approval";
import * as account from "@polaris/chat-crypto/account-key";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as deviceLock from "@polaris/chat-crypto/device-lock";
import * as passkeyLock from "@polaris/chat-crypto/passkey-lock";

/** The password lock key the (stubbed) OPAQUE exchange yields: the current one. */
let passwordSecret = new Uint8Array(32).fill(3);

vi.mock("@polaris/chat-crypto/password-lock", async (original) => {
    const real = await original<typeof import("@polaris/chat-crypto/password-lock")>();
    return {
        ...real,
        startPasswordLogin: async () => ({ state: "s", startLoginRequest: "r".repeat(32) }),
        finishPasswordLogin: async () => ({
            finishLoginRequest: "f".repeat(32),
            lockKey: await locks.importLockSecret(passwordSecret)
        })
    };
});

const client = await import("../../../src/lib/chat/e2ee/account-key-client");

interface Server {
    userId: string;
    key: { akVersion: number; signPublicKey: string; hpkePublicKey: string } | null;
    passkeyLocks: Map<string, { akVersion: number; envelope: string }>;
    passwordLock: { akVersion: number; envelope: string } | null;
    adopted: boolean;
    ops: string[];
}

let server: Server;
let counter = 0;

function text(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

function reply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function route(body: Record<string, unknown>): Response {
    server.ops.push(body.op as string);
    switch (body.op) {
        case "state":
            return reply({
                userId: server.userId,
                adopted: server.adopted,
                accountKey: server.key && {
                    ...server.key,
                    hasPasswordLock: server.passwordLock !== null,
                    passkeyLocks: [...server.passkeyLocks].map(([lockId, lock]) => ({ lockId, ...lock }))
                }
            });
        case "create-account-key":
            if (server.key) return reply({ error: "exists" }, 409);
            server.key = {
                akVersion: body.akVersion as number,
                signPublicKey: body.signPublicKey as string,
                hpkePublicKey: body.hpkePublicKey as string
            };
            return reply({ created: true });
        case "put-passkey-lock":
            if (server.key?.akVersion !== body.akVersion) return reply({ error: "stale" }, 409);
            server.passkeyLocks.set(body.lockId as string, {
                akVersion: body.akVersion as number,
                envelope: body.envelope as string
            });
            return reply({ stored: true });
        case "unlock-start":
            return reply({ loginId: "l", loginResponse: "x", userId: server.userId });
        case "unlock-finish": {
            const lock = body.passwordLock as { akVersion: number; envelope: string } | undefined;
            if (lock && server.key?.akVersion === lock.akVersion) server.passwordLock = lock;
            return reply({ passwordLock: server.passwordLock });
        }
    }
    return reply({ error: "invalid" }, 400);
}

async function publish(accountKey: Uint8Array): Promise<void> {
    const keys = await account.accountPublicKeys(accountKey);
    server.key = { akVersion: 1, signPublicKey: text(keys.signPublicKey), hpkePublicKey: text(keys.hpkePublicKey) };
}

async function onDevice(): Promise<Uint8Array | null> {
    const held = await deviceLock.openDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId);
    return held?.accountKey ?? null;
}

async function publishedKeyBytes(): Promise<string> {
    return server.key!.signPublicKey;
}

async function signKeyOf(accountKey: Uint8Array): Promise<string> {
    return text((await account.accountPublicKeys(accountKey)).signPublicKey);
}

const CREDENTIAL = "Y3JlZGVudGlhbC1pZC1vbmUtMTIzNDU2";
const prf = () => new Uint8Array(32).fill(0x42);

beforeEach(() => {
    counter++;
    passwordSecret = new Uint8Array(32).fill(3);
    server = {
        userId: `0190a1b2-0000-7000-8000-${String(counter).padStart(12, "0")}`,
        key: null,
        passkeyLocks: new Map(),
        passwordLock: null,
        adopted: true,
        ops: []
    };
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => route(JSON.parse(init.body as string)));
});

describe("an account with no key", () => {
    it("gets one on its first passkey sign-in: published, kept here, and sealed under the passkey", async () => {
        const output = prf();
        expect(await client.settleAfterPasskey(CREDENTIAL, output)).toBe(true);
        expect(output.every((byte) => byte === 0)).toBe(true);
        const kept = (await onDevice())!;
        expect(await signKeyOf(kept)).toBe(await publishedKeyBytes());
        const lock = server.passkeyLocks.get(CREDENTIAL)!;
        const opened = await passkeyLock.openWithPasskey(
            new Uint8Array(Buffer.from(lock.envelope, "base64url")),
            prf(),
            server.userId,
            CREDENTIAL,
            1
        );
        expect(Array.from(opened)).toEqual(Array.from(kept));
    });

    it("gets exactly one with two sign-ins at once, and every lock opens to that one", async () => {
        const results = await Promise.all([
            client.settleAfterPasskey(CREDENTIAL, prf()),
            client.settleAfterPasskey("b3RoZXItY3JlZGVudGlhbC1pZC0xMjM0", prf())
        ]);
        expect(server.ops.filter((op) => op === "create-account-key")).toHaveLength(2);
        expect(results.filter(Boolean).length).toBeGreaterThanOrEqual(1);
        for (const [lockId, lock] of server.passkeyLocks) {
            const opened = await passkeyLock.openWithPasskey(
                new Uint8Array(Buffer.from(lock.envelope, "base64url")),
                prf(),
                server.userId,
                lockId,
                1
            );
            expect(await signKeyOf(opened)).toBe(await publishedKeyBytes());
        }
    });

    it("gets one on a password sign-in, sealed under the password lock through the unlock", async () => {
        expect(await client.settleAfterPassword("pw", null)).toBe(true);
        expect(server.ops).toContain("unlock-finish");
        const opened = await locks.openAccountKey(
            new Uint8Array(Buffer.from(server.passwordLock!.envelope, "base64url")),
            await locks.importLockSecret(passwordSecret),
            { userId: server.userId, kind: "password", lockId: "password", akVersion: 1 }
        );
        expect(await signKeyOf(opened)).toBe(await publishedKeyBytes());
    });

    it("is left alone by a password sign-in on an account not moved to OPAQUE yet", async () => {
        server.adopted = false;
        expect(await client.settleAfterPassword("pw", null)).toBe(false);
        expect(server.key).toBeNull();
    });
});

describe("the passkey PRF lock", () => {
    it("opens AK on a later sign-in and keeps it on this device, writing nothing", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        const envelope = await passkeyLock.sealWithPasskey(ak, prf(), server.userId, CREDENTIAL, 1);
        server.passkeyLocks.set(CREDENTIAL, { akVersion: 1, envelope: text(envelope) });
        expect(await client.settleAfterPasskey(CREDENTIAL, prf())).toBe(true);
        expect(Array.from((await onDevice())!)).toEqual(Array.from(ak));
        expect(server.ops).toEqual(["state"]);
    });

    it("refuses an envelope the server swapped for a key of its own", async () => {
        await publish(account.generateAccountKey());
        const forged = account.generateAccountKey();
        const envelope = await passkeyLock.sealWithPasskey(forged, prf(), server.userId, CREDENTIAL, 1);
        server.passkeyLocks.set(CREDENTIAL, { akVersion: 1, envelope: text(envelope) });
        expect(await client.settleAfterPasskey(CREDENTIAL, prf())).toBe(false);
        expect(await onDevice()).toBeNull();
    });

    it("is added for a new passkey from the key this device holds", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, ak, 1);
        expect(await client.settleAfterPasskey(CREDENTIAL, prf())).toBe(true);
        expect(server.passkeyLocks.has(CREDENTIAL)).toBe(true);
    });

    it("is never sealed from a stale device copy", async () => {
        await publish(account.generateAccountKey());
        const stale = account.generateAccountKey();
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, stale, 1);
        expect(await client.settleAfterPasskey(CREDENTIAL, prf())).toBe(false);
        expect(server.passkeyLocks.size).toBe(0);
    });
});

describe("the password lock after a reset", () => {
    it("is re-sealed under the new password from the key this device holds", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        const old = await locks.sealAccountKey(ak, await locks.importLockSecret(new Uint8Array(32).fill(1)), {
            userId: server.userId,
            kind: "password",
            lockId: "password",
            akVersion: 1
        });
        server.passwordLock = { akVersion: 1, envelope: text(old) };
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, ak, 1);
        // The new password's lock key no longer opens the old envelope.
        const lockKey = await locks.importLockSecret(passwordSecret);
        expect(
            await client.settleAfterPassword("new", { lockKey, userId: server.userId, lock: server.passwordLock })
        ).toBe(true);
        const opened = await locks.openAccountKey(
            new Uint8Array(Buffer.from(server.passwordLock!.envelope, "base64url")),
            lockKey,
            { userId: server.userId, kind: "password", lockId: "password", akVersion: 1 }
        );
        expect(Array.from(opened)).toEqual(Array.from(ak));
    });

    it("opens a current envelope and writes nothing", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        const lockKey = await locks.importLockSecret(passwordSecret);
        const envelope = await locks.sealAccountKey(ak, lockKey, {
            userId: server.userId,
            kind: "password",
            lockId: "password",
            akVersion: 1
        });
        server.passwordLock = { akVersion: 1, envelope: text(envelope) };
        expect(await client.settleAfterPassword("pw", { lockKey, userId: server.userId, lock: server.passwordLock })).toBe(
            true
        );
        expect(server.ops).toEqual(["state"]);
        expect(Array.from((await onDevice())!)).toEqual(Array.from(ak));
    });

    it("waits for a later sign-in when this device holds no key to re-seal", async () => {
        await publish(account.generateAccountKey());
        const lockKey = await locks.importLockSecret(passwordSecret);
        expect(await client.settleAfterPassword("pw", { lockKey, userId: server.userId, lock: null })).toBe(false);
        expect(server.passwordLock).toBeNull();
    });
});

describe("the QR approval, both browsers", () => {
    it("seals from the approver's device key and opens on the new browser after the published-key check", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, ak, 1);
        const { offer, text: offerText } = await client.createKeyOffer();
        const link = await client.offerLink("https://polaris.example.com/account/scan?code=ABCD2345", "ABCD2345", offer);
        const transfer = await client.sealForScannedCode({
            approverDeviceId: "33333333-3333-4333-8333-333333333333",
            flowId: "ABCD2345",
            keyOffer: offerText,
            fragment: new URL(link).hash
        });
        expect(transfer).not.toBeNull();
        await deviceLock.forgetDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId);
        expect(await client.acceptKeyDelivery(offer, { userId: server.userId, flowId: "ABCD2345", transfer: transfer! })).toBe(
            true
        );
        expect(Array.from((await onDevice())!)).toEqual(Array.from(ak));
    });

    it("seals nothing on an approver that holds no key or a stale one", async () => {
        await publish(account.generateAccountKey());
        const { offer, text: offerText } = await client.createKeyOffer();
        const fragment = await qr.offerFragment("ABCD2345", offer);
        const input = { approverDeviceId: "33333333-3333-4333-8333-333333333333", flowId: "ABCD2345", keyOffer: offerText, fragment };
        expect(await client.sealForScannedCode(input)).toBeNull();
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, account.generateAccountKey(), 1);
        expect(await client.sealForScannedCode(input)).toBeNull();
    });

    it("keeps nothing when the published key is not the one delivered", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await deviceLock.createDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId, ak, 1);
        const { offer, text: offerText } = await client.createKeyOffer();
        const transfer = await client.sealForScannedCode({
            approverDeviceId: "33333333-3333-4333-8333-333333333333",
            flowId: "ABCD2345",
            keyOffer: offerText,
            fragment: await qr.offerFragment("ABCD2345", offer)
        });
        await deviceLock.forgetDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId);
        await publish(account.generateAccountKey());
        expect(await client.acceptKeyDelivery(offer, { userId: server.userId, flowId: "ABCD2345", transfer: transfer! })).toBe(
            false
        );
        expect(await onDevice()).toBeNull();
    });
});

describe("a sign-in that owed a second factor (no envelope came with it)", () => {
    async function sealedElsewhere(ak: Uint8Array): Promise<void> {
        const envelope = await locks.sealAccountKey(ak, await locks.importLockSecret(passwordSecret), {
            userId: server.userId,
            kind: "password",
            lockId: "password",
            akVersion: 1
        });
        server.passwordLock = { akVersion: 1, envelope: text(envelope) };
    }

    it("opens AK in a new browser through an unlock that writes nothing", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await sealedElsewhere(ak);
        const before = server.passwordLock;
        expect(await client.settleAfterPassword("pw", null)).toBe(true);
        expect(server.ops).toEqual(["state", "unlock-start", "unlock-finish"]);
        expect(server.passwordLock).toBe(before);
        expect(Array.from((await onDevice())!)).toEqual(Array.from(ak));
    });

    it("creates the first AK and its password lock for an account that never had one", async () => {
        expect(await client.settleAfterPassword("pw", null)).toBe(true);
        expect(server.key).not.toBeNull();
        expect(server.passwordLock).not.toBeNull();
        const held = (await onDevice())!;
        expect(await signKeyOf(held)).toBe(await publishedKeyBytes());
    });

    it("never replaces a lock it cannot open (wrong password, or reset elsewhere) when this browser holds no key", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await sealedElsewhere(ak);
        const before = server.passwordLock;
        passwordSecret = new Uint8Array(32).fill(8);
        expect(await client.settleAfterPassword("other", null)).toBe(false);
        expect(server.passwordLock).toBe(before);
        expect(await onDevice()).toBeNull();
    });

    it("refuses an unlock that answers for another account", async () => {
        const ak = account.generateAccountKey();
        await publish(ak);
        await sealedElsewhere(ak);
        const other = `${server.userId.slice(0, -1)}f`;
        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.op === "unlock-start") return reply({ loginId: "l", loginResponse: "x", userId: other });
            return route(body);
        });
        expect(await client.settleAfterPassword("pw", null)).toBe(false);
        expect(await onDevice()).toBeNull();
    });

    it("settles from the challenge page with the held password, once", async () => {
        const held = await import("../../../src/lib/chat/e2ee/held-password");
        held.holdForSecondFactor("pw");
        await held.settleAfterSecondFactor();
        expect(server.key).not.toBeNull();
        expect(server.passwordLock).not.toBeNull();
        const ops = server.ops.length;
        await held.settleAfterSecondFactor();
        expect(server.ops.length).toBe(ops);
    });

    it("keeps the device copy under an app's platform store when one is offered", async () => {
        const sealedWith = new Map<string, string>();
        vi.stubGlobal("polarisDesktop", {
            keyWrap: {
                seal: async (data: string) => {
                    const sealed = Buffer.from(`S${sealedWith.size}`).toString("base64url");
                    sealedWith.set(sealed, data);
                    return sealed;
                },
                open: async (sealed: string) => sealedWith.get(sealed) ?? null
            }
        });
        expect(await client.settleAfterPassword("pw", null)).toBe(true);
        expect(sealedWith.size).toBe(1);
        // The raw IndexedDB record is the sealed one, not a device lock envelope.
        await expect(deviceLock.openDeviceLock(deviceLock.indexedDbDeviceLockStore(), server.userId)).rejects.toThrow();
        const opened = await deviceLock.openDeviceLock(client.deviceStore(), server.userId);
        expect(await signKeyOf(opened!.accountKey)).toBe(await publishedKeyBytes());
        vi.stubGlobal("polarisDesktop", undefined);
    });
});
