/**
 * A fraud verdict on a shared address - a VPN, WARP, a relay, a carrier's NAT - is
 * about everybody on it, so it does not ban the address. A verdict about what the
 * address is (the operator denying VPN or PROXY) still does.
 */

import { describe, expect, it } from "vitest";
import { settleIpVerdict } from "@/lib/integrations/dymo";

describe("settling a Dymo IP verdict", () => {
    it("drops FRAUD and HIGH_RISK_SCORE on a VPN, proxy or mobile address", () => {
        for (const response of [{ vpn: true }, { proxy: true }, { mobile: true }]) {
            expect(
                settleIpVerdict({ allow: false, reasons: ["FRAUD", "HIGH_RISK_SCORE"], response })
            ).toEqual({ allow: true, reasons: [], shared: true });
        }
    });

    it("keeps the operator's own VPN or PROXY rule", () => {
        expect(settleIpVerdict({ allow: false, reasons: ["FRAUD", "VPN"], response: { vpn: true } })).toEqual({
            allow: false,
            reasons: ["VPN"],
            shared: true
        });
    });

    it("keeps a refusal it has nothing to say about", () => {
        expect(settleIpVerdict({ allow: false, reasons: ["COUNTRY:XX"], response: { vpn: true } }).allow).toBe(false);
        expect(settleIpVerdict({ allow: false, reasons: [], response: { proxy: true } }).allow).toBe(false);
    });

    it("bans an unshared address flagged as fraud, as before", () => {
        expect(settleIpVerdict({ allow: false, reasons: ["FRAUD"], response: { vpn: false } })).toEqual({
            allow: false,
            reasons: ["FRAUD"],
            shared: false
        });
        expect(settleIpVerdict({ allow: false, reasons: ["FRAUD"] }).allow).toBe(false);
    });
});
