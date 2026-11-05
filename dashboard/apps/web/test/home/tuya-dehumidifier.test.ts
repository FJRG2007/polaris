/**
 * A Tuya dehumidifier (category `cs`): read as the dehumidifier kind from its
 * standard data points, and set in the same codes and scale.
 */

import { describe, expect, it } from "vitest";
import * as vocabulary from "@polaris-app/places/src/lib/drivers/tuya-vocabulary";

const SPEC: vocabulary.TuyaSpec = {
    functions: [
        { code: "switch", type: "Boolean", values: "{}" },
        {
            code: "dehumidify_set_value",
            type: "Integer",
            values: JSON.stringify({ min: 35, max: 70, scale: 0, step: 5 })
        },
        {
            code: "mode",
            type: "Enum",
            values: JSON.stringify({ range: ["manual", "continuous", "dry_clothes"] })
        },
        { code: "fan_speed_enum", type: "Enum", values: JSON.stringify({ range: ["low", "high"] }) }
    ],
    status: [
        {
            code: "humidity_indoor",
            type: "Integer",
            values: JSON.stringify({ min: 0, max: 100, scale: 0, step: 1 })
        },
        {
            code: "fault",
            type: "Bitmap",
            values: JSON.stringify({ label: ["E1", "tankfull", "defrost"] })
        }
    ]
};

const DEVICE: vocabulary.TuyaDeviceShape = {
    id: "dehum-1",
    name: "Basement",
    category: "cs",
    product_name: "Dehumidifier 20L",
    online: true,
    status: [
        { code: "switch", value: true },
        { code: "dehumidify_set_value", value: 50 },
        { code: "mode", value: "continuous" },
        { code: "fan_speed_enum", value: "high" },
        { code: "humidity_indoor", value: 64 },
        { code: "fault", value: 2 }
    ]
};

describe("a Tuya dehumidifier", () => {
    it("is drawn and needs its specification", () => {
        expect(vocabulary.tuyaDraws(DEVICE)).toBe(true);
        expect(vocabulary.needsSpec(DEVICE)).toBe(true);
    });

    it("reads as the dehumidifier kind, with a full tank from the fault bitmap", () => {
        const [row, ...rest] = vocabulary.tuyaSnapshots([DEVICE], new Map([[DEVICE.id, SPEC]]));
        expect(rest).toEqual([]);
        expect(row).toMatchObject({
            externalId: "dehum-1",
            kind: "dehumidifier",
            name: "Basement",
            model: "Dehumidifier 20L",
            state: "on",
            online: true
        });
        expect(row!.air).toEqual({
            mode: "continuous",
            // "dry_clothes" is not one of ours, so it is not offered.
            modes: ["manual", "continuous"],
            speed: "high",
            speeds: ["low", "high"],
            humidity: { target: 50, min: 35, max: 70, step: 5 },
            options: {},
            readings: { humidity: 64 },
            filters: [],
            tankFull: true
        });
    });

    it("says nothing about the tank where the bitmap has no tankfull bit", () => {
        const spec = { ...SPEC, status: SPEC.status.filter((point) => point.code !== "fault") };
        const air = vocabulary.tuyaDehumidifier(
            new Map(DEVICE.status.map((point) => [point.code, point.value])),
            spec
        );
        expect(air?.tankFull).toBeUndefined();
        const empty = vocabulary.tuyaDehumidifier(new Map([["fault", 0]]), SPEC);
        expect(empty?.tankFull).toBe(false);
    });

    it("sets in its own codes, refusing what the unit does not take", () => {
        expect(vocabulary.tuyaDehumidifierCommands("turn-off", undefined, SPEC)).toEqual([
            { code: "switch", value: false }
        ]);
        expect(
            vocabulary.tuyaDehumidifierCommands(
                "set-humidity",
                { action: "set-humidity", target: 45 },
                SPEC
            )
        ).toEqual([{ code: "dehumidify_set_value", value: 45 }]);
        expect(
            vocabulary.tuyaDehumidifierCommands(
                "set-mode",
                { action: "set-mode", mode: "manual" },
                SPEC
            )
        ).toEqual([{ code: "mode", value: "manual" }]);
        expect(
            vocabulary.tuyaDehumidifierCommands(
                "set-fan",
                { action: "set-fan", speed: "low" },
                SPEC
            )
        ).toEqual([{ code: "fan_speed_enum", value: "low" }]);
        expect(() =>
            vocabulary.tuyaDehumidifierCommands(
                "set-humidity",
                { action: "set-humidity", target: 80 },
                SPEC
            )
        ).toThrow();
        expect(() =>
            vocabulary.tuyaDehumidifierCommands(
                "set-mode",
                { action: "set-mode", mode: "auto" },
                SPEC
            )
        ).toThrow();
    });

    it("routes a press through the dehumidifier's commands", async () => {
        const action = await vocabulary.tuyaActionFor(
            { externalId: "dehum-1", kind: "dehumidifier" },
            "set-humidity",
            { action: "set-humidity", target: 55 },
            async () => SPEC
        );
        expect(action).toEqual({
            deviceId: "dehum-1",
            commands: [{ code: "dehumidify_set_value", value: 55 }]
        });
    });
});
