/**
 * The deployment's own security policy, as it is stored and read back.
 *
 * Both cases here are about a policy written by an older build. The stored value
 * is JSON in one row, so every field added later arrives absent - and a parse
 * that failed on that would drop the operator's whole policy back to the
 * defaults, silently turning settings back on that somebody deliberately turned
 * off. The authenticator being folded back into the accepted list is the other
 * half of the same care: a list that lost it is an instance nobody can enter.
 */

import { describe, expect, it } from "vitest";
import {
    INSTANCE_SECURITY_DEFAULTS,
    instanceSecuritySchema,
    phishingResistantApplies
} from "../src/schemas/instance-security.js";

describe("the instance security policy", () => {
    it("reads a policy stored before the connected-account switch existed", () => {
        const parsed = instanceSecuritySchema.parse({
            requireSecondFactor: false,
            acceptedFactors: ["totp", "email"]
        });
        // Kept, not reset to the default "on".
        expect(parsed.requireSecondFactor).toBe(false);
        expect(parsed.challengeConnectionSignIn).toBe(false);
    });

    it("does not challenge a connected-account sign-in unless it is asked to", () => {
        expect(INSTANCE_SECURITY_DEFAULTS.challengeConnectionSignIn).toBe(false);
        expect(instanceSecuritySchema.parse({
            requireSecondFactor: true,
            acceptedFactors: [],
            challengeConnectionSignIn: true
        }).challengeConnectionSignIn).toBe(true);
    });

    it("holds no sign-in for approval unless the operator asks, and keeps a stored policy that predates it", () => {
        expect(INSTANCE_SECURITY_DEFAULTS.requireLoginApproval).toBe(false);
        const stored = instanceSecuritySchema.parse({ requireSecondFactor: false, acceptedFactors: ["totp"] });
        expect(stored.requireLoginApproval).toBe(false);
        expect(stored.requireSecondFactor).toBe(false);
        expect(
            instanceSecuritySchema.parse({ requireSecondFactor: true, acceptedFactors: [], requireLoginApproval: true })
                .requireLoginApproval
        ).toBe(true);
    });

    it("requires keys from nobody unless an administrator says so", () => {
        expect(INSTANCE_SECURITY_DEFAULTS.requirePhishingResistant).toBe("off");
        // A policy stored before the setting existed parses as it did.
        expect(
            instanceSecuritySchema.parse({ requireSecondFactor: true, acceptedFactors: ["totp"] })
                .requirePhishingResistant
        ).toBe("off");
        expect(
            instanceSecuritySchema.safeParse({
                requireSecondFactor: true,
                acceptedFactors: [],
                requirePhishingResistant: "some"
            }).success
        ).toBe(false);
    });

    it("covers administrators or everybody, as chosen", () => {
        expect(phishingResistantApplies("off", true)).toBe(false);
        expect(phishingResistantApplies("admins", true)).toBe(true);
        expect(phishingResistantApplies("admins", false)).toBe(false);
        expect(phishingResistantApplies("everyone", false)).toBe(true);
    });

    it("keeps the authenticator accepted whatever was stored", () => {
        expect(
            instanceSecuritySchema.parse({ requireSecondFactor: true, acceptedFactors: [] }).acceptedFactors
        ).toEqual(["totp"]);
    });

    it("asks nobody for a phone unless an administrator says so, and keeps a stored policy that predates it", () => {
        expect(INSTANCE_SECURITY_DEFAULTS.requirePhone).toBe(false);
        const stored = instanceSecuritySchema.parse({ requireSecondFactor: false, acceptedFactors: ["totp"] });
        expect(stored.requirePhone).toBe(false);
        expect(stored.secondFactorRiskAccepted).toBeNull();
        expect(
            instanceSecuritySchema.parse({ requireSecondFactor: true, acceptedFactors: [], requirePhone: true }).requirePhone
        ).toBe(true);
    });
});
