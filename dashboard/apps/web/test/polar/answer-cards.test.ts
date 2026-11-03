/**
 * The answer cards in the catalogue: a translation, the weather, the time in
 * other places and a conversion each take a whole payload, refuse one that
 * does not hold together (an unknown zone, a weather code WMO does not define,
 * a wrong conversion, a currency rate with no source), and read as Markdown.
 */

import { describe, expect, it } from "vitest";

const visuals = await import("@/lib/polar/visuals");
const { convertUnit } = await import("@/lib/polar/units");
const zones = await import("@/lib/polar/zones");
const { polarVisualTools } = await import("@/lib/polar/visual-tool");
const { polarSystemPrompt } = await import("@/lib/polar/prompt");

const translation = {
    view: {
        kind: "translation",
        from: "en",
        to: "es",
        source: "Hello, how are you?",
        translation: "Hola, ¿cómo estás?",
        alternatives: ["Hola, ¿qué tal?"],
        notes: "Informal (tú)."
    }
};
const weather = {
    title: "Weather",
    view: {
        kind: "weather",
        place: "Madrid, Comunidad de Madrid, Spain",
        asOf: "2026-11-03T10:45",
        units: "metric",
        current: { temperature: 10.1, apparent: 5.6, code: 0, wind: 15, humidity: 46 },
        days: [
            { date: "2026-11-03", min: 6.3, max: 14.4, code: 3, precipitation: 0 },
            { date: "2026-11-04", min: 3.8, max: 14, code: 61, precipitation: 87 }
        ]
    }
};
const time = {
    view: {
        kind: "time",
        at: "2026-11-03T15:00",
        places: [
            { label: "Madrid", zone: "Europe/Madrid" },
            { label: "Tokyo", zone: "Asia/Tokyo" },
            { label: "Mumbai", zone: "Asia/Kolkata" }
        ]
    }
};
const unitConversion = {
    view: {
        kind: "conversion",
        type: "unit",
        from: { value: 10, unit: "km" },
        to: { value: 6.2137, unit: "mi" },
        formula: "1 km = 0.621371 mi"
    }
};
const currency = {
    view: {
        kind: "conversion",
        type: "currency",
        from: { value: 100, unit: "EUR" },
        to: { value: 108, unit: "USD" },
        rate: 1.08,
        source: "ECB reference rate",
        asOf: "2026-11-02"
    }
};

const parses = (input: unknown) => visuals.polarVisualSchema.safeParse(input).success;
const withView = (base: { view: object }, change: object) => ({
    ...base,
    view: { ...base.view, ...change }
});

