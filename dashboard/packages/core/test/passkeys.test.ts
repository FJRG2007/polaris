import { describe, expect, it } from "vitest";
import { passkeyNameKey, passkeyRelyingPartyId } from "../src/passkeys.js";

describe("passkeyRelyingPartyId", () => {
    it("keeps a domain, a LAN name, and a bare label", () => {
        expect(passkeyRelyingPartyId("polaris.example.com")).toBe("polaris.example.com");
        expect(passkeyRelyingPartyId("polaris.local")).toBe("polaris.local");
        expect(passkeyRelyingPartyId("localhost")).toBe("localhost");
    });

    it("drops the parts of an address that are not the relying party", () => {
        expect(passkeyRelyingPartyId("https://Polaris.Local:3000/account")).toBe("polaris.local");
        expect(passkeyRelyingPartyId("  polaris.local.  ")).toBe("polaris.local");
        expect(passkeyRelyingPartyId("polaris.local:8443")).toBe("polaris.local");
    });

    it("refuses an address that is not a name", () => {
        expect(passkeyRelyingPartyId("192.168.1.40")).toBeNull();
        expect(passkeyRelyingPartyId("http://192.168.1.40:3000")).toBeNull();
        expect(passkeyRelyingPartyId("[::1]:3000")).toBeNull();
        expect(passkeyRelyingPartyId("-polaris.local")).toBeNull();
        expect(passkeyRelyingPartyId("pola ris.local")).toBeNull();
        expect(passkeyRelyingPartyId("")).toBeNull();
        expect(passkeyRelyingPartyId(null)).toBeNull();
    });
});

describe("passkeyNameKey", () => {
    it("treats names a person could not tell apart as the same name", () => {
        // The field on the screen and the ceremony on the server both compare
        // through this, so they cannot disagree about what a duplicate is.
        expect(passkeyNameKey("  iPhone ")).toBe(passkeyNameKey("iphone"));
        expect(passkeyNameKey("Work  Laptop")).toBe(passkeyNameKey("work laptop"));
    });

    it("keeps genuinely different names apart", () => {
        expect(passkeyNameKey("iPhone")).not.toBe(passkeyNameKey("iPad"));
        expect(passkeyNameKey("Laptop 1")).not.toBe(passkeyNameKey("Laptop 2"));
    });
});
