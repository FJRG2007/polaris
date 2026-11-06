/**
 * A Dymo IP answer is paid for before it is read, so a field that arrives null,
 * as a string or out of range is a place nobody knows, never a thrown answer.
 */

import { describe, expect, it } from "vitest";
import { readIpPlace } from "@/lib/integrations/dymo";

describe("reading the place in a Dymo IP answer", () => {
    it("reads a full answer", () => {
        expect(
            readIpPlace({
                allow: true,
                response: { countryCode: " de ", city: " Berlin ", lat: 52.5, lon: 13.4 }
            })
        ).toEqual({ countryCode: "DE", city: "Berlin", latitude: 52.5, longitude: 13.4 });
    });

    it("keeps the country when the city and the spot are null", () => {
        expect(
            readIpPlace({ response: { countryCode: "ES", city: null, lat: null, lon: null } })
        ).toEqual({ countryCode: "ES", city: null, latitude: null, longitude: null });
    });

    it("reads coordinates sent as strings and drops ones out of range", () => {
        expect(readIpPlace({ response: { countryCode: "FR", lat: "48.8", lon: "2.3" } })).toEqual({
            countryCode: "FR",
            city: null,
            latitude: 48.8,
            longitude: 2.3
        });
        expect(
            readIpPlace({ response: { countryCode: "FR", lat: 120, lon: 2.3 } })?.latitude
        ).toBeNull();
        expect(
            readIpPlace({ response: { countryCode: "FR", lat: "", lon: 2.3 } })?.longitude
        ).toBeNull();
    });

    it("names no place without a country", () => {
        expect(readIpPlace({ response: { countryCode: null, city: "Paris" } })).toBeNull();
        expect(readIpPlace({ response: null })).toBeNull();
        expect(readIpPlace({ response: "not built yet" })).toBeNull();
        expect(readIpPlace(null)).toBeNull();
    });
});
