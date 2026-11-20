/**
 * The VPN is decided by `vpn.use` alone, the way every other app is decided by
 * its own permission: a limits row on the VPN's screen grants nothing by itself,
 * and there is no open switch beside it.
 */

import { describe, expect, it } from "vitest";
import { vpnGrantOf, vpnStanding } from "@/lib/vpn/wireguard";

const base = { isAdmin: false, hasRow: false, permission: "implicit-deny" as const };

const allow = (action: string) => ({
    effect: "allow" as const,
    actions: [action],
    resources: ["*"]
});
const deny = (action: string) => ({ effect: "deny" as const, actions: [action], resources: ["*"] });

describe("VPN standing with vpn.use", () => {
    it("shuts a denied account out, limits row or not", () => {
        expect(vpnStanding({ ...base, hasRow: true, permission: "deny" })).toBe("none");
        expect(vpnStanding({ ...base, permission: "deny" })).toBe("none");
    });

    it("gives nothing for a limits row alone", () => {
        expect(vpnStanding({ ...base, hasRow: true })).toBe("none");
    });

    it("gives the defaults to somebody who holds it, and their row when they have one", () => {
        expect(vpnStanding({ ...base, permission: "allow" })).toBe("defaults");
        expect(vpnStanding({ ...base, permission: "allow", hasRow: true })).toBe("row");
    });

    it("always lets an administrator in", () => {
        expect(vpnStanding({ ...base, isAdmin: true, permission: "deny" })).toBe("defaults");
        expect(vpnStanding({ ...base, isAdmin: true, hasRow: true })).toBe("row");
    });
});

describe("reading vpn.use out of the statements", () => {
    it("takes an allow only from a statement that names the VPN", () => {
        expect(vpnGrantOf([allow("vpn.use")])).toBe("allow");
        expect(vpnGrantOf([allow("vpn.*")])).toBe("allow");
        expect(vpnGrantOf([allow("*")])).toBe("implicit-deny");
        expect(vpnGrantOf([allow("drive.read")])).toBe("implicit-deny");
        expect(vpnGrantOf([])).toBe("implicit-deny");
    });

    it("takes any deny, a wildcard included, over an allow", () => {
        expect(vpnGrantOf([allow("vpn.use"), deny("vpn.use")])).toBe("deny");
        expect(vpnGrantOf([allow("vpn.use"), deny("*")])).toBe("deny");
    });
});
