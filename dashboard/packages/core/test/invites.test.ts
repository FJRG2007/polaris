/**
 * What an invite is allowed to be, and what a recipient is allowed to type. The
 * schema is the only thing standing between an operator's intent and an account
 * that can sign in from anywhere, so the defaults matter as much as the refusals:
 * an invite created without advanced options must come out unrestricted, and one
 * created with them must keep every rule it was given.
 */

import { describe, expect, it } from "vitest";
import {
    claimInviteSchema,
    createInviteSchema,
    formatInviteCode,
    INVITE_CODE_LENGTH,
    inviteCodeField,
    inviteOneTimePasswordField,
    normalizeInviteCode
} from "../src/schemas/auth.js";

describe("creating an invite", () => {
    it("defaults to a plain, unrestricted link invite", () => {
        const parsed = createInviteSchema.parse({ email: "ada@example.com" });
        expect(parsed.role).toBe("member");
        expect(parsed.method).toBe("link");
        expect(parsed.oneTimePassword).toBeUndefined();
        expect(parsed.allowedCidrs).toEqual([]);
        expect(parsed.allowedCountries).toEqual([]);
        expect(parsed.allowedContinents).toEqual([]);
        expect(parsed.groupIds).toEqual([]);
    });

    it("keeps the restrictions it was given, normalized the usual way", () => {
        const parsed = createInviteSchema.parse({
            email: "  Ada@Example.com ",
            method: "code",
            allowedCidrs: ["10.0.0.0/8", "10.0.0.0/8"],
            allowedCountries: ["es", "PT"],
            allowedContinents: ["eu"]
        });
        expect(parsed.email).toBe("Ada@Example.com".trim());
        expect(parsed.method).toBe("code");
        expect(parsed.allowedCidrs).toEqual(["10.0.0.0/8"]);
        expect(parsed.allowedCountries).toEqual(["ES", "PT"]);
        expect(parsed.allowedContinents).toEqual(["EU"]);
    });

    it("refuses a method it does not know and a rule it cannot enforce", () => {
        expect(createInviteSchema.safeParse({ email: "ada@example.com", method: "carrier-pigeon" }).success).toBe(
            false
        );
        expect(
            createInviteSchema.safeParse({ email: "ada@example.com", allowedCidrs: ["example.com"] }).success
        ).toBe(false);
        expect(
            createInviteSchema.safeParse({ email: "ada@example.com", allowedCountries: ["XX"] }).success
        ).toBe(false);
    });

    it("holds a one-time password to a length worth asking for", () => {
        expect(inviteOneTimePasswordField.safeParse("hunter").success).toBe(true);
        expect(inviteOneTimePasswordField.safeParse("short").success).toBe(false);
    });
});

describe("invitation codes", () => {
    it("reads a code however it was written down", () => {
        expect(normalizeInviteCode("abcd-efgh jkmn")).toBe("ABCDEFGHJKMN");
        expect(normalizeInviteCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
    });

    it("groups a code so it can be read out loud", () => {
        expect(formatInviteCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
        // Round-trips: what is shown normalizes back to what was issued.
        expect(normalizeInviteCode(formatInviteCode("ABCDEFGHJKMN"))).toBe("ABCDEFGHJKMN");
    });

    it("accepts a full code in any shape and refuses a partial one", () => {
        const parsed = inviteCodeField.safeParse("abcd-efgh-jkmn");
        expect(parsed.success && parsed.data).toBe("ABCDEFGHJKMN");
        expect("ABCDEFGHJKMN".length).toBe(INVITE_CODE_LENGTH);
        expect(inviteCodeField.safeParse("ABCD-EFGH").success).toBe(false);
        expect(inviteCodeField.safeParse("").success).toBe(false);
    });
});

describe("claiming an invite", () => {
    it("takes the profile plus whatever proves the claim", () => {
        const parsed = claimInviteSchema.parse({
            name: "Ada Lovelace",
            username: "ADA",
            password: "correct horse battery",
            code: "abcd-efgh-jkmn",
            oneTimePassword: "hunter2"
        });
        expect(parsed.username).toBe("ada");
        expect(parsed.code).toBe("abcd-efgh-jkmn");
        expect(parsed.oneTimePassword).toBe("hunter2");
        expect(parsed.token).toBe("");
    });

    it("still refuses a password too short to be one", () => {
        expect(
            claimInviteSchema.safeParse({ name: "Ada", username: "ada", password: "short" }).success
        ).toBe(false);
    });
});
