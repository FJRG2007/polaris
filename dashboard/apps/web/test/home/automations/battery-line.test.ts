/**
 * When a battery is low: a line per kind of device, one set on the device
 * itself, and the editor naming that line beside Low and Fine.
 */

import { describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as words from "@polaris-app/places/src/lib/automation-words";
import * as purposes from "@polaris-app/places/src/lib/automation-purposes";
import { attentionFor } from "@polaris-app/places/src/lib/overview";
import { placesCatalogs } from "@polaris-app/places/messages";
import { batteryLineSchema, deviceEditSchema } from "@polaris-app/places/src/lib/schemas";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";

function device(kind: string, extra: Partial<DeviceView> = {}): DeviceView {
    return {
        id: `fixture-${kind}`,
        vendor: "fixture",
        kind,
        name: `Fixture ${kind}`,
        zone: "",
        placeId: "place-1",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        ...extra
    };
}

const en = placesCatalogs.translator("en-US", "places");
const es = placesCatalogs.translator("es-ES", "places");

describe("a battery's low line", () => {
    it("is higher for a lock, an opener and a safety sensor, lower for a button", () => {
        expect(auto.defaultBatteryLine(device("lock"))).toBe(30);
        expect(auto.defaultBatteryLine(device("opener"))).toBe(30);
        expect(
            auto.defaultBatteryLine(device("sensor", { reading: { value: "Clear", unit: "" } }))
        ).toBe(30);
        expect(
            auto.defaultBatteryLine(device("sensor", { reading: { value: "21", unit: "C" } }))
        ).toBe(20);
        expect(auto.defaultBatteryLine(device("switch"))).toBe(15);
        expect(auto.defaultBatteryLine(device("outlet"))).toBe(auto.BATTERY_LOW_PERCENT);
        expect(auto.batteryWord(device("lock", { batteryPercent: 30 }))).toBe("low");
        expect(auto.batteryWord(device("lock", { batteryPercent: 31 }))).toBe("ok");
        expect(auto.batteryWord(device("switch", { batteryPercent: 18 }))).toBe("ok");
    });

    it("is the device's own when one is set, and its kind's when it is cleared", () => {
        const set = device("lock", { batteryPercent: 45, batteryLowPercent: 50 });
        expect(auto.batteryLine(set)).toBe(50);
        expect(auto.batteryWord(set)).toBe("low");
        expect(auto.batteryWord({ ...set, batteryLowPercent: null })).toBe("ok");
        // A stored value out of range is not trusted over the kind's.
        expect(auto.batteryLine({ ...set, batteryLowPercent: 0 })).toBe(30);
    });

    it("still counts a maker's own critical flag, whatever the line", () => {
        const flagged = device("lock", {
            batteryPercent: 80,
            batteryCritical: true,
            batteryLowPercent: 10
        });
        expect(auto.batteryWord(flagged)).toBe("low");
        expect(auto.makerFlagsBattery("nuki")).toBe(true);
        expect(auto.makerFlagsBattery("dirigera")).toBe(false);
    });

    it("leaves a reading with no kind, as old callers pass it, on the old line", () => {
        expect(auto.batteryWord({ batteryPercent: 20 })).toBe("low");
        expect(auto.batteryWord({ batteryPercent: 21 })).toBe("ok");
        expect(auto.batteryWord({ batteryPercent: null })).toBe("");
    });

    it("is what the overview and the low-battery block read", () => {
        const lock = device("lock", { batteryPercent: 25 });
        expect(attentionFor(lock)).toBe("battery");
        expect(attentionFor({ ...lock, batteryLowPercent: 10 })).toBeNull();
        expect(purposes.triggerFits("batteryLow", lock)).toBe(true);
        expect(purposes.purposeTrigger("batteryLow", lock)).toMatchObject({
            attribute: "battery",
            to: "low"
        });
    });

    it("is checked as a whole share from 1 to 99, and empty clears it", () => {
        expect(batteryLineSchema.safeParse(30).success).toBe(true);
        for (const bad of [0, 100, 12.5, Number.NaN]) {
            expect(batteryLineSchema.safeParse(bad).success).toBe(false);
        }
        const base = { name: "Fixture", zone: "", placeId: null, controllable: true };
        expect(deviceEditSchema.parse({ ...base, batteryLowPercent: null }).batteryLowPercent).toBe(
            null
        );
        // A screen from before the line saves without touching it.
        expect("batteryLowPercent" in deviceEditSchema.parse(base)).toBe(false);
    });
});

describe("the editor's battery words", () => {
    it("name the device's line, and its maker's flag where it has one", () => {
        const lock = device("lock", { batteryPercent: 60 });
        expect(words.batteryValueText("low", lock, en)).toBe("Low (at or under 30%)");
        expect(words.batteryValueText("ok", lock, en)).toBe("Fine (over 30%)");
        expect(words.batteryValueText("low", { ...lock, batteryLowPercent: 40 }, en)).toBe(
            "Low (at or under 40%)"
        );
        expect(words.batteryValueText("low", { ...lock, vendor: "nuki" }, en)).toBe(
            "Low (at or under 30%, or when the device itself reports it)"
        );
        expect(words.batteryValueText("low", lock, es)).toBe("Baja (al 30% o menos)");
        expect(words.batteryValueText("low", undefined, en)).toBe("Low");
    });
});

describe("an automation saved before the line", () => {
    it("still parses and still waits for the same word", () => {
        // The block exactly as the low-battery purpose stored it before the line.
        const saved = {
            name: "Fixture battery",
            enabled: true,
            placeId: "place-1",
            definition: {
                timeZone: "Europe/Madrid",
                triggers: [purposes.purposeTrigger("batteryLow", device("lock", { batteryPercent: 50 }))],
                conditions: { match: "all", groups: [] },
                actions: [{ id: "step01", kind: "device", deviceId: "plug", do: "turn-off" }]
            }
        };
        const parsed = auto.automationInputSchema.safeParse(auto.normalizeAutomationInput(saved));
        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.data?.definition.triggers[0]).toMatchObject({
            attribute: "battery",
            to: "low"
        });
        // The words a stored block can hold have not moved.
        expect(auto.BATTERY_WORDS).toEqual(["low", "ok"]);
    });
});
