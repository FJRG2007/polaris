/**
 * Who holds an account's recovery shares and when they are split again.
 */

import { describe, expect, it } from "vitest";
import * as policy from "@/lib/chat/e2ee/recovery-policy";

const OWNER = "owner";
const admin = (userId: string, akVersion = 1) => ({ userId, akVersion });

describe("chooseCustodians", () => {
    it("takes the first three administrators and recovers with two", () => {
        const chosen = policy.chooseCustodians(OWNER, [admin("a"), admin("b"), admin("c"), admin("d")]);
        expect(chosen.custodians.map((c) => c.userId)).toEqual(["a", "b", "c"]);
        expect(chosen.threshold).toBe(2);
    });

    it("a single administrator is 1 of 1, two are 2 of 2, none is nothing", () => {
        expect(policy.chooseCustodians(OWNER, [admin("a")]).threshold).toBe(1);
        expect(policy.chooseCustodians(OWNER, [admin("a"), admin("b")]).threshold).toBe(2);
        expect(policy.chooseCustodians(OWNER, [])).toEqual({ custodians: [], threshold: 0 });
    });

    it("never makes an account its own custodian, nor anybody twice, and skips accounts with no key", () => {
        const chosen = policy.chooseCustodians(OWNER, [admin(OWNER), admin("a"), null, admin("a"), undefined, admin("b")]);
        expect(chosen.custodians.map((c) => c.userId)).toEqual(["a", "b"]);
    });
});

describe("needsSplit", () => {
    const wanted = { scope: "org:1", threshold: 2, custodians: [admin("a"), admin("b"), admin("c")] };
    const stored = wanted.custodians.map((c) => ({
        custodianId: c.userId,
        custodianAkVersion: c.akVersion,
        akVersion: 1,
        splitId: "s",
        threshold: 2,
        scope: "org:1"
    }));

    it("is false when every share matches", () => {
        expect(policy.needsSplit(1, wanted, stored)).toBe(false);
    });

    it("is true for no shares yet, a new key version, or another custodian set", () => {
        expect(policy.needsSplit(1, wanted, [])).toBe(true);
        expect(policy.needsSplit(2, wanted, stored)).toBe(true);
        expect(policy.needsSplit(1, { ...wanted, custodians: [admin("a"), admin("b"), admin("d")] }, stored)).toBe(true);
        expect(policy.needsSplit(1, { ...wanted, custodians: [admin("a"), admin("b"), admin("c", 2)] }, stored)).toBe(true);
    });

    it("is true for another threshold, scope, or shares of two splits", () => {
        expect(policy.needsSplit(1, { ...wanted, threshold: 1 }, stored)).toBe(true);
        expect(policy.needsSplit(1, { ...wanted, scope: "instance" }, stored)).toBe(true);
        expect(policy.needsSplit(1, wanted, [...stored.slice(0, 2), { ...stored[2]!, splitId: "t" }])).toBe(true);
    });

    it("drops shares nobody should hold any more once there are no custodians", () => {
        expect(policy.needsSplit(1, { scope: "instance", threshold: 0, custodians: [] }, stored)).toBe(true);
        expect(policy.needsSplit(1, { scope: "instance", threshold: 0, custodians: [] }, [])).toBe(false);
    });
});
