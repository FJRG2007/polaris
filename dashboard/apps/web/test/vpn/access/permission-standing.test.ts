/**
 * The VPN reads `vpn.use` the way every other app reads its own permission, so
 * switching it Off for somebody under Management > Users actually takes the
 * VPN away - before this, the switch was listed and did nothing.
 */

import { describe, expect, it } from "vitest";
import { vpnStanding } from "@/lib/vpn/wireguard";

const base = {
    isAdmin: false,
    hasRow: false,
    open: false,
    permission: "implicit-deny" as const,
    accountAllows: false
};

describe("VPN standing with vpn.use", () => {
    it("shuts a denied account out, even with access given on the VPN screen or open access", () => {
        expect(vpnStanding({ ...base, hasRow: true, permission: "deny" })).toBe("none");
        expect(vpnStanding({ ...base, open: true, permission: "deny" })).toBe("none");
    });

    it("keeps the access the VPN screen gave, and open access for anybody not denied", () => {
        expect(vpnStanding({ ...base, hasRow: true })).toBe("row");
        expect(vpnStanding({ ...base, open: true })).toBe("open");
    });

    it("gives the defaults to an account switched On, and nothing for a role grant alone", () => {
        expect(vpnStanding({ ...base, permission: "allow", accountAllows: true })).toBe("open");
        expect(vpnStanding({ ...base, permission: "allow" })).toBe("none");
    });

    it("always lets an administrator in", () => {
        expect(vpnStanding({ ...base, isAdmin: true, permission: "deny" })).toBe("open");
        expect(vpnStanding({ ...base, isAdmin: true, hasRow: true })).toBe("row");
    });
});
