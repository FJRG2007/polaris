/**
 * A connection's exception to the account's network rules, as a pure rule:
 * what the schema accepts, what a stored value reads as, what matches, and
 * what counts as narrowing it. The end-to-end behaviour on /api/mcp is pinned
 * in flow.test.ts.
 */

import { continentOf } from "@polaris/core";
import { describe, expect, it } from "vitest";
import { parsePresetList } from "@/lib/mcp/oauth/preset-ranges";
import {
    NO_EXCEPTION,
    exceptionAllows,
    exceptionNarrows,
    networkExceptionSchema,
    readNetworkException,
    storedNetworkException,
    type NetworkException
} from "@/lib/mcp/oauth/network-exception";

function exception(input: Partial<NetworkException>): NetworkException {
    return networkExceptionSchema.parse(input);
}

function context(country: string | null, ranges: readonly string[] = []) {
    return {
        country: async () => country,
        presetRanges: async () => ranges,
        continentOf
    };
}

describe("a connection's network exception", () => {
    it("takes known places in any case and refuses unknown ones", () => {
        expect(exception({ allowedCountries: [" us", "US"] }).allowedCountries).toEqual(["US"]);
        expect(exception({ allowedContinents: ["na"] }).allowedContinents).toEqual(["NA"]);
        expect(networkExceptionSchema.safeParse({ allowedCountries: ["XX"] }).success).toBe(false);
        expect(networkExceptionSchema.safeParse({ allowedCidrs: ["nope"] }).success).toBe(false);
        expect(networkExceptionSchema.safeParse({ presets: ["acme"] }).success).toBe(false);
    });

    it("reads an empty or unreadable column as no exception, and stores none as null", () => {
        expect(readNetworkException(null)).toEqual(NO_EXCEPTION);
        expect(readNetworkException("{not json")).toEqual(NO_EXCEPTION);
        expect(readNetworkException('{"allowedCountries":["XX"]}')).toEqual(NO_EXCEPTION);
        expect(storedNetworkException(NO_EXCEPTION)).toBeNull();
        const us = exception({ allowedCountries: ["US"] });
        expect(readNetworkException(storedNetworkException(us))).toEqual(us);
    });

    it("matches any one entry: a country, a continent, an address or a published list", async () => {
        const us = exception({ allowedCountries: ["US"] });
        expect(await exceptionAllows(us, "198.51.100.20", context("US"))).toBe(true);
        expect(await exceptionAllows(us, "198.51.100.20", context("FR"))).toBe(false);
        const northAmerica = exception({ allowedContinents: ["NA"] });
        expect(await exceptionAllows(northAmerica, "198.51.100.20", context("US"))).toBe(true);
        const range = exception({ allowedCidrs: ["198.51.100.0/24"] });
        expect(await exceptionAllows(range, "::ffff:198.51.100.20", context(null))).toBe(true);
        const openai = exception({ presets: ["openai"] });
        expect(
            await exceptionAllows(openai, "203.0.113.4", context(null, ["203.0.113.0/28"]))
        ).toBe(true);
        expect(
            await exceptionAllows(openai, "203.0.113.40", context(null, ["203.0.113.0/28"]))
        ).toBe(false);
    });

    it("never matches an unknown location, a missing address or an empty exception", async () => {
        const us = exception({ allowedCountries: ["US"] });
        expect(await exceptionAllows(us, "198.51.100.20", context(null))).toBe(false);
        expect(await exceptionAllows(us, undefined, context("US"))).toBe(false);
        expect(await exceptionAllows(NO_EXCEPTION, "198.51.100.20", context("US"))).toBe(false);
    });

    it("counts only taking entries away as narrowing", () => {
        const both = exception({ allowedCountries: ["US", "CA"] });
        const us = exception({ allowedCountries: ["US"] });
        expect(exceptionNarrows(both, us)).toBe(true);
        expect(exceptionNarrows(us, NO_EXCEPTION)).toBe(true);
        expect(exceptionNarrows(us, both)).toBe(false);
        expect(exceptionNarrows(NO_EXCEPTION, exception({ presets: ["openai"] }))).toBe(false);
    });
});

describe("OpenAI's published address list", () => {
    it("reads the ranges and skips what is not one", () => {
        expect(
            parsePresetList({
                creationTime: "2026-09-22T18:18:05",
                prefixes: [
                    { ipv4Prefix: "203.0.113.0/28" },
                    { ipv6Prefix: "2001:db8::/32" },
                    { ipv4Prefix: "nonsense" }
                ]
            })
        ).toEqual(["203.0.113.0/28", "2001:db8::/32"]);
    });

    it("refuses a document that is not the list", () => {
        expect(parsePresetList({ prefixes: "all" })).toBeNull();
        expect(parsePresetList({ prefixes: [] })).toBeNull();
        expect(parsePresetList(null)).toBeNull();
    });
});