describe("the answer cards", () => {
    it("takes each card whole", () => {
        for (const input of [translation, weather, time, unitConversion, currency])
            expect(parses(input), JSON.stringify(input)).toBe(true);
        expect(parses(withView(translation, { from: "detected" }))).toBe(true);
        expect(parses({ view: { ...translation.view, from: undefined } })).toBe(true);
        expect(parses({ view: { ...time.view, at: undefined } })).toBe(true);
        expect(parses(withView(weather, { current: undefined }))).toBe(true);
        expect(parses(withView(weather, { days: undefined }))).toBe(true);
    });

    it("refuses one that does not hold together", () => {
        const bad: unknown[] = [
            withView(translation, { to: "not a tag" }),
            withView(translation, { alternatives: ["a", "b", "c", "d"] }),
            withView(weather, { current: undefined, days: undefined }),
            withView(weather, { current: { temperature: 10, code: 4 } }),
            withView(weather, { days: [{ date: "2026-11-03", min: 15, max: 10, code: 0 }] }),
            withView(weather, { days: [{ date: "2026-02-30", min: 1, max: 2, code: 0 }] }),
            withView(weather, { units: "kelvin" }),
            withView(weather, {
                days: Array.from({ length: 8 }, (_, index) => ({
                    date: `2026-11-0${index + 1}`,
                    min: 1,
                    max: 2,
                    code: 0
                }))
            }),
            withView(time, { places: [{ label: "Mars", zone: "Mars/Olympus" }] }),
            withView(time, { at: "2026-11-03 15:00" }),
            withView(time, { at: "2026-13-03T15:00" }),
            withView(time, { places: [] }),
            withView(unitConversion, { to: { value: 10, unit: "mi" } }),
            withView(currency, { source: undefined }),
            withView(currency, { asOf: undefined }),
            withView(currency, { from: { value: 100, unit: "eur" } }),
            withView(currency, { to: { value: 120, unit: "USD" } })
        ];
        for (const input of bad) expect(parses(input), JSON.stringify(input)).toBe(false);
    });

    it("tells the model what was wrong with a conversion", () => {
        const result = visuals.polarVisualSchema.safeParse(
            withView(unitConversion, { to: { value: 10, unit: "mi" } })
        );
        expect(result.success).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("6.2137119");
    });

    it("takes a conversion rounded to the decimals it was written with", () => {
        const rounded = (from: object, to: object) =>
            parses(withView(unitConversion, { from, to }));
        expect(rounded({ value: 33, unit: "F" }, { value: 0.6, unit: "C" })).toBe(true);
        expect(rounded({ value: 1, unit: "ft" }, { value: 0.3, unit: "m" })).toBe(true);
        expect(rounded({ value: 100, unit: "ft" }, { value: 30, unit: "m" })).toBe(true);
        expect(rounded({ value: 33, unit: "F" }, { value: 0.7, unit: "C" })).toBe(false);
        expect(rounded({ value: 1, unit: "ft" }, { value: 0.35, unit: "m" })).toBe(false);
        expect(rounded({ value: 100, unit: "ft" }, { value: 33, unit: "m" })).toBe(false);
    });

    it("leaves unknown units unchecked", () => {
        expect(
            parses(
                withView(unitConversion, {
                    from: { value: 1, unit: "cup" },
                    to: { value: 240, unit: "ml" }
                })
            )
        ).toBe(true);
    });

    it("says which kinds there are, and when to use them, in the tool's description", () => {
        const description = String(
            (polarVisualTools().polar_show as { description?: string }).description
        );
        for (const kind of ["translation", "weather", "time", "conversion"])
            expect(description).toContain(`${kind} (`);
        expect(description).toContain("polar_weather");
    });
});

describe("the prompt", () => {
    it("names polar_weather only while the web can be read", () => {
        expect(polarSystemPrompt("Ana", null, "", true)).toContain("polar_weather");
        const off = polarSystemPrompt("Ana", null, "", false);
        expect(off).not.toContain("polar_weather");
        expect(off).toContain("the weather cannot be read");
    });
});

describe("units", () => {
    it("converts within a dimension, temperatures included", () => {
        expect(convertUnit(10, "km", "mi")).toBeCloseTo(6.213712, 5);
        expect(convertUnit(100, "°C", "°F")).toBeCloseTo(212, 9);
        expect(convertUnit(32, "F", "celsius")).toBeCloseTo(0, 9);
        expect(convertUnit(0, "C", "K")).toBeCloseTo(273.15, 9);
        expect(convertUnit(1, "m²", "ft2")).toBeCloseTo(10.76391, 4);
        expect(convertUnit(100, "km/h", "mph")).toBeCloseTo(62.13712, 4);
        expect(convertUnit(1, "lbs", "kg")).toBeCloseTo(0.45359237, 9);
    });

    it("has no answer across dimensions or for a unit it does not know", () => {
        expect(convertUnit(1, "kg", "km")).toBeNull();
        expect(convertUnit(1, "gal", "l")).toBeNull();
        expect(convertUnit(1, "C", "km")).toBeNull();
    });
});

