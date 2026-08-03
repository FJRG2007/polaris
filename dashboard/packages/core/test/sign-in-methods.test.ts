/**
 * How a sign-in reads back.
 *
 * The vocabulary is stored as plain strings on two nullable columns, so the two
 * things worth pinning are that an unknown or missing value degrades to "not
 * recorded" rather than to a label, and that a session with nothing recorded is
 * never presented as one that simply had no second step. On this screen those two
 * are the difference between a shrug and an alarm.
 */

import { describe, expect, it } from "vitest";
import {
    describeSignIn,
    parseSecondFactor,
    parseSignInMethod,
    SECOND_FACTOR_BY_DELIVERY,
    signInSummary
} from "../src/sign-in-methods.js";

describe("reading a stored sign-in", () => {
    it("keeps a value this build knows", () => {
        expect(parseSignInMethod("qr-code")).toBe("qr-code");
        expect(parseSecondFactor("backup-code")).toBe("backup-code");
    });

    it("drops one it does not, rather than passing it through to a screen", () => {
        expect(parseSignInMethod("smoke-signal")).toBeNull();
        expect(parseSecondFactor("carrier-pigeon")).toBeNull();
    });

    it("treats an absent column as nothing recorded", () => {
        expect(parseSignInMethod(null)).toBeNull();
        expect(parseSecondFactor(undefined)).toBeNull();
    });
});

describe("describing a sign-in", () => {
    it("reads first factor then second, in the order they happened", () => {
        expect(describeSignIn({ method: "password", secondFactor: "totp" })).toEqual([
            "Password",
            "Authenticator app"
        ]);
        expect(signInSummary({ method: "password", secondFactor: "totp" })).toBe("Password + Authenticator app");
    });

    it("names the challenge that was skipped rather than leaving it blank", () => {
        expect(signInSummary({ method: "password", secondFactor: "trusted-device" })).toBe(
            "Password + Remembered device"
        );
    });

    it("carries a method that needs no second step on its own", () => {
        expect(signInSummary({ method: "qr-code", secondFactor: null })).toBe("QR code");
        expect(signInSummary({ method: "passkey", secondFactor: null })).toBe("Passkey");
    });

    // The one that matters: silence here would read as "signed in with a password
    // and nothing else", which is a claim nobody made.
    it("says nothing was recorded instead of implying nothing was asked for", () => {
        expect(describeSignIn({ method: null, secondFactor: null })).toEqual([]);
        expect(signInSummary({ method: null, secondFactor: null })).toBe("Sign-in not recorded");
    });
});

describe("the channel a sent code went out on", () => {
    it("becomes the second factor it amounts to", () => {
        expect(SECOND_FACTOR_BY_DELIVERY.email).toBe("email-code");
        expect(SECOND_FACTOR_BY_DELIVERY.whatsapp).toBe("whatsapp-code");
    });

    it("leaves a channel this build does not deliver on unmapped", () => {
        expect(SECOND_FACTOR_BY_DELIVERY.totp).toBeUndefined();
    });
});
