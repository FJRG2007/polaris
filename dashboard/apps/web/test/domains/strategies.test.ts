/**
 * What the guided setup offers per kind of server. The ranking is the product
 * decision being protected here: the recommendation must always be something that
 * can actually work on that server - recommending port forwarding on a carrier-NAT
 * line sends the operator down a path that cannot succeed.
 */

import { describe, expect, it } from "vitest";
import { EXPOSURE_STRATEGIES, strategiesFor, STRATEGY_META } from "../../src/lib/domain-strategies";

describe("strategiesFor", () => {
    it("recommends the operator's own domain on a server that holds a public IP", () => {
        expect(strategiesFor("vps").recommended).toBe("own-domain");
        expect(strategiesFor("cloud").recommended).toBe("own-domain");
    });

    it("recommends port-forwarding the home line rather than a third-party service", () => {
        expect(strategiesFor("home-nat").recommended).toBe("own-domain");
    });

    it("recommends a tunnel behind carrier NAT, where no port can be forwarded", () => {
        const choice = strategiesFor("home-cgnat");
        // Publishing through a server the operator already owns comes first: it is the
        // only option that keeps their domain and traffic out of a third party's hands.
        expect(choice.recommended).toBe("server-tunnel");
        expect(choice.options.filter((option) => option.available).map((option) => option.id)).toContain(
            "cloudflare-tunnel"
        );
        const unavailable = choice.options.filter((option) => !option.available).map((option) => option.id);
        expect(unavailable).toContain("own-domain");
        expect(unavailable).toContain("duckdns");
    });

    it("says why an option cannot be used instead of hiding it", () => {
        const ownDomain = strategiesFor("home-cgnat").options.find((option) => option.id === "own-domain");
        expect(ownDomain?.note).toMatch(/carrier nat/i);
    });

    it("falls back to the zero-setup option until the operator says where the server lives", () => {
        expect(strategiesFor("unknown").recommended).toBe("free-subdomain");
    });

    it("always lists every strategy, best first, with the recommendation available", () => {
        for (const environment of ["vps", "cloud", "home-nat", "home-cgnat", "unknown"] as const) {
            const choice = strategiesFor(environment);
            expect(choice.options).toHaveLength(EXPOSURE_STRATEGIES.length);
            expect(choice.options[0]?.id).toBe(choice.recommended);
            expect(choice.options[0]?.available).toBe(true);
            // Unavailable options sink to the bottom, so the list reads best-first.
            const firstUnavailable = choice.options.findIndex((option) => !option.available);
            if (firstUnavailable !== -1) {
                expect(choice.options.slice(firstUnavailable).every((option) => !option.available)).toBe(true);
            }
        }
    });

    it("keeps a mode on every strategy, so saving one always sets the exposure", () => {
        for (const strategy of EXPOSURE_STRATEGIES) {
            expect(STRATEGY_META[strategy].mode).toBeTruthy();
        }
    });
});
