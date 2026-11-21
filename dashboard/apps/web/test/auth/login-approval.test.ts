import { describe, expect, it } from "vitest";
import { approvalDemanded } from "@/lib/login-approval";

describe("whether a new sign-in waits for approval", () => {
    it("keeps the account's own choice as it was: on, unless an authenticator is armed", () => {
        expect(approvalDemanded({ chosen: true, twoFactor: false, hasPin: true, demanded: false })).toBe(true);
        expect(approvalDemanded({ chosen: true, twoFactor: true, hasPin: true, demanded: false })).toBe(false);
        expect(approvalDemanded({ chosen: false, twoFactor: false, hasPin: true, demanded: false })).toBe(false);
    });

    it("holds every account with a PIN when this Polaris demands it, authenticator or not", () => {
        expect(approvalDemanded({ chosen: false, twoFactor: true, hasPin: true, demanded: true })).toBe(true);
        expect(approvalDemanded({ chosen: false, twoFactor: false, hasPin: true, demanded: true })).toBe(true);
    });

    it("never holds an account without a PIN for the demand, since no device could let it in", () => {
        expect(approvalDemanded({ chosen: false, twoFactor: false, hasPin: false, demanded: true })).toBe(false);
    });
});
