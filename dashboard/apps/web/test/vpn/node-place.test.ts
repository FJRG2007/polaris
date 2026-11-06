import { describe, expect, it } from "vitest";
import { proxyNameFor } from "@/lib/vpn/proxy-name";
import { matchesOf, placeAt } from "@/lib/vpn/place-search";
import { nodePlaceSchema, parseCoordinates } from "@/lib/vpn/wireguard";

describe("proxyNameFor", () => {
    const base = "sslip.io";

    it("keeps a name of its own", () => {
        expect(
            proxyNameFor({ endpoint: "VPN.Example.com", address: null, taken: false, base })
        ).toBe("vpn.example.com");
    });

    it("names a bare public address by wildcard DNS", () => {
        const name = proxyNameFor({
            endpoint: "203.0.113.9",
            address: "203.0.113.9",
            taken: false,
            base
        });
        expect(name).toMatch(/^vpn-[a-z0-9]+-203-0-113-9\.sslip\.io$/);
    });

    it("names a taken name by the address it resolved to", () => {
        const name = proxyNameFor({
            endpoint: "polaris.example.com",
            address: "198.51.100.4",
            taken: true,
            base
        });
        expect(name).toMatch(/-198-51-100-4\.sslip\.io$/);
    });

    it("falls back to the default base when the deploy base is not a wildcard one", () => {
        const name = proxyNameFor({
            endpoint: "203.0.113.9",
            address: "203.0.113.9",
            taken: false,
            base: "apps.example.com"
        });
        expect(name).toMatch(/\.sslip\.io$/);
    });

    it("has nothing for a private, IPv6 or unresolved address", () => {
        for (const address of ["192.168.1.2", "2001:db8::1", null]) {
            expect(
                proxyNameFor({ endpoint: "taken.example.com", address, taken: true, base })
            ).toBeNull();
        }
    });
});

describe("nodePlaceSchema", () => {
    it("normalizes the country and an empty city", () => {
        expect(
            nodePlaceSchema.parse({ country: " es ", city: "  ", latitude: null, longitude: null })
        ).toEqual({ country: "ES", city: null, latitude: null, longitude: null });
    });

    it("refuses half a spot and coordinates out of range", () => {
        const place = { country: "ES", city: null };
        expect(nodePlaceSchema.safeParse({ ...place, latitude: 41, longitude: null }).success).toBe(
            false
        );
        expect(nodePlaceSchema.safeParse({ ...place, latitude: 91, longitude: 2 }).success).toBe(
            false
        );
        expect(
            nodePlaceSchema.safeParse({ ...place, country: "ESP", latitude: null, longitude: null })
                .success
        ).toBe(false);
    });
});

describe("parseCoordinates", () => {
    it("reads a pasted pair", () => {
        expect(parseCoordinates("41.38, 2.17")).toEqual({ latitude: 41.38, longitude: 2.17 });
        expect(parseCoordinates(" -33.9 151.2 ")).toEqual({ latitude: -33.9, longitude: 151.2 });
    });

    it("leaves a town name and an impossible spot alone", () => {
        expect(parseCoordinates("New York")).toBeNull();
        expect(parseCoordinates("Barcelona")).toBeNull();
        expect(parseCoordinates("95, 10")).toBeNull();
    });
});

describe("place answers", () => {
    it("keeps the matches that name a country", () => {
        expect(
            matchesOf({
                results: [
                    {
                        name: "Paris",
                        latitude: 48.85,
                        longitude: 2.35,
                        country_code: "fr",
                        admin1: "Île-de-France"
                    },
                    { name: "Nowhere", latitude: 0, longitude: 0 }
                ]
            })
        ).toEqual([
            {
                country: "FR",
                city: "Paris",
                region: "Île-de-France",
                latitude: 48.85,
                longitude: 2.35
            }
        ]);
    });

    it("names what is at a spot, and nothing at sea", () => {
        expect(placeAt({ address: { country_code: "es", town: "Sitges\n" } }, 41.2, 1.8)).toEqual({
            country: "ES",
            city: "Sitges",
            region: null,
            latitude: 41.2,
            longitude: 1.8
        });
        expect(placeAt({}, 0, 0)).toBeNull();
    });
});
