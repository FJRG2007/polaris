import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { VpnNode } from "@/lib/vpn";
import * as places from "@/lib/vpn-places";
import { describe, expect, it } from "vitest";

function node(id: string, extra: Partial<VpnNode> = {}): VpnNode {
    return {
        id,
        name: `Server ${id}`,
        exit: "direct",
        browser: true,
        browserIssue: null,
        country: null,
        city: null,
        ...extra
    };
}

const NODES = [
    node("a", { country: "ES", city: "Valencia" }),
    node("b", { country: "ES", city: "Madrid" }),
    node("c", { country: "DE", city: "Berlin", browser: false, browserIssue: "edge" }),
    node("d"),
    node("e", { country: "BR", city: "São Paulo" })
];

describe("countryCode", () => {
    it("takes a two-letter code in any case and nothing else", () => {
        expect(places.countryCode(" es ")).toBe("ES");
        expect(places.countryCode("Spain")).toBeNull();
        expect(places.countryCode("../x")).toBeNull();
        expect(places.countryCode(null)).toBeNull();
    });
});

describe("placeOf", () => {
    it("writes the city and the country in the reader's language", () => {
        expect(places.placeOf(NODES[1]!, "en-US")).toBe("Madrid, Spain");
        expect(places.placeOf(NODES[1]!, "es-ES")).toBe("Madrid, España");
        expect(places.placeOf(node("x", { country: "FR" }), "en-US")).toBe("France");
        expect(places.placeOf(node("x"), "en-US")).toBeNull();
    });
});

describe("groupByCountry", () => {
    const countries = places.groupByCountry(NODES, "en-US", "Other locations");

    it("sorts countries by name with the unplaced last, and cities inside", () => {
        expect(countries.map((one) => one.code)).toEqual(["BR", "DE", "ES", null]);
        expect(countries[2]!.nodes.map((one) => one.city)).toEqual(["Madrid", "Valencia"]);
        expect(countries[3]!.name).toBe("Other locations");
    });

    it("counts the servers a browser can use", () => {
        expect(countries.map((one) => [one.nodes.length, one.usable])).toEqual([
            [1, 1],
            [1, 0],
            [2, 2],
            [1, 1]
        ]);
    });
});

describe("searchCountries", () => {
    const countries = places.groupByCountry(NODES, "es-ES", "Otras");

    it("keeps a whole country when its name matches, ignoring accents", () => {
        const found = places.searchCountries(countries, "espana");
        expect(found.map((one) => one.code)).toEqual(["ES"]);
        expect(found[0]!.nodes).toHaveLength(2);
    });

    it("keeps only the matching servers when a city or name matches", () => {
        const found = places.searchCountries(countries, "madr");
        expect(found[0]!.nodes.map((one) => one.id)).toEqual(["b"]);
        expect(places.searchCountries(countries, "sao").map((one) => one.code)).toEqual(["BR"]);
        expect(places.searchCountries(countries, "server d").map((one) => one.code)).toEqual([
            null
        ]);
    });

    it("finds by code, and nothing for nonsense; everything for no query", () => {
        expect(places.searchCountries(countries, "de").map((one) => one.code)).toContain("DE");
        expect(places.searchCountries(countries, "zzz")).toEqual([]);
        expect(places.searchCountries(countries, "  ")).toHaveLength(countries.length);
    });
});

describe("quick connect and random", () => {
    it("goes back to the most recent usable server", () => {
        expect(places.quickPick(NODES, ["c", "b", "a"])?.id).toBe("b");
    });

    it("picks at random when no recent one is usable", () => {
        expect(places.quickPick(NODES, ["c", "gone"], () => 0)?.id).toBe("a");
    });

    it("never picks an unusable server or the one in use", () => {
        const seen = new Set<string>();
        for (const roll of [0, 0.2, 0.4, 0.6, 0.8, 0.999])
            seen.add(places.randomPick(NODES, "a", () => roll)!.id);
        expect([...seen].sort()).toEqual(["b", "d", "e"]);
        expect(places.randomPick([NODES[2]!], null)).toBeNull();
        expect(places.randomPick([], null)).toBeNull();
    });
});

describe("recents", () => {
    it("puts the newest first without repeats and keeps three", () => {
        expect(places.pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
        expect(places.pushRecent(["a", "b", "c"], "d")).toEqual(["d", "a", "b"]);
    });

    it("reads what was stored defensively", () => {
        expect(places.readRecents(["a", 1, "", "b"])).toEqual(["a", "b"]);
        expect(places.readRecents("a")).toEqual([]);
        expect(places.recentNodes(NODES, ["gone", "e"]).map((one) => one.id)).toEqual(["e"]);
    });
});

describe("flags", () => {
    it("names a vendored flag for every code it can draw, and none otherwise", () => {
        expect(places.flagPath("es")).toBe("/flags/es.svg");
        expect(places.flagPath(null)).toBeNull();
        expect(places.flagPath("../../x")).toBeNull();
        const vendored = new Set(readdirSync(join(import.meta.dirname, "../public/flags")));
        for (const code of ["ES", "US", "DE", "BR", "JP", "GB", "FR", "NL"])
            expect(vendored.has(places.flagPath(code)!.slice("/flags/".length))).toBe(true);
    });
});

describe("time connected", () => {
    const START = 1_800_000_000_000;

    it("counts whole minutes, and nothing without a start", () => {
        expect(places.elapsedMinutes(null, START)).toBeNull();
        expect(places.elapsedMinutes(Number.NaN, START)).toBeNull();
        expect(places.elapsedMinutes(START, START + 59_999)).toBe(0);
        expect(places.elapsedMinutes(START, START + 12 * 60_000 + 5)).toBe(12);
        expect(places.elapsedMinutes(START, START - 60_000)).toBe(0);
    });

    it("reads as minutes, hours and days in the popup's language", () => {
        const minute = (n: number, locale: string) =>
            new Intl.NumberFormat(locale, {
                style: "unit",
                unit: "minute",
                unitDisplay: "short"
            }).format(n);
        const hour = (n: number, locale: string) =>
            new Intl.NumberFormat(locale, {
                style: "unit",
                unit: "hour",
                unitDisplay: "short"
            }).format(n);
        expect(places.formatElapsed(12, "en-US")).toBe(minute(12, "en-US"));
        expect(places.formatElapsed(12, "en-US")).toMatch(/12/);
        expect(places.formatElapsed(120, "es-ES")).toBe(hour(2, "es-ES"));
        expect(places.formatElapsed(125, "es-ES")).toBe(
            `${hour(2, "es-ES")} ${minute(5, "es-ES")}`
        );
        expect(places.formatElapsed(3 * 24 * 60 + 7, "en-US")).toBe("3 days");
        for (const minutes of [1, 59, 60, 61, 1439, 1440, 100_000])
            expect(places.formatElapsed(minutes, "en-US")).not.toMatch(/NaN|^0/);
    });
});
