/**
 * How good the air is, in words: the European Air Quality Index's PM2.5 bands
 * and Philips' allergen index bands, held at their edges, and the same verdict
 * reaching automations as a rank.
 */

import { describe, expect, it } from "vitest";
import { placesCatalogs } from "@polaris-app/places/messages";
import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as words from "@polaris-app/places/src/lib/automation-words";
import type { AirSettings } from "@polaris-app/places/src/lib/device-kinds";

const en = placesCatalogs.translator("en-US", "places");
const es = placesCatalogs.translator("es-ES", "places");

function air(readings: AirSettings["readings"]): AirSettings {
    return {
        mode: null,
        modes: [],
        speed: null,
        speeds: [],
        humidity: null,
        options: {},
        readings,
        filters: []
    };
}

describe("PM2.5 bands", () => {
    it.each([
        [0, "good"],
        [5, "good"],
        [5.4, "good"],
        [5.6, "fair"],
        [6, "fair"],
        [15, "fair"],
        [16, "moderate"],
        [50, "moderate"],
        [51, "poor"],
        [90, "poor"],
        [91, "veryPoor"],
        [140, "veryPoor"],
        [141, "extremelyPoor"],
        [999, "extremelyPoor"]
    ] as const)("%s µg/m³ is %s", (value, level) => {
        expect(kinds.pm25Quality(value)).toBe(level);
    });
});

describe("allergen index bands", () => {
    it.each([
        [1, "good"],
        [3, "good"],
        [4, "fair"],
        [6, "fair"],
        [7, "poor"],
        [9, "poor"],
        [10, "veryPoor"],
        [12, "veryPoor"]
    ] as const)("an index of %s is %s", (value, level) => {
        expect(kinds.allergenQuality(value)).toBe(level);
    });

    it("never says Moderate or Extremely poor, which its scale does not have", () => {
        const said = new Set(
            Array.from({ length: 13 }, (_, index) => kinds.allergenQuality(index))
        );
        expect(said.has("moderate")).toBe(false);
        expect(said.has("extremelyPoor")).toBe(false);
    });
});

describe("a unit's verdict", () => {
    it("is judged by PM2.5 where the unit measures it", () => {
        expect(kinds.airQuality(air({ pm25: 60, allergen: 2 }))).toEqual({
            level: "poor",
            measure: "pm25"
        });
    });

    it("falls back to the allergen index", () => {
        expect(kinds.airQuality(air({ allergen: 8 }))).toEqual({
            level: "poor",
            measure: "allergen"
        });
    });

    it("says nothing for a unit that measures neither", () => {
        expect(kinds.airQuality(air({ humidity: 45 }))).toBeNull();
        expect(kinds.airQuality(null)).toBeNull();
    });

    it("has a label and something to do, in both languages", () => {
        for (const level of kinds.AIR_QUALITY_LEVELS) {
            for (const t of [en, es]) {
                expect(kinds.airQualityText(level, t)).not.toMatch(/devices\./);
                expect(kinds.airQualityHint(level, t)).not.toMatch(/devices\./);
            }
        }
        expect(kinds.airQualityText("veryPoor", es)).toBe("Muy mala");
    });
});

describe("air quality in automations", () => {
    it("ranks 1 for Good up to 6 for Extremely poor, and back", () => {
        expect(kinds.AIR_QUALITY_LEVELS.map(kinds.airQualityRank)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(kinds.airQualityAt(4)).toBe("poor");
        expect(kinds.airQualityAt(0)).toBeNull();
        expect(kinds.airQualityAt(7)).toBeNull();
        expect(kinds.airQualityAt(3.5)).toBeNull();
    });

    it("is a figure an air purifier offers", () => {
        expect(auto.measuresFor("air")).toContain("quality");
        expect(auto.measuresFor("sensor")).not.toContain("quality");
    });

    const definition = (value: number) => ({
        timeZone: "Europe/Madrid",
        triggers: [
            {
                id: "trig0001",
                kind: "threshold",
                deviceId: "dev1",
                direction: "above",
                value: 3,
                measure: "quality"
            }
        ],
        conditions: {
            match: "all",
            groups: [
                {
                    id: "grp00001",
                    match: "all",
                    items: [
                        {
                            id: "cond0001",
                            kind: "reading",
                            deviceId: "dev1",
                            op: "gte",
                            value,
                            measure: "quality"
                        }
                    ]
                }
            ]
        },
        actions: [{ id: "step0001", kind: "notify", message: "Air is bad" }]
    });

    it("accepts a level and refuses a rank that is none", () => {
        expect(auto.definitionSchema.safeParse(definition(4)).success).toBe(true);
        const refused = auto.definitionSchema.safeParse(definition(4.5));
        expect(refused.success).toBe(false);
        expect(refused.error?.issues[0]?.message).toBe("automations.errors.state");
    });

    it("reads as levels, not numbers", () => {
        const parsed = auto.definitionSchema.parse(definition(4));
        const lookup = () => ({ name: "Bedroom", kind: "air" });
        const condition = parsed.conditions.groups[0]!.items[0]!;
        expect(words.describeCondition(condition, lookup, en)).toBe(
            "Air quality of Bedroom: Poor or worse"
        );
        expect(words.describeCondition(condition, lookup, es)).toBe(
            "Calidad de Bedroom: Mala o peor"
        );
        expect(words.describeTrigger(parsed.triggers[0]!, lookup, en)).toBe(
            "Air quality of Bedroom gets worse than Moderate"
        );
    });
});
