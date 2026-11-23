/**
 * The password held across the second-factor page: taken once, gone after its
 * time, dropped when the challenge is abandoned, and never held when empty.
 */

import { describe, expect, it } from "vitest";
import * as held from "../../../src/lib/chat/e2ee/held-password";

describe("held password", () => {
    it("is taken exactly once", () => {
        held.holdForSecondFactor("secret", 1_000);
        expect(held.takeHeldPassword(1_001)).toBe("secret");
        expect(held.takeHeldPassword(1_002)).toBeNull();
    });

    it("expires, and an expired one is gone rather than kept", () => {
        held.holdForSecondFactor("secret", 0);
        expect(held.takeHeldPassword(held.HOLD_MS)).toBeNull();
        expect(held.takeHeldPassword(1)).toBeNull();
    });

    it("is dropped when the challenge is abandoned, and a new hold replaces an old one", () => {
        held.holdForSecondFactor("first", 0);
        held.holdForSecondFactor("second", 0);
        expect(held.takeHeldPassword(1)).toBe("second");
        held.holdForSecondFactor("third", 0);
        held.dropHeldPassword();
        expect(held.takeHeldPassword(1)).toBeNull();
    });

    it("holds nothing for an empty password, and settles nothing with nothing held", async () => {
        held.holdForSecondFactor("", 0);
        expect(held.takeHeldPassword(1)).toBeNull();
        await expect(held.settleAfterSecondFactor()).resolves.toBeUndefined();
    });
});
