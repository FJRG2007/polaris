/**
 * The credential a client gets when it is let into the vault.
 *
 * Two rules decide things no screen can show, so both are pinned here.
 *
 * The first is what gets hidden from Account > API keys. Hiding too much is the
 * dangerous direction: a credential its owner created, that happens to mention
 * the extension, must never vanish from the one list they manage it in.
 *
 * The second is what gets replaced when the same browser connects again. Match
 * too loosely and reconnecting one client revokes another's; match not at all
 * and the list grows a credential every time somebody presses the button.
 */

import { describe, expect, it } from "vitest";
import {
    CLIENT_KEY_SCOPES,
    clientKeyMark,
    clientKeyName,
    isClientKey,
    isClientKeyFor
} from "@/lib/vault/client-key";

describe("what counts as a client's credential", () => {
    it("recognises one it issued", () => {
        expect(isClientKey(clientKeyMark("device-abc"))).toBe(true);
    });

    it("leaves a key its owner made alone", () => {
        // The costly direction: this rule decides what disappears from the only
        // screen somebody manages their own credentials on.
        expect(isClientKey("my own key for the extension")).toBe(false);
        expect(isClientKey("polaris client")).toBe(false);
        expect(isClientKey("")).toBe(false);
    });

    it("reads a description that picked up whitespace", () => {
        expect(isClientKey(`  ${clientKeyMark("device-abc")}  `)).toBe(true);
    });
});

describe("which client a credential belongs to", () => {
    it("matches the client it was issued to", () => {
        expect(isClientKeyFor(clientKeyMark("device-abc"), "device-abc")).toBe(true);
    });

    it("does not match another client", () => {
        expect(isClientKeyFor(clientKeyMark("device-abc"), "device-xyz")).toBe(false);
    });

    it("does not match on a prefix of the identifier", () => {
        // Otherwise connecting `device-abc` would revoke `device-abc-2`.
        expect(isClientKeyFor(clientKeyMark("device-abc-2"), "device-abc")).toBe(false);
    });

    it("refuses a description that is not a mark at all", () => {
        expect(isClientKeyFor("something else", "device-abc")).toBe(false);
    });
});

describe("what it is called", () => {
    it("names the client it was issued to", () => {
        expect(clientKeyName("Brave on Windows")).toBe("Polaris client - Brave on Windows");
    });

    it("still says something for a client that gave no name", () => {
        expect(clientKeyName("")).toBe("Polaris client");
        expect(clientKeyName("   ")).toBe("Polaris client");
    });

    it("stays inside what the schema accepts", () => {
        // The create schema caps a name at 60. Going over would fail the
        // approval itself, over a label.
        const long = clientKeyName("A".repeat(200));
        expect(long.length).toBeLessThanOrEqual(60);
        expect(long.endsWith("...")).toBe(true);
    });
});

describe("what it may do", () => {
    it("carries the vault and nothing else", () => {
        // The whole argument for issuing this automatically is that it reaches
        // no further than the client already does.
        expect([...CLIENT_KEY_SCOPES]).toEqual(["vault.use"]);
    });
});