describe("time zones", () => {
    it("knows a zone's offset at an instant, daylight saving included", () => {
        expect(zones.zoneOffsetMinutes(Date.UTC(2026, 0, 15, 12), "Asia/Kolkata")).toBe(330);
        expect(zones.zoneOffsetMinutes(Date.UTC(2026, 0, 15, 12), "America/New_York")).toBe(-300);
        expect(zones.zoneOffsetMinutes(Date.UTC(2026, 6, 15, 12), "America/New_York")).toBe(-240);
        expect(zones.zoneOffsetMinutes(Date.UTC(2026, 6, 15, 12), "UTC")).toBe(0);
    });

    it("reads a wall time in a zone as an instant", () => {
        expect(zones.instantOf("2026-11-03T15:00", "Europe/Madrid")).toBe(
            Date.UTC(2026, 10, 3, 14, 0)
        );
        expect(zones.instantOf("2026-07-03T15:00", "Europe/Madrid")).toBe(
            Date.UTC(2026, 6, 3, 13, 0)
        );
        expect(zones.instantOf("2026-02-30T10:00", "UTC")).toBeNull();
        expect(zones.isTimeZone("Mars/Olympus")).toBe(false);
    });

    it("measures every place against the first", () => {
        const view = visuals.visualOf(time)!.view as Parameters<typeof visuals.timeOffsets>[0];
        const instant = visuals.timeInstant(view, 0);
        expect(instant).toBe(Date.UTC(2026, 10, 3, 14, 0));
        expect(visuals.timeOffsets(view, instant)).toEqual([0, 480, 270]);
        expect(visuals.offsetText(270)).toBe("+4 h 30 min");
        expect(visuals.offsetText(-300)).toBe("-5 h");
    });
});

describe("as text", () => {
    const markdown = (input: unknown) => visuals.visualMarkdown(visuals.visualOf(input)!);

    it("writes a translation with its languages, the source quoted", () => {
        expect(markdown(translation)).toBe(
            [
                "English -> Spanish",
                "",
                "> Hello, how are you?",
                "",
                "Hola, ¿cómo estás?",
                "",
                "- Alternatives: Hola, ¿qué tal?",
                "",
                "- Note: Informal (tú)."
            ].join("\n")
        );
        expect(markdown(withView(translation, { from: "detected" }))).toMatch(
            /^Detected language -> Spanish/
        );
    });

    it("writes the weather as now and a table of days", () => {
        expect(markdown(weather)).toBe(
            [
                "**Weather**",
                "",
                "**Madrid, Comunidad de Madrid, Spain** (as of 2026-11-03 10:45)",
                "",
                "- Now: 10 °C, Clear sky (feels like 6 °C, wind 15 km/h, humidity 46%)",
                "",
                "| Date | Conditions | Min | Max | Rain |",
                "| --- | --- | --- | --- | --- |",
                "| 2026-11-03 | Overcast | 6 °C | 14 °C | 0% |",
                "| 2026-11-04 | Slight rain | 4 °C | 14 °C | 87% |"
            ].join("\n")
        );
    });

    it("writes each place's time and how far it is from the first", () => {
        const lines = markdown(time).split("\n");
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^- \*\*Madrid\*\* \(Europe\/Madrid\): Nov 3, 2026, 3:00\sPM$/);
        expect(lines[1]).toMatch(
            /^- \*\*Tokyo\*\* \(Asia\/Tokyo\): Nov 3, 2026, 11:00\sPM \(\+8 h\)$/
        );
        expect(lines[2]).toMatch(/7:30\sPM \(\+4 h 30 min\)$/);
    });

    it("says a time with no moment of its own is the current time, and when it was read", () => {
        const now = markdown({ view: { ...time.view, at: undefined } }).split("\n");
        expect(now[0]).toMatch(
            /^Current time, as of \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:$/
        );
        expect(now).toHaveLength(4);
        expect(markdown(time)).not.toContain("Current time");
    });

    it("writes a conversion with its formula, and a currency with its rate and source", () => {
        expect(markdown(unitConversion)).toBe("**10 km = 6.2137 mi**\n\n1 km = 0.621371 mi");
        expect(markdown(currency)).toBe(
            "**€100.00 = $108.00**\n\n1 EUR = 1.08 USD\n\nSource: ECB reference rate, 2026-11-02"
        );
    });

    it("is what a stored part reads as", () => {
        expect(
            visuals.visualPartMarkdown({ type: "tool-polar_show", input: unitConversion })
        ).toContain("6.2137 mi");
        expect(visuals.visualCsv(visuals.visualOf(weather)!.view)).toBeNull();
    });
});
