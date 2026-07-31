import { describe, expect, it } from "vitest";
import {
    createDisplayFormat,
    DISPLAY_DEFAULTS,
    parseDisplayPreferences,
    resolveDisplayPreferences,
    stringifyDisplayPreferences,
    toDisplayTemperature,
    userDisplayPreferencesSchema
} from "../src/schemas/display.js";

/** A day past the 12th and an afternoon hour, so every choice reads differently. */
const AT = new Date(2026, 6, 31, 14, 5, 9);

describe("preference layering", () => {
    it("takes the user's choice over the platform's, and the platform's over the built-in", () => {
        const resolved = resolveDisplayPreferences({ dateOrder: "dmy", clock: "12h" }, { clock: "24h" });
        expect(resolved.clock).toBe("24h");
        expect(resolved.dateOrder).toBe("dmy");
        expect(resolved.currency).toBe(DISPLAY_DEFAULTS.currency);
    });

    it("ignores fields that were never chosen instead of pinning them to undefined", () => {
        expect(resolveDisplayPreferences({ clock: undefined }, {})).toEqual(DISPLAY_DEFAULTS);
    });

    it("stores only what was chosen", () => {
        expect(stringifyDisplayPreferences({ temperature: "f", clock: undefined })).toBe('{"temperature":"f"}');
    });

    it("degrades an unreadable or outdated blob to no choice at all", () => {
        expect(parseDisplayPreferences("{not json")).toEqual({});
        expect(parseDisplayPreferences('{"clock":"37h"}')).toEqual({});
        expect(parseDisplayPreferences(null)).toEqual({});
        expect(parseDisplayPreferences('{"clock":"12h"}')).toEqual({ clock: "12h" });
    });

    it("rejects a unit nothing knows how to render", () => {
        expect(userDisplayPreferencesSchema.safeParse({ temperature: "k" }).success).toBe(false);
        expect(userDisplayPreferencesSchema.safeParse({ currency: "XYZ" }).success).toBe(false);
    });
});

describe("formatting", () => {
    it("writes the date in the chosen order and year width", () => {
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "mdy" }).date(AT)).toBe("07/31/2026");
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "dmy" }).date(AT)).toBe("31/07/2026");
        expect(
            createDisplayFormat({ ...DISPLAY_DEFAULTS, dateOrder: "dmy", yearFormat: "yy" }).date(AT)
        ).toBe("31/07/26");
    });

    it("writes the clock in the chosen format, including the hours that wrap", () => {
        const twelve = createDisplayFormat({ ...DISPLAY_DEFAULTS, clock: "12h" });
        expect(createDisplayFormat(DISPLAY_DEFAULTS).time(AT)).toBe("14:05");
        expect(twelve.time(AT)).toBe("2:05 PM");
        expect(twelve.time(new Date(2026, 6, 31, 0, 7))).toBe("12:07 AM");
        expect(twelve.time(new Date(2026, 6, 31, 12, 0))).toBe("12:00 PM");
        expect(createDisplayFormat(DISPLAY_DEFAULTS).time(AT, { seconds: true })).toBe("14:05:09");
    });

    it("converts readings to the chosen unit", () => {
        expect(toDisplayTemperature(100, "f")).toBe(212);
        expect(createDisplayFormat({ ...DISPLAY_DEFAULTS, temperature: "f" }).temperature(21.4)).toBe("71 F");
        expect(createDisplayFormat(DISPLAY_DEFAULTS).temperature(21.4)).toBe("21 C");
    });

    it("has something to show for a value it cannot format", () => {
        const format = createDisplayFormat(DISPLAY_DEFAULTS);
        expect(format.date("not a date")).toBe("-");
        expect(format.dateTime(null)).toBe("-");
        expect(format.temperature(null)).toBe("-");
        expect(format.currency(undefined)).toBe("-");
    });
});
