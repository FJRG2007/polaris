/**
 * What the lock screen offers. A browser offers every enrolled passkey for its
 * address; the desktop app offers only those that have answered in it, since it
 * cannot reach a passkey a browser keeps for itself - offering one opened a
 * system prompt that could only be dismissed.
 */

import { describe, expect, it } from "vitest";
import { passkeyOffer } from "@/lib/vault/passkey-client";
import type { VaultPasskeyEntry } from "@/lib/vault/passkey-schema";

const entry = (credentialId: string): VaultPasskeyEntry => ({
    id: `0190a000-0000-7000-8000-00000000000${credentialId.length}`,
    credentialId,
    rpId: "polaris.example.test",
    prfSalt: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU=",
    wrappedKey: "2.a|b|c"
});
const SYNCED = entry("c3luY2Vk");
const HELLO = entry("aGVsbG8tZGV2aWNl");
const KEY = entry("dXNiLWtleQ");
const base = { usable: [SYNCED, HELLO, KEY], support: "supported" as const, localIds: [], answeredIds: [] };

describe("in a browser", () => {
    it("offers every enrolled passkey, and asks on its own only for one this device holds", () => {
        const offer = passkeyOffer({ ...base, inApp: false, localIds: [HELLO.credentialId] });
        expect(offer).toEqual({ kind: "offer", entries: [SYNCED, HELLO, KEY], automatic: [HELLO] });
    });

    it("still offers the button when none has answered here", () => {
        expect(passkeyOffer({ ...base, inApp: false })).toEqual({
            kind: "offer",
            entries: [SYNCED, HELLO, KEY],
            automatic: []
        });
    });
});

describe("in the desktop app", () => {
    it("says why instead of offering a passkey that only ever answered in a browser", () => {
        expect(passkeyOffer({ ...base, inApp: true })).toEqual({ kind: "not-here" });
    });

    it("offers the passkeys that answered in it, a security key included, and asks on its own for this device's", () => {
        const offer = passkeyOffer({
            ...base,
            inApp: true,
            localIds: [HELLO.credentialId],
            answeredIds: [HELLO.credentialId, KEY.credentialId]
        });
        expect(offer).toEqual({ kind: "offer", entries: [HELLO, KEY], automatic: [HELLO] });
    });
});

describe("anywhere", () => {
    it("offers nothing without an enrolled passkey for this address", () => {
        expect(passkeyOffer({ ...base, usable: [], inApp: false })).toEqual({ kind: "none" });
        expect(passkeyOffer({ ...base, usable: [], inApp: true })).toEqual({ kind: "none" });
    });

    it("gives the reason when passkeys or PRF are missing, before anything else", () => {
        expect(passkeyOffer({ ...base, support: "no-prf", inApp: true })).toEqual({ kind: "blocked", reason: "no-prf" });
        expect(passkeyOffer({ ...base, support: "no-webauthn", inApp: false })).toEqual({
            kind: "blocked",
            reason: "no-webauthn"
        });
    });

    it("offers on a browser that cannot say whether it has PRF", () => {
        expect(passkeyOffer({ ...base, support: "unknown", inApp: false }).kind).toBe("offer");
    });
});
