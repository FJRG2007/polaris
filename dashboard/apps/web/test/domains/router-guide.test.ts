/**
 * The per-brand router instructions.
 *
 * The panel opens on whatever the router called itself, so a header that names a
 * brand has to reach that brand's page, and one that names nothing must land on the
 * generic instructions rather than on a wrong menu path - being confidently sent to
 * a menu that does not exist is worse than being told to go looking.
 */

import { describe, expect, it } from "vitest";
import { detectRouterBrand, likelyGateway, routerGuide, ROUTER_BRANDS } from "../../src/lib/router-guide";

describe("recognizing the router", () => {
    it("reads the brand out of the header the firmware sends", () => {
        // Verbatim from a ZTE HGU, which is what a Spanish fibre line usually ships.
        expect(detectRouterBrand("ZTE web server 1.0 ZTE corp 2015.")).toBe("zte");
        expect(detectRouterBrand("Huawei EchoLife")).toBe("huawei");
        expect(detectRouterBrand("Mikrotik HttpProxy")).toBe("mikrotik");
    });

    it("falls back to the generic instructions rather than guessing", () => {
        expect(detectRouterBrand(null)).toBe("other");
        expect(detectRouterBrand("nginx/1.24.0")).toBe("other");
    });
});

describe("the instructions themselves", () => {
    it("always resolves to a guide, whatever it is asked for", () => {
        for (const brand of ROUTER_BRANDS) {
            expect(routerGuide(brand.id).id).toBe(brand.id);
        }
    });

    it("warns that an ISP's ZTE reserves the two ports Polaris needs", () => {
        // The firmware refuses to forward 80 and 443 at all, so an operator following
        // the steps would otherwise fight a form that can never accept them.
        expect(routerGuide("zte").caution).toMatch(/80, 443/);
    });

    it("is written in English, whatever market the router ships in", () => {
        // The menus are read off the router's own page, which the operator can switch
        // to their language; a half-translated path matches neither.
        for (const brand of ROUTER_BRANDS) {
            expect(brand.forwardPath).not.toMatch(/Reenvio|Seguridad|puertos/i);
        }
    });
});

describe("giving the server a fixed address", () => {
    it("names a reservation path for every brand", () => {
        // "Reserve it in the DHCP settings" is not an instruction anyone can follow:
        // the tab is rarely the one called DHCP.
        for (const brand of ROUTER_BRANDS) {
            expect(brand.reserve.path.length).toBeGreaterThan(0);
        }
    });

    it("sends a ZTE to the binding tab, not the DHCP server tab", () => {
        const reserve = routerGuide("zte").reserve;

        expect(reserve.path).toBe("Local Network > LAN > DHCP Binding");
        expect(reserve.kind).toBe("form");
        if (reserve.kind !== "form") return;
        // The three fields that form asks for, and the button that commits them.
        expect(reserve.fields.map((field) => field.label)).toEqual(["Name", "MAC Address", "IP Address"]);
        expect(reserve.save).toBe("Create New Item");
    });

    it("asks for an address on every form-style brand, since that is the point", () => {
        for (const brand of ROUTER_BRANDS) {
            if (brand.reserve.kind !== "form") continue;
            expect(brand.reserve.fields.some((field) => field.value === "ip")).toBe(true);
            expect(brand.reserve.fields.some((field) => field.value === "mac")).toBe(true);
        }
    });
});

describe("the forwarding form", () => {
    it("uses ZTE's own labels, which match none of the generic ones", () => {
        const guide = routerGuide("zte");

        expect(guide.forwardFields?.map((field) => field.label)).toEqual([
            "Name",
            "Protocol",
            "WAN Host IP Address",
            "LAN Host",
            "WAN Port",
            "LAN Host Port"
        ]);
        // Both port fields are ranges on this firmware, and the WAN source has to be
        // left open or the rule only answers one address.
        expect(guide.forwardFields?.filter((field) => field.value === "portRange")).toHaveLength(2);
        expect(guide.forwardFields?.some((field) => field.value === "anySource")).toBe(true);
        expect(guide.forwardSave).toBe("Create New Item");
    });

    it("leaves the generic labels in place for brands that fit them", () => {
        expect(routerGuide("tplink").forwardFields).toBeNull();
        expect(routerGuide("other").forwardFields).toBeNull();
    });
});

describe("finding the router's own address", () => {
    it("proposes the gateway from this server's address", () => {
        expect(likelyGateway("192.168.1.142")).toBe("192.168.1.1");
        expect(likelyGateway("10.0.5.7")).toBe("10.0.5.1");
    });

    it("proposes nothing when the address is unknown or malformed", () => {
        expect(likelyGateway(null)).toBeNull();
        expect(likelyGateway("not-an-ip")).toBeNull();
    });
});
