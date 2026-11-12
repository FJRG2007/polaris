/**
 * "Add a city" for any place: the geocoder is asked through the host's guarded
 * fetch, its answer is checked before use, a zone this runtime cannot read is
 * dropped, an answer is kept for a while, and a failure reads as a sentence.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", async () => (await import("../fixtures/fake-db")).dbModule);
vi.mock("@polaris/app-host", async () => (await import("../fixtures/fake-host")).hostModule);
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => false }));

import * as world from "../fixtures/world";
import { hostModule } from "../fixtures/fake-host";
import { addUser, signIn } from "../fixtures/fake-host";
import * as places from "@polaris-app/calendar/src/lib/clock/places";
import { readPreferences } from "@polaris-app/calendar/src/lib/preferences";
import { searchPlacesAction } from "@polaris-app/calendar/src/actions/places";

const follow = vi.fn();

function answer(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

const ALCOBENDAS = {
    name: "Alcobendas",
    latitude: 40.54,
    longitude: -3.64,
    timezone: "Europe/Madrid",
    admin1: "Madrid",
    country: "Spain"
};

beforeEach(() => {
    world.resetWorld();
    places.clearPlaceCache();
    follow.mockReset();
    (hostModule.host as Record<string, unknown>).safeFetch = {
        follow,
        readCapped: async (response: Response, max: number) => {
            const bytes = new Uint8Array(await response.arrayBuffer());
            return bytes.length > max ? null : bytes;
        }
    };
});

describe("place search", () => {
    it("asks the geocoder by name and language and answers each place with its zone", async () => {
        follow.mockResolvedValue(
            answer({
                results: [
                    ALCOBENDAS,
                    { ...ALCOBENDAS, name: "Nowhere", timezone: "Mars/Olympus" },
                    { ...ALCOBENDAS, name: "Madrid", admin1: "Madrid", timezone: undefined }
                ]
            })
        );
        const found = await places.searchPlaces("Alcobendas", "es");

        const url = follow.mock.calls[0]![0] as URL;
        expect(url.origin + url.pathname).toBe("https://geocoding-api.open-meteo.com/v1/search");
        expect(url.searchParams.get("name")).toBe("Alcobendas");
        expect(url.searchParams.get("language")).toBe("es");
        expect(found).toEqual([
            {
                name: "Alcobendas",
                region: "Madrid",
                country: "Spain",
                zone: "Europe/Madrid",
                latitude: 40.54,
                longitude: -3.64
            }
        ]);
        expect(places.placeLabel(found[0]!)).toBe("Alcobendas, Madrid, Spain");
    });

    it("keeps an answer for a while, so the same search asks once", async () => {
        follow.mockImplementation(async () => answer({ results: [ALCOBENDAS] }));
        await places.searchPlaces("alcobendas", "en", 0);
        await places.searchPlaces("Alcobendas", "en", 60_000);
        expect(follow).toHaveBeenCalledTimes(1);
        await places.searchPlaces("Alcobendas", "en", 11 * 60_000);
        expect(follow).toHaveBeenCalledTimes(2);
    });

    it("answers no places, not an error, when the geocoder knows none", async () => {
        follow.mockResolvedValue(answer({ generationtime_ms: 0.4 }));
        expect(await places.searchPlaces("Qwxz", "en")).toEqual([]);
    });

    it("fails readably when the geocoder is down, refused or answers nonsense", async () => {
        signIn(addUser({ name: "Alice", email: "alice@example.test" }));
        for (const outcome of [
            () => follow.mockResolvedValue(null),
            () => follow.mockResolvedValue(answer({ error: true }, 503)),
            () => follow.mockResolvedValue(answer({ results: "nope" })),
            () => follow.mockRejectedValue(new Error("ECONNRESET 10.0.0.1"))
        ]) {
            places.clearPlaceCache();
            outcome();
            const result = await searchPlacesAction({ query: "Alcobendas", language: "en-US" });
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toMatch(/could not be looked up/);
                expect(result.error).not.toMatch(/ECONNRESET|10\.0\.0\.1/);
            }
        }
    });

    it("refuses a query too short or too long before asking anybody", async () => {
        signIn(addUser({ name: "Alice", email: "alice@example.test" }));
        expect((await searchPlacesAction({ query: "a", language: "en" })).ok).toBe(false);
        expect((await searchPlacesAction({ query: "a".repeat(81), language: "en" })).ok).toBe(
            false
        );
        expect((await searchPlacesAction({ query: "Paris", language: "<x>" })).ok).toBe(false);
        expect(follow).not.toHaveBeenCalled();
    });

    it("stores a chosen place's name beside its zone, and drops a bad one on read", () => {
        const read = readPreferences(
            JSON.stringify({
                worldClock: ["Europe/Madrid"],
                worldClockNames: { "Europe/Madrid": "Alcobendas, Madrid, Spain" }
            })
        );
        expect(read.worldClockNames).toEqual({ "Europe/Madrid": "Alcobendas, Madrid, Spain" });
        expect(readPreferences(JSON.stringify({ worldClockNames: "x" })).worldClockNames).toEqual(
            {}
        );
        expect(readPreferences(null).worldClockNames).toEqual({});
    });
});
