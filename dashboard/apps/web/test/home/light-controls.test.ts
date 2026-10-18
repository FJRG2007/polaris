/**
 * Light brightness, colour temperature and colour: the core rules, each
 * driver's mapping to its own wire, and the overview card drawing a control
 * only for what the device has.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1", ownerId: "owner", name: "Home" })
}));

import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import type { HueLight } from "@polaris-app/places/src/lib/integrations/hue-api";
import { deviceItem, pressAsAction } from "@polaris-app/places/src/lib/overview-widgets";
import { hueLightSettings, hueLightUpdate } from "@polaris-app/places/src/lib/drivers/hue-light";
import type { HomeAssistantState } from "@polaris-app/places/src/lib/integrations/home-assistant-api";
import {
    haLightData,
    haLightSettings
} from "@polaris-app/places/src/lib/drivers/home-assistant-light";
import {
    shellyLightCall,
    shellyLightSettings
} from "@polaris-app/places/src/lib/drivers/shelly-light";

const FULL: kinds.LightSettings = {
    brightness: { level: 50 },
    temperature: { kelvin: 3000, min: 2200, max: 6500 },
    color: { hue: 120, saturation: 80 }
};

describe("light rules", () => {
    it("offers the light actions on a light only", () => {
        expect(kinds.actionsFor("light")).toEqual(
            expect.arrayContaining(["set-brightness", "set-color-temp", "set-color"])
        );
        expect(kinds.actionsFor("switch")).not.toContain("set-brightness");
        expect(kinds.needsCommand("set-brightness")).toBe(true);
    });

    it("refuses what the light cannot do", () => {
        const plain = {
            kind: "light",
            climate: null,
            air: null,
            light: { ...FULL, temperature: null, color: null }
        };
        expect(kinds.commandIssue(plain, { action: "set-brightness", level: 40 })).toBeNull();
        expect(kinds.commandIssue(plain, { action: "set-color-temp", kelvin: 3000 })).toMatch(
            /colour temperature/
        );
        expect(
            kinds.commandIssue(plain, { action: "set-color", hue: 10, saturation: 100 })
        ).toMatch(/colour/);
        const full = { kind: "light", climate: null, air: null, light: FULL };
        expect(kinds.commandIssue(full, { action: "set-color-temp", kelvin: 9000 })).toMatch(
            /not one/
        );
        expect(
            kinds.commandIssue({ ...full, light: null }, { action: "set-brightness", level: 40 })
        ).toMatch(/not said/);
    });

    it("never takes zero as a brightness: off is its own action", () => {
        expect(
            kinds.lightCommandSchema.safeParse({ action: "set-brightness", level: 0 }).success
        ).toBe(false);
    });

    it("applies a setting where the row shows it, a colour clearing the white", () => {
        const target = { kind: "light", climate: null, air: null, light: FULL };
        expect(kinds.applyCommand(target, { action: "set-brightness", level: 80 })).toEqual({
            light: { ...FULL, brightness: { level: 80 } }
        });
        const coloured = kinds.applyCommand(target, {
            action: "set-color",
            hue: 200,
            saturation: 90
        });
        expect(coloured).toEqual({
            light: {
                ...FULL,
                color: { hue: 200, saturation: 90 },
                temperature: { ...FULL.temperature!, kelvin: null }
            }
        });
    });

    it("stores nothing for a light that only switches", () => {
        expect(
            kinds.storableLight({ brightness: null, temperature: null, color: null })
        ).toBeNull();
        expect(kinds.storableLight(FULL)).toEqual(FULL);
    });
});

describe("Home Assistant lights", () => {
    const entity = (attributes: Record<string, unknown>, state = "on") =>
        ({ entity_id: "light.desk", state, attributes }) as unknown as HomeAssistantState;

    it("reads what the colour modes say it can do", () => {
        expect(haLightSettings(entity({ supported_color_modes: ["onoff"] }))).toBeNull();
        expect(
            haLightSettings(
                entity({
                    supported_color_modes: ["color_temp", "hs"],
                    brightness: 128,
                    color_temp_kelvin: 2700,
                    min_color_temp_kelvin: 2000,
                    max_color_temp_kelvin: 6535,
                    hs_color: [30, 60]
                })
            )
        ).toEqual({
            brightness: { level: 50 },
            temperature: { kelvin: 2700, min: 2000, max: 6535 },
            color: { hue: 30, saturation: 60 }
        });
        expect(
            haLightSettings(entity({ supported_color_modes: ["brightness"], brightness: 0 }, "off"))
        ).toEqual({
            brightness: { level: null },
            temperature: null,
            color: null
        });
    });

    it("sends light.turn_on data", () => {
        expect(haLightData({ action: "set-brightness", level: 42 })).toEqual({
            brightness_pct: 42
        });
        expect(haLightData({ action: "set-color-temp", kelvin: 4000 })).toEqual({
            color_temp_kelvin: 4000
        });
        expect(haLightData({ action: "set-color", hue: 240, saturation: 100 })).toEqual({
            hs_color: [240, 100]
        });
    });
});

describe("Hue lights", () => {
    const light = (extra: Record<string, unknown>) =>
        ({
            id: "l1",
            owner: { rid: "d1", rtype: "device" },
            metadata: {},
            on: { on: true },
            ...extra
        }) as HueLight;

    it("reads dimming, mirek range and colour from the CLIP v2 resource", () => {
        expect(hueLightSettings(light({}))).toBeNull();
        expect(
            hueLightSettings(
                light({
                    dimming: { brightness: 73.2 },
                    color_temperature: {
                        mirek: 370,
                        mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 }
                    },
                    color: { xy: { x: 0.4, y: 0.4 } }
                })
            )
        ).toEqual({
            brightness: { level: 73 },
            temperature: { kelvin: 2703, min: 2000, max: 6536 },
            color: { hue: null, saturation: null }
        });
    });

    it("sends dimming, mirek and xy", () => {
        expect(hueLightUpdate({ action: "set-brightness", level: 30 })).toEqual({
            dimming: { brightness: 30 }
        });
        expect(hueLightUpdate({ action: "set-color-temp", kelvin: 2500 })).toEqual({
            color_temperature: { mirek: 400 }
        });
        const red = hueLightUpdate({ action: "set-color", hue: 0, saturation: 100 });
        expect(red).toEqual({ color: { xy: { x: 0.6401, y: 0.33 } } });
    });
});

describe("Shelly lights", () => {
    it("reads brightness, and colour on an RGBW2 in colour mode", () => {
        expect(shellyLightSettings({ output: true }, "brightness", true, false)).toBeNull();
        expect(shellyLightSettings({ brightness: 64 }, "brightness", true, false)).toEqual({
            brightness: { level: 64 },
            temperature: null,
            color: null
        });
        expect(
            shellyLightSettings({ gain: 50, red: 0, green: 0, blue: 255 }, "gain", true, true)
        ).toEqual({
            brightness: { level: 50 },
            temperature: null,
            color: { hue: 240, saturation: 100 }
        });
    });

    it("sends Light.Set on Gen2 and the documented query on Gen1", () => {
        expect(shellyLightCall("light:0", { action: "set-brightness", level: 40 })).toEqual({
            rpc: { id: 0, brightness: 40 }
        });
        expect(
            shellyLightCall("light:0", { action: "set-color", hue: 0, saturation: 100 })
        ).toBeNull();
        expect(shellyLightCall("white/2", { action: "set-brightness", level: 10 })).toEqual({
            path: "/white/2?brightness=10"
        });
        expect(shellyLightCall("color/0", { action: "set-brightness", level: 70 })).toEqual({
            path: "/color/0?gain=70"
        });
        expect(
            shellyLightCall("color/0", { action: "set-color", hue: 120, saturation: 100 })
        ).toEqual({
            path: "/color/0?red=0&green=255&blue=0"
        });
        expect(shellyLightCall("relay/0", { action: "set-brightness", level: 10 })).toBeNull();
    });
});

describe("overview card", () => {
    const t = ((key: string) => key) as unknown as Parameters<typeof deviceItem>[2]["t"];
    const base = {
        id: "d",
        vendor: "home-assistant",
        name: "Desk",
        zone: null,
        placeId: null,
        model: "",
        firmware: "",
        state: "on",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        accountId: "a"
    } as unknown as kinds.DeviceView;
    const ids = (device: kinds.DeviceView) =>
        deviceItem(device, "controls", { t, mayOperate: true }).controls.map(
            (control) => control.id
        );

    it("draws brightness, warmth and colour only where the light has them", () => {
        expect(ids({ ...base, kind: "light", light: null })).toEqual(["power"]);
        expect(
            ids({ ...base, kind: "light", light: { ...FULL, temperature: null, color: null } })
        ).toEqual(["power", "brightness"]);
        expect(ids({ ...base, kind: "light", light: FULL })).toEqual([
            "power",
            "brightness",
            "warmth",
            "color"
        ]);
    });

    it("draws the climate fan, extras and the humidifier target", () => {
        const climate = {
            mode: "cool",
            modes: ["cool"],
            target: 22,
            min: 16,
            max: 30,
            step: 1,
            unit: "C",
            fan: "auto",
            fans: ["auto", "low", "high"],
            options: { swing: false, eco: true },
            current: 24
        } as kinds.ClimateView;
        expect(ids({ ...base, kind: "climate", climate })).toEqual([
            "power",
            "fan",
            "option:swing",
            "option:eco",
            "target"
        ]);
        const air = {
            mode: null,
            modes: [],
            speed: null,
            speeds: [],
            humidity: { target: 50, min: 30, max: 70, step: 5 },
            options: {},
            readings: {},
            filters: []
        } as kinds.AirSettings;
        expect(ids({ ...base, kind: "air", air })).toContain("humidity");
        expect(ids({ ...base, kind: "air", air: { ...air, humidity: null } })).not.toContain(
            "humidity"
        );
    });

    it("reads each press as the device action it is", () => {
        expect(pressAsAction("brightness", 60, "light")).toEqual({
            action: "set-brightness",
            command: { action: "set-brightness", level: 60 }
        });
        expect(pressAsAction("warmth", 3000, "light")).toEqual({
            action: "set-color-temp",
            command: { action: "set-color-temp", kelvin: 3000 }
        });
        expect(pressAsAction("color", "blue", "light")).toEqual({
            action: "set-color",
            command: { action: "set-color", hue: 230, saturation: 100 }
        });
        expect(pressAsAction("color", "plaid", "light")).toBeNull();
        expect(pressAsAction("fan", "low", "climate")).toEqual({
            action: "set-fan",
            command: { action: "set-fan", fan: "low" }
        });
        expect(pressAsAction("option:eco", true, "climate")).toEqual({
            action: "set-option",
            command: { action: "set-option", option: "eco", on: true }
        });
        expect(pressAsAction("humidity", 55, "air")).toEqual({
            action: "set-humidity",
            command: { action: "set-humidity", target: 55 }
        });
    });
});
