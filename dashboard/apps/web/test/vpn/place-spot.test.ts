/**
 * Where a VPN place is drawn: its own coordinates when it has them; for one that
 * kept only a town and a country, the town's, looked up behind the read and
 * never waited on, and only when the town found is in that country.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const search = vi.hoisted(() => vi.fn());
vi.mock("@/lib/safe-fetch", () => ({
    follow: async (url: URL) =>
        new Response(JSON.stringify(search(url.searchParams.get("name"))), { status: 200 }),
    readCapped: async (response: Response) => new Uint8Array(await response.arrayBuffer())
}));

const { spotOf } = await import("@/lib/vpn/place-search");

beforeEach(() => search.mockReset());

describe("spotOf", () => {
    it("uses a place's own coordinates without asking anybody", () => {
        expect(spotOf({ country: "ES", city: "Madrid", latitude: 1, longitude: 2 })).toEqual({
            latitude: 1,
            longitude: 2
        });
        expect(search).not.toHaveBeenCalled();
    });

    it("has nothing to look up without a town", () => {
        expect(spotOf({ country: "ES", city: null })).toBeNull();
        expect(search).not.toHaveBeenCalled();
    });

    it("answers at once and draws the town from the next read", async () => {
        search.mockReturnValue({
            results: [
                { name: "Valencia", latitude: 10.16, longitude: -68, country_code: "VE" },
                { name: "Valencia", latitude: 39.47, longitude: -0.38, country_code: "ES" }
            ]
        });
        expect(spotOf({ country: "ES", city: "Valencia" })).toBeNull();
        await vi.waitFor(() =>
            expect(spotOf({ country: "ES", city: "Valencia" })).toEqual({
                latitude: 39.47,
                longitude: -0.38
            })
        );
        expect(search).toHaveBeenCalledTimes(1);
    });

    it("keeps a town found only in another country as unknown, without asking again", async () => {
        search.mockReturnValue({
            results: [{ name: "Paris", latitude: 33.66, longitude: -95.55, country_code: "US" }]
        });
        expect(spotOf({ country: "FR", city: "Paris" })).toBeNull();
        await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(spotOf({ country: "FR", city: "Paris" })).toBeNull();
        expect(search).toHaveBeenCalledTimes(1);
    });
});
