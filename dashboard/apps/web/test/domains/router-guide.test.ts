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
