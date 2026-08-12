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
    instanceSecuritySchema
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

    it("keeps the authenticator accepted whatever was stored", () => {
        expect(
            instanceSecuritySchema.parse({ requireSecondFactor: true, acceptedFactors: [] }).acceptedFactors
        ).toEqual(["totp"]);
    });
});
