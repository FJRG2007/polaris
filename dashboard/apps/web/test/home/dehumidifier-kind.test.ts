/**
 * A dehumidifier: its own kind, with a purifier's settings document aimed the
 * other way - switched, put on a mode or a fan speed, and given a humidity to
 * dry the room to - and a full water tank said as a warning.
 */

import { describe, expect, it } from "vitest";
import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import { attributesFor, measuresFor } from "@polaris-app/places/src/lib/automation-kinds";

const AIR: kinds.AirSettings = {
    mode: "manual",
    modes: ["manual", "continuous", "auto", "clothes_dry", "shoes_dry", "silent"],
    speed: "medium",
    speeds: ["lowest", "low", "medium", "high", "auto"],
    humidity: { target: 50, min: 35, max: 85, step: 5 },
    options: {},
    readings: { humidity: 63 },
    filters: [],
    tankFull: true
};

describe("the dehumidifier kind", () => {
    it("is a kind of its own, not read back as a lock", () => {
        expect(kinds.deviceKind("dehumidifier")).toBe("dehumidifier");
        expect(kinds.kindText("dehumidifier")).toBe("Dehumidifier");
    });

    it("is switched, given a mode, a fan speed and a humidity, and nothing else", () => {
        expect(kinds.actionsFor("dehumidifier")).toEqual([
            "turn-on",
            "turn-off",
            "set-mode",
            "set-fan",
            "set-humidity"
        ]);
        expect(kinds.acceptsAction("dehumidifier", "set-option")).toBe(false);
        expect(kinds.isSwitchable("dehumidifier")).toBe(false);
        expect(kinds.isAirKind("dehumidifier")).toBe(true);
        expect(kinds.isAirKind("climate")).toBe(false);
    });

    it("says on and off in the same words as any switched device", () => {
        expect(kinds.stateLabel("dehumidifier", "on")).toBe("On");
        expect(kinds.stateLabel("dehumidifier", "off")).toBe("Off");
        expect(kinds.settledState("turn-off")).toBe("off");
    });

    it("takes a purifier's commands, checked against its own range", () => {
        const device = { kind: "dehumidifier", climate: null, air: AIR };
        const set = { action: "set-humidity", target: 45 } as const;
        expect(kinds.commandFor("dehumidifier", set)).toEqual({ kind: "air", command: set });
        expect(kinds.commandIssue(device, set)).toBeNull();
        expect(kinds.commandIssue(device, { action: "set-humidity", target: 47 })).not.toBeNull();
        expect(kinds.commandIssue(device, { action: "set-humidity", target: 90 })).not.toBeNull();
        expect(kinds.commandIssue(device, { action: "set-mode", mode: "continuous" })).toBeNull();
        expect(kinds.commandIssue(device, { action: "set-mode", mode: "turbo" })).not.toBeNull();
        expect(kinds.commandIssue(device, { action: "set-fan", speed: "auto" })).toBeNull();
        expect(kinds.applyCommand(device, set)).toEqual({
            air: { ...AIR, humidity: { ...AIR.humidity, target: 45 } }
        });
        // An air conditioner's command is not a dehumidifier's.
        expect(
            kinds.commandFor("dehumidifier", { action: "set-temperature", target: 22 })
        ).toBeNull();
    });

    it("keeps the tank flag when stored, and drops a document that is not one", () => {
        expect(kinds.storableAir(AIR)?.tankFull).toBe(true);
        expect(kinds.airSettings({ ...AIR, tankFull: "yes" })).toBeNull();
    });

    it("badges with the mode it runs while on", () => {
        const view = { kind: "dehumidifier", online: true, state: "on", air: AIR } as never;
        expect(kinds.badgeText(view)).toBe("Target");
    });

    it("is watched by its state and mode, and compared by its humidity", () => {
        expect(attributesFor("dehumidifier")).toEqual(["state", "mode", "online", "battery"]);
        expect(measuresFor("dehumidifier")).toContain("humidity");
    });
});
