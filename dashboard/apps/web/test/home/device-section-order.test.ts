/**
 * A device's page order: the controls lead and the history closes for every
 * kind; a device that reads the room lists its readings above the month of use,
 * and a device that is switched keeps the use first.
 */

import { describe, expect, it } from "vitest";
import * as rk from "@polaris-app/places/src/lib/reading-kinds";

const READINGS_FIRST = ["controls", "auto-off", "readings", "used", "history"];
const USED_FIRST = ["controls", "auto-off", "used", "readings", "history"];

describe("deviceSectionOrder", () => {
    it.each([
        ["dehumidifier", ["humidity", "temperature"]],
        ["air", ["pm25", "humidity", "filter"]],
        ["climate", ["temperature", "target"]],
        ["sensor", ["temperature"]],
        ["sensor", ["power"]]
    ] as const)("puts readings first on a %s reporting %j", (kind, measures) => {
        expect(rk.deviceSectionOrder(kind, measures)).toEqual(READINGS_FIRST);
    });

    it.each([
        ["light", []],
        ["outlet", ["power", "energy"]],
        ["switch", ["temperature"]],
        ["lock", []],
        ["opener", []]
    ] as const)("keeps use first on a %s reporting %j", (kind, measures) => {
        expect(rk.deviceSectionOrder(kind, measures)).toEqual(USED_FIRST);
    });

    it("reads the room first on another kind only when it reports a room measure", () => {
        expect(rk.deviceSectionOrder("appliance", ["humidity"])).toEqual(READINGS_FIRST);
        expect(rk.deviceSectionOrder("appliance", ["power"])).toEqual(USED_FIRST);
        expect(rk.deviceSectionOrder("litter", [])).toEqual(USED_FIRST);
    });

    it("keeps use first when a room device reports nothing yet", () => {
        expect(rk.deviceSectionOrder("dehumidifier", [])).toEqual(USED_FIRST);
    });

    it("always leads with the controls and closes with the history", () => {
        for (const kind of ["dehumidifier", "light", "appliance", "unknown"]) {
            const order = rk.deviceSectionOrder(kind, ["temperature"]);
            expect(order[0]).toBe("controls");
            expect(order[1]).toBe("auto-off");
            expect(order[order.length - 1]).toBe("history");
            expect(new Set(order).size).toBe(5);
        }
    });
});
