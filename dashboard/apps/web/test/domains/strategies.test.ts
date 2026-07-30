/**
 * What the guided setup offers per kind of server. The ranking is the product
 * decision being protected here: the recommendation must always be something that
 * can actually work on that server - recommending port forwarding on a carrier-NAT
 * line sends the operator down a path that cannot succeed.
 */

import { describe, expect, it } from "vitest";
import {
    approachesFor,
    approachOf,
    EXPOSURE_STRATEGIES,
    strategiesFor,
    STRATEGY_META
} from "../../src/lib/domain-strategies";

const ENVIRONMENTS = ["vps", "cloud", "home-nat", "home-cgnat", "unknown"] as const;

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
        expect(choice.recommended).toBe("cloudflare-tunnel");
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
        for (const environment of ENVIRONMENTS) {
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

describe("approachesFor", () => {
    it("splits every strategy onto exactly one side, losing none", () => {
        for (const environment of ENVIRONMENTS) {
            const ids = approachesFor(environment).options.flatMap((option) =>
                option.strategies.map((strategy) => strategy.id)
            );
            expect(ids).toHaveLength(EXPOSURE_STRATEGIES.length);
            expect(new Set(ids).size).toBe(EXPOSURE_STRATEGIES.length);
        }
    });

    it("agrees with the ranked list about which side wins", () => {
        for (const environment of ENVIRONMENTS) {
            const choice = approachesFor(environment);
            expect(choice.recommended).toBe(approachOf(strategiesFor(environment).recommended));
        }
    });

    it("offers the router on a home line and a tunnel as the alternative", () => {
        const choice = approachesFor("home-nat");
        expect(choice.recommended).toBe("ports");
        expect(choice.options.find((option) => option.id === "tunnel")?.best).toBe("cloudflare-tunnel");
    });

    it("says the port side leads nowhere behind carrier NAT instead of promising it works", () => {
        const choice = approachesFor("home-cgnat");
        expect(choice.recommended).toBe("tunnel");
        const ports = choice.options.find((option) => option.id === "ports");
        expect(ports?.note).toMatch(/no port can be forwarded/i);
        // Still selectable: what is left on that side serves the local network, which
        // is a real answer for a box nobody outside is meant to reach.
        expect(ports?.best).toBe("free-subdomain");
    });

    it("does not send a data-centre server looking for a router it does not have", () => {
        for (const environment of ["vps", "cloud"] as const) {
            const ports = approachesFor(environment).options.find((option) => option.id === "ports");
            expect(ports?.note).toMatch(/no router/i);
        }
    });

    it("always has something to select on either side, and it is one that works", () => {
        // Both sides carry an option that asks nothing of the server - a free
        // subdomain, a quick tunnel - so neither is ever a dead card.
        for (const environment of ENVIRONMENTS) {
            for (const option of approachesFor(environment).options) {
                expect(option.strategies.find((strategy) => strategy.id === option.best)?.available).toBe(true);
            }
        }
    });

    it("states a cost against every upside, so neither side reads as free", () => {
        for (const option of approachesFor("home-nat").options) {
            expect(option.meta.pros.length).toBeGreaterThan(0);
            expect(option.meta.cons.length).toBeGreaterThan(0);
        }
    });
});
