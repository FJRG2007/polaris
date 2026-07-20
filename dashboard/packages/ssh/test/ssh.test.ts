import { describe, expect, it } from "vitest";
import { hostKeyAccepted } from "../src/client.js";

// The security-critical pinning decision, isolated as a pure function. A host's
// known_hosts commonly holds several key types (rsa/ecdsa/ed25519) while the
// client negotiates exactly one, so the pin must be a SET the presented key is
// a member of - the single-key regression these tests guard against.
describe("hostKeyAccepted (host-key pinning)", () => {
    const ED = "AAAAed25519key";
    const RSA = "AAAArsakey";

    it("trusts on add when no pin is provided (undefined)", () => {
        expect(hostKeyAccepted(ED, undefined)).toBe(true);
    });

    it("accepts a matching single pin and refuses a changed key", () => {
        expect(hostKeyAccepted(ED, ED)).toBe(true);
        // A changed host key is refused - this is the SFTP blind-TOFU fix.
        expect(hostKeyAccepted(RSA, ED)).toBe(false);
    });

    it("accepts any member of a pinned set (multi-key known_hosts)", () => {
        expect(hostKeyAccepted(ED, [RSA, ED])).toBe(true);
        expect(hostKeyAccepted(RSA, [RSA, ED])).toBe(true);
    });

    it("refuses a key absent from the pinned set", () => {
        expect(hostKeyAccepted("AAAAother", [ED, RSA])).toBe(false);
    });

    it("refuses an empty pin set (fail-closed)", () => {
        expect(hostKeyAccepted(ED, [])).toBe(false);
    });
});
