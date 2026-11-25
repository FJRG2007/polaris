/**
 * Safety numbers: both sides compute the same 60 digits, and any change to
 * either account's key or id changes them.
 */

import { describe, expect, it } from "vitest";
import * as account from "../src/account-key";
import * as safety from "../src/safety-number";

const ALICE = "0190a1b2-0000-7000-8000-000000000001";
const BOB = "0190a1b2-0000-7000-8000-000000000002";
const key = (seed: number) => new Uint8Array(32).map((_, index) => (index + seed) % 256);

async function party(userId: string, seed: number): Promise<safety.SafetyParty> {
    return { userId, keys: await account.accountPublicKeys(key(seed)) };
}

describe("safety numbers", () => {
    it("are 60 digits, the same whichever side computes them", async () => {
        const [alice, bob] = await Promise.all([party(ALICE, 1), party(BOB, 2)]);
        const mine = await safety.safetyNumber(alice, bob);
        expect(mine).toMatch(/^\d{60}$/);
        expect(await safety.safetyNumber(bob, alice)).toBe(mine);
        expect(safety.safetyGroups(mine)).toHaveLength(12);
        expect(safety.safetyGroups(mine).join("")).toBe(mine);
    });

    it("put the smaller account id first", async () => {
        const [alice, bob] = await Promise.all([party(ALICE, 1), party(BOB, 2)]);
        const number = await safety.safetyNumber(bob, alice);
        expect(number.slice(0, 30)).toBe(await safety.accountDigits(alice));
        expect(number.slice(30)).toBe(await safety.accountDigits(bob));
    });

    it("change when either half of a key is swapped", async () => {
        const [alice, bob, forged] = await Promise.all([party(ALICE, 1), party(BOB, 2), party(BOB, 3)]);
        const real = await safety.safetyNumber(alice, bob);
        expect(await safety.safetyNumber(alice, forged)).not.toBe(real);
        const signOnly = { userId: BOB, keys: { ...bob.keys, signPublicKey: forged.keys.signPublicKey } };
        const hpkeOnly = { userId: BOB, keys: { ...bob.keys, hpkePublicKey: forged.keys.hpkePublicKey } };
        expect((await safety.safetyNumber(alice, signOnly)).slice(30)).not.toBe(real.slice(30));
        expect((await safety.safetyNumber(alice, hpkeOnly)).slice(30)).not.toBe(real.slice(30));
        // Alice's half is untouched by Bob's key.
        expect((await safety.safetyNumber(alice, forged)).slice(0, 30)).toBe(real.slice(0, 30));
    });

    it("bind the account id, so one key under another account reads differently", async () => {
        const keys = await account.accountPublicKeys(key(1));
        expect(await safety.accountDigits({ userId: ALICE, keys })).not.toBe(await safety.accountDigits({ userId: BOB, keys }));
    });

    it("do not move a field boundary between the two public halves", async () => {
        const keys = await account.accountPublicKeys(key(1));
        const shifted = {
            signPublicKey: keys.signPublicKey.slice(0, 31),
            hpkePublicKey: new Uint8Array([keys.signPublicKey[31] ?? 0, ...keys.hpkePublicKey])
        };
        expect(await safety.accountDigits({ userId: ALICE, keys: shifted }, 2)).not.toBe(await safety.accountDigits({ userId: ALICE, keys }, 2));
    });

    it("depend on the number of rounds and refuse nonsense input", async () => {
        const alice = await party(ALICE, 1);
        expect(await safety.accountDigits(alice, 2)).not.toBe(await safety.accountDigits(alice, 3));
        await expect(safety.accountDigits(alice, 1)).rejects.toThrow(RangeError);
        await expect(safety.safetyNumber(alice, alice)).rejects.toThrow(RangeError);
        await expect(safety.accountDigits({ ...alice, userId: "" })).rejects.toThrow(RangeError);
        expect(() => safety.safetyGroups("123")).toThrow(RangeError);
    });

    it("are stable across releases (fixed vector)", async () => {
        const [alice, bob] = await Promise.all([party(ALICE, 1), party(BOB, 2)]);
        expect(await safety.safetyNumber(alice, bob)).toMatchInlineSnapshot(`"617953254076087081971675022643131468902876657849876362667438"`);
    });
});
