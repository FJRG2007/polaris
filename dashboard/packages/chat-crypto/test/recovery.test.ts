/**
 * Quorum recovery end to end in one process: an account splits its key to three
 * custodians, two approve a request, the requester's one-off key gets `AK` back -
 * and every binding refuses an envelope moved to another account, split,
 * custodian or request.
 */

import * as recovery from "../src/recovery";
import { describe, expect, it } from "vitest";
import * as account from "../src/account-key";

const OWNER = "0190a1b2-0000-7000-8000-000000000001";
const IDS = ["0190a1b2-0000-7000-8000-00000000000a", "0190a1b2-0000-7000-8000-00000000000b", "0190a1b2-0000-7000-8000-00000000000c"];
const REQUEST = "0190a1b2-0000-7000-8000-0000000000ff";
const key = (seed: number) => new Uint8Array(32).map((_, index) => (index * 7 + seed) % 256);

async function custodians() {
    return Promise.all(
        IDS.map(async (userId, index) => {
            const ak = key(index + 10);
            const pair = await account.accountHpkeKeyPair(ak);
            const { hpkePublicKey } = await account.accountPublicKeys(ak);
            return { userId, akVersion: 1, hpkePublicKey, privateKey: pair.privateKey };
        })
    );
}

const binding: recovery.ShareBinding = { ownerId: OWNER, akVersion: 3, splitId: "split-1" };
const release: recovery.ReleaseBinding = { requestId: REQUEST, ownerId: OWNER, akVersion: 3 };

async function approve(
    holder: Awaited<ReturnType<typeof custodians>>[number],
    sealed: recovery.SealedShare,
    requesterPublicKey: Uint8Array
) {
    const share = await recovery.openShare(holder.privateKey, sealed.envelope, binding, holder.userId, 1);
    return {
        custodianId: holder.userId,
        envelope: await recovery.releaseShare(requesterPublicKey, share, release, holder.userId)
    };
}

describe("quorum recovery", () => {
    it("two of three custodians hand the account key back to the requester", async () => {
        const accountKey = key(1);
        const holders = await custodians();
        const sealed = await recovery.splitAccountKey(accountKey, holders, 2, binding);
        expect(sealed.map((share) => share.custodianId)).toEqual(IDS);

        const requester = await recovery.requesterKeyPair();
        const released = [
            await approve(holders[0]!, sealed[0]!, requester.publicKey),
            await approve(holders[2]!, sealed[2]!, requester.publicKey)
        ];
        expect(await recovery.recoverAccountKey(requester.privateKey, released, release)).toEqual(accountKey);
    });

    it("one approval is not enough", async () => {
        const accountKey = key(1);
        const holders = await custodians();
        const sealed = await recovery.splitAccountKey(accountKey, holders, 2, binding);
        const requester = await recovery.requesterKeyPair();
        const released = [await approve(holders[1]!, sealed[1]!, requester.publicKey)];
        expect(await recovery.recoverAccountKey(requester.privateKey, released, release)).not.toEqual(accountKey);
    });

    it("a share opens only for its own account, split and custodian", async () => {
        const holders = await custodians();
        const sealed = await recovery.splitAccountKey(key(1), holders, 2, binding);
        const holder = holders[0]!;
        const open = (b: recovery.ShareBinding, custodianId = holder.userId) =>
            recovery.openShare(holder.privateKey, sealed[0]!.envelope, b, custodianId, 1);
        await expect(open({ ...binding, ownerId: IDS[1]! })).rejects.toThrow();
        await expect(open({ ...binding, splitId: "split-2" })).rejects.toThrow();
        await expect(open({ ...binding, akVersion: 4 })).rejects.toThrow();
        await expect(open(binding, IDS[1]!)).rejects.toThrow();
        // Another custodian's key cannot open it at all.
        await expect(
            recovery.openShare(holders[1]!.privateKey, sealed[0]!.envelope, binding, holder.userId, 1)
        ).rejects.toThrow();
    });

    it("a released share opens only for its own request", async () => {
        const holders = await custodians();
        const sealed = await recovery.splitAccountKey(key(1), holders, 2, binding);
        const requester = await recovery.requesterKeyPair();
        const released = [await approve(holders[0]!, sealed[0]!, requester.publicKey)];
        await expect(
            recovery.recoverAccountKey(requester.privateKey, released, { ...release, requestId: "other" })
        ).rejects.toThrow();
        const stranger = await recovery.requesterKeyPair();
        await expect(recovery.recoverAccountKey(stranger.privateKey, released, release)).rejects.toThrow();
    });

    it("refuses an account as its own custodian, a repeated custodian and a wrong key length", async () => {
        const holders = await custodians();
        await expect(
            recovery.splitAccountKey(key(1), [holders[0]!, { ...holders[1]!, userId: OWNER }], 2, binding)
        ).rejects.toThrow(RangeError);
        await expect(recovery.splitAccountKey(key(1), [holders[0]!, holders[0]!], 2, binding)).rejects.toThrow(
            RangeError
        );
        await expect(recovery.splitAccountKey(new Uint8Array(16), holders, 2, binding)).rejects.toThrow(RangeError);
    });

    it("the request code is 12 digits, stable, and changes with the key or the request", async () => {
        const first = await recovery.requesterKeyPair();
        const second = await recovery.requesterKeyPair();
        const code = await recovery.requestCode(REQUEST, first.publicKey);
        expect(code).toMatch(/^\d{4} \d{4} \d{4}$/);
        expect(await recovery.requestCode(REQUEST, first.publicKey)).toBe(code);
        expect(await recovery.requestCode(REQUEST, second.publicKey)).not.toBe(code);
        expect(await recovery.requestCode("other", first.publicKey)).not.toBe(code);
    });
});

describe("organisation recovery key", () => {
    it("derives one pair per seed and seals history only it opens", async () => {
        const { sealHybrid, openHybrid } = await import("../src/hybrid-envelope");
        const first = await recovery.recoveryKeyPair(key(5));
        expect((await recovery.recoveryKeyPair(key(5))).publicKey).toEqual(first.publicKey);
        expect((await recovery.recoveryKeyPair(key(6))).publicKey).not.toEqual(first.publicKey);
        const hk = key(9);
        const envelope = await sealHybrid(first.publicKey, hk, "history-key", ["c", 1, "ork:x"]);
        expect(await openHybrid(first.privateKey, envelope, "history-key", ["c", 1, "ork:x"])).toEqual(hk);
        await expect(recovery.recoveryKeyPair(new Uint8Array(16))).rejects.toThrow(RangeError);
    });
});
