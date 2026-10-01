/**
 * Tuya air conditioners (category `kt`), read and told through Tuya's standard
 * instruction set: `switch`, `temp_set` with its scale, `mode` (`cold`, `hot`,
 * `wet`, `wind`, `auto`), `fan_speed_enum` (`low`, `mid`, `high`, `auto`,
 * `strong`), `switch_vertical`, `mode_eco`, and `temp_current` in the status set.
 *
 * The specification is the shape both of Tuya's APIs answer - functions and
 * status, each value range a JSON document in a string - with the ranges their
 * documentation lists for `kt`, and a unit that reports in tenths, which is
 * common in practice and is what the scale is for.
 */

import { describe, expect, it } from "vitest";
import {
    tuyaActionFor,
    tuyaClimate,
    tuyaClimateCommands,
    tuyaSnapshots,
    tuyaSpecSchema,
    type TuyaSpec
} from "@polaris-app/places/src/lib/drivers/tuya-vocabulary";

function spec(scale = 0): TuyaSpec {
    const tenths = 10 ** scale;
    return tuyaSpecSchema.parse({
        functions: [
            { code: "switch", type: "Boolean", values: "{}" },
            {
                code: "temp_set",
                type: "Integer",
                values: JSON.stringify({ min: 16 * tenths, max: 31 * tenths, scale, step: scale ? 5 : 1, unit: "℃" })
            },
            {
                code: "mode",
                type: "Enum",
                values: JSON.stringify({ range: ["auto", "cold", "hot", "wet", "wind", "eco"] })
            },
            {
                code: "fan_speed_enum",
                type: "Enum",
                values: JSON.stringify({ range: ["low", "mid", "high", "auto", "strong"] })
            },
            { code: "switch_vertical", type: "Boolean", values: "{}" },
            { code: "mode_eco", type: "Boolean", values: "{}" }
        ],
        status: [
            {
                code: "temp_current",
                type: "Integer",
                values: JSON.stringify({ min: -20 * tenths, max: 100 * tenths, scale, step: 1 })
            }
        ]
    });
}

const UNIT = {
    id: "bf00000000000000kt01",
    name: "Office AC",
    category: "kt",
    product_name: "Split",
    online: true,
    status: [
        { code: "switch", value: true },
        { code: "temp_set", value: 24 },
        { code: "temp_current", value: 27 },
        { code: "mode", value: "cold" },
        { code: "fan_speed_enum", value: "mid" },
        { code: "switch_vertical", value: false },
        { code: "mode_eco", value: true }
    ]
};

describe("a Tuya air conditioner", () => {
    it("is one row, an air conditioner, with its settings from its specification", () => {
        const [row, ...rest] = tuyaSnapshots([UNIT], new Map([[UNIT.id, spec()]]));
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
            externalId: UNIT.id,
            kind: "climate",
            name: "Office AC",
            state: "on",
            value: "27",
            unit: "°C"
        });
        expect(row!.climate).toEqual({
            mode: "cool",
            // "eco" is not a mode here, and "strong" is not a speed.
            modes: ["auto", "cool", "heat", "dry", "fan"],
            target: 24,
            min: 16,
            max: 31,
            step: 1,
            unit: "C",
            fan: "medium",
            fans: ["low", "medium", "high", "auto"],
            options: { swing: false, eco: true }
        });
    });

    it("reads a unit in tenths through its scale", () => {
        const status = new Map<string, unknown>([
            ["temp_set", 245],
            ["temp_current", 268]
        ]);
        const read = tuyaClimate(status, spec(1));
        expect(read.current).toBe(26.8);
        expect(read.settings).toMatchObject({ target: 24.5, min: 16, max: 31, step: 0.5 });
    });

    it("is drawn without settings, rather than with invented ones, when its specification could not be read", () => {
        const [row] = tuyaSnapshots([UNIT]);
        expect(row).toMatchObject({ kind: "climate", state: "on", climate: null });
    });

    it.each([
        ["turn-on", undefined, [{ code: "switch", value: true }]],
        ["set-mode", { action: "set-mode", mode: "heat" }, [{ code: "mode", value: "hot" }]],
        ["set-mode", { action: "set-mode", mode: "fan" }, [{ code: "mode", value: "wind" }]],
        ["set-fan", { action: "set-fan", fan: "medium" }, [{ code: "fan_speed_enum", value: "mid" }]],
        ["set-temperature", { action: "set-temperature", target: 22 }, [{ code: "temp_set", value: 22 }]],
        [
            "set-option",
            { action: "set-option", option: "swing", on: true },
            [{ code: "switch_vertical", value: true }]
        ]
    ] as const)("sends %s in Tuya's own codes", (action, command, expected) => {
        expect(tuyaClimateCommands(action, command, spec())).toEqual(expected);
    });

    it("sends a target scaled to the unit's tenths", () => {
        expect(
            tuyaClimateCommands("set-temperature", { action: "set-temperature", target: 22.5 }, spec(1))
        ).toEqual([{ code: "temp_set", value: 225 }]);
    });

    it("refuses what the unit does not have, before sending anything", () => {
        expect(() =>
            tuyaClimateCommands("set-fan", { action: "set-fan", fan: "medium-low" }, spec())
        ).toThrow("That fan speed is not one this device has");
        expect(() =>
            tuyaClimateCommands("set-temperature", { action: "set-temperature", target: 40 }, spec())
        ).toThrow("That temperature is not one this device accepts");
        expect(() =>
            tuyaClimateCommands("set-option", { action: "set-option", option: "turbo", on: true }, spec())
        ).toThrow("That setting is not one this device has");
    });

    it("asks for the specification only for an air conditioner, and only once in a while", async () => {
        let asked = 0;
        const fetch = async () => {
            asked += 1;
            return spec();
        };
        const device = { externalId: "bf00000000000000kt02", kind: "climate" };
        await tuyaActionFor(device, "set-mode", { action: "set-mode", mode: "dry" }, fetch);
        const second = await tuyaActionFor(device, "turn-off", undefined, fetch);
        expect(asked).toBe(1);
        expect(second.commands).toEqual([{ code: "switch", value: false }]);
        const plug = await tuyaActionFor({ externalId: "plug#switch_1", kind: "outlet" }, "turn-on", undefined, fetch);
        expect(plug).toEqual({ deviceId: "plug", commands: [{ code: "switch_1", value: true }] });
        expect(asked).toBe(1);
    });
});
