/**
 * The sun, computed here: sunrise, sunset and civil twilight against published
 * tables, a polar summer and winter with no event, the sun condition read
 * across midnight, the schema of the new blocks, and a place's coordinate.
 */

import { describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as words from "@polaris-app/places/src/lib/automation-words";
import { sunHolds } from "@polaris-app/places/src/lib/automation-engine";
import { roundCoordinate, solarElevation, sunTimes, type SunEvent } from "@polaris/core";
import {
    normalizePlaceLocation,
    placeLocationSchema
} from "@polaris-app/places/src/lib/place-kinds";

const LONDON = { latitude: 51.51, longitude: -0.13 };
const NEW_YORK = { latitude: 40.71, longitude: -74.01 };
const SYDNEY = { latitude: -33.87, longitude: 151.21 };
const TROMSO = { latitude: 69.65, longitude: 18.96 };

/** Minutes between an instant and the published one. */
function off(at: Date | null, iso: string): number {
    expect(at).not.toBeNull();
    return Math.abs((at as Date).getTime() - new Date(iso).getTime()) / 60_000;
}

describe("sun times against published tables", () => {
    it("London on the June solstice: 04:43 and 21:21 summer time", () => {
        const times = sunTimes({ year: 2024, month: 6, day: 21 }, LONDON);
        expect(off(times.sunrise, "2024-06-21T03:43:00Z")).toBeLessThan(1.5);
        expect(off(times.sunset, "2024-06-21T20:21:00Z")).toBeLessThan(1.5);
    });

    it("New York on the December solstice: 07:16 and 16:32, civil 06:44 and 17:04", () => {
        const times = sunTimes({ year: 2024, month: 12, day: 21 }, NEW_YORK);
        expect(off(times.sunrise, "2024-12-21T12:16:00Z")).toBeLessThan(1.5);
        expect(off(times.sunset, "2024-12-21T21:32:00Z")).toBeLessThan(1.5);
        expect(off(times.dawn, "2024-12-21T11:44:00Z")).toBeLessThan(2);
        expect(off(times.dusk, "2024-12-21T22:04:00Z")).toBeLessThan(2);
    });

    it("Sydney in its winter: 07:00 and 16:53, the sunrise on the UTC evening before", () => {
        const times = sunTimes({ year: 2024, month: 6, day: 21 }, SYDNEY);
        expect(off(times.sunrise, "2024-06-20T21:00:00Z")).toBeLessThan(1.5);
        expect(off(times.sunset, "2024-06-21T06:53:00Z")).toBeLessThan(1.5);
    });

    it("puts each event where the sun is: -0.833 and -6 degrees", () => {
        const depth: Record<SunEvent, number> = {
            dawn: -6,
            sunrise: -0.833,
            sunset: -0.833,
            dusk: -6
        };
        for (const place of [LONDON, NEW_YORK, SYDNEY]) {
            const times = sunTimes({ year: 2025, month: 3, day: 20 }, place);
            for (const event of Object.keys(depth) as SunEvent[]) {
                expect(solarElevation(times[event] as Date, place)).toBeCloseTo(depth[event], 1);
            }
        }
    });

    it("has no sunset in a polar summer and no sunrise in a polar winter", () => {
        const summer = sunTimes({ year: 2024, month: 6, day: 21 }, TROMSO);
        expect(summer).toEqual({ dawn: null, sunrise: null, sunset: null, dusk: null });
        const winter = sunTimes({ year: 2024, month: 12, day: 21 }, TROMSO);
        expect(winter.sunrise).toBeNull();
        expect(winter.sunset).toBeNull();
        // The sun gets to about -3 degrees at noon: civil twilight, no day.
        expect(winter.dawn).not.toBeNull();
        expect(winter.dusk).not.toBeNull();
    });
});

describe("the sun condition", () => {
    type SunCondition = Extract<auto.Condition, { kind: "sun" }>;
    const dark: SunCondition = {
        id: "conddark",
        kind: "sun",
        after: { event: "sunset" },
        before: { event: "sunrise" }
    };
    const holds = (condition: SunCondition, iso: string) =>
        sunHolds(condition, LONDON, "Europe/London", new Date(iso));

    it("reads after sunset and before sunrise as the night, across midnight", () => {
        expect(holds(dark, "2024-06-21T02:00:00Z")).toBe(true);
        expect(holds(dark, "2024-06-21T12:00:00Z")).toBe(false);
        expect(holds(dark, "2024-06-21T22:30:00Z")).toBe(true);
    });

    it("needs any other pair on the same day, with its offsets", () => {
        const day: SunCondition = {
            id: "condday",
            kind: "sun",
            after: { event: "sunrise" },
            before: { event: "sunset", offset: { amount: 1, unit: "hours", direction: "before" } }
        };
        expect(holds(day, "2024-06-21T12:00:00Z")).toBe(true);
        expect(holds(day, "2024-06-21T19:40:00Z")).toBe(false);
        expect(holds(day, "2024-06-21T03:00:00Z")).toBe(false);
        const after: SunCondition = { id: "condafter", kind: "sun", after: { event: "sunset" } };
        expect(holds(after, "2024-06-21T20:30:00Z")).toBe(true);
        expect(holds(after, "2024-06-21T02:00:00Z")).toBe(false);
    });

    it("fails where the event does not happen today, and with no location", () => {
        expect(sunHolds(dark, TROMSO, "Europe/Oslo", new Date("2024-06-21T12:00:00Z"))).toBe(false);
        expect(sunHolds(dark, null, "UTC", new Date("2024-06-21T02:00:00Z"))).toBe(false);
    });
});

describe("the schema", () => {
    const base = {
        timeZone: "UTC",
        conditions: { match: "all", groups: [] },
        actions: [{ id: "stepnote", kind: "notify", message: "Hi" }]
    };

    it("takes a sun trigger with the shared offset, and refuses more than half a day", () => {
        const sun = {
            id: "trigsun",
            kind: "sun",
            event: "dusk",
            offset: { amount: 30, unit: "minutes", direction: "after" }
        };
        expect(auto.definitionSchema.safeParse({ ...base, triggers: [sun] }).success).toBe(true);
        const far = { ...sun, offset: { amount: 13, unit: "hours", direction: "after" } };
        expect(auto.definitionSchema.safeParse({ ...base, triggers: [far] }).success).toBe(false);
    });

    it("refuses a Triggered by naming a trigger no longer there, or none", () => {
        const parse = (triggerIds: string[]) =>
            auto.definitionSchema.safeParse({
                ...base,
                triggers: [{ id: "trigone", kind: "manual" }],
                conditions: {
                    match: "all",
                    groups: [
                        {
                            id: "groupone",
                            match: "all",
                            items: [{ id: "condby", kind: "triggeredBy", triggerIds }]
                        }
                    ]
                }
            });
        expect(parse(["trigone"]).success).toBe(true);
        expect(parse(["trigtwo"]).error?.issues[0]?.message).toBe("automations.errors.triggerGone");
        expect(parse([]).error?.issues[0]?.message).toBe("automations.errors.noTriggerPicked");
    });

    it("numbers the triggers a Triggered by names, and names the one behind a run", () => {
        const t = ((key: string, values?: Record<string, unknown>) =>
            `${key}${values ? JSON.stringify(values) : ""}`) as never;
        const condition = {
            id: "condby",
            kind: "triggeredBy" as const,
            triggerIds: ["trigtwo", "trigold"]
        };
        expect(
            words.describeCondition(condition, () => undefined, t, ["trigone", "trigtwo"])
        ).toContain('"numbers":"2, ?"');
        const triggers: auto.Trigger[] = [
            { id: "trigone", kind: "manual" },
            { id: "trigtwo", kind: "manual", alias: "Front door" }
        ];
        const line = words.causeTrigger(
            { kind: "manual", triggerId: "trigtwo", at: "" },
            triggers,
            () => undefined,
            t
        );
        expect(line).toContain('"number":2');
        expect(line).toContain("Front door");
        expect(words.causeTrigger({ kind: "manual", at: "" }, triggers, () => undefined, t)).toBe(
            undefined
        );
    });
});

describe("a place's coordinate", () => {
    it("is rounded to 2 decimals, read with a comma, and both empty is none", () => {
        const read = (latitude: string, longitude: string) =>
            placeLocationSchema.safeParse(normalizePlaceLocation({ latitude, longitude }));
        expect(read(" 40,41678 ", "-3.70379").data).toEqual({ latitude: 40.42, longitude: -3.7 });
        expect(read("", "").data).toBeNull();
        expect(read("91", "0").success).toBe(false);
        expect(read("40", "").success).toBe(false);
        expect(read("north", "3").success).toBe(false);
        expect(roundCoordinate({ latitude: -0.001, longitude: 179.996 })).toEqual({
            latitude: 0,
            longitude: 180
        });
    });
});
