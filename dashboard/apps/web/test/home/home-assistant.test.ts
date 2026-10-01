/**
 * Home Assistant: one connection, the whole house.
 *
 * What is checked is the translation - which domains become which kinds, what a
 * lock's words are here, how a binary sensor gets readable words - and what is
 * sent back: the service Home Assistant's REST documentation names, with the
 * entity in its body and the token in a bearer header.
 *
 * No network. The HTTP client is replaced by an install made of the shapes in
 * that documentation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
    trust: unknown;
}

let sent: Sent[] = [];
let states: unknown[] = [];
let tokenValid = true;
let serviceStatus = 200;
let configUnit = "°C";
/** What `/api/template` renders: each fan's and humidifier's device-mates. */
let devices: [string, string[]][] = [];
let templateStatus = 200;

vi.mock("@polaris-app/places/src/lib/integrations/lan-http", async (original) => {
    const actual =
        await original<typeof import("@polaris-app/places/src/lib/integrations/lan-http")>();
    return {
        ...actual,
        lanRequest: async (options: {
            url: string;
            method?: string;
            body?: string;
            headers?: Record<string, string>;
            trust?: unknown;
        }) => {
            const request: Sent = {
                url: options.url,
                method: options.method ?? "GET",
                body: options.body ?? "",
                headers: options.headers ?? {},
                trust: options.trust
            };
            sent.push(request);
            const reply = (status: number, body: unknown) => ({
                status,
                headers: {},
                body: Buffer.from(JSON.stringify(body)),
                certificate: null
            });
            if (
                !tokenValid ||
                request.headers.authorization !== "Bearer long-lived-token-0123456789"
            ) {
                return reply(401, { message: "401: Unauthorized" });
            }
            const path = new URL(options.url).pathname;
            if (path === "/api/") return reply(200, { message: "API running." });
            if (path === "/api/states") return reply(200, states);
            if (path === "/api/config")
                return reply(200, { unit_system: { temperature: configUnit } });
            if (path.startsWith("/api/states/")) {
                const id = decodeURIComponent(path.slice("/api/states/".length));
                const found = (states as { entity_id: string }[]).find(
                    (entity) => entity.entity_id === id
                );
                return found ? reply(200, found) : reply(404, {});
            }
            if (path.startsWith("/api/services/")) return reply(serviceStatus, []);
            if (path === "/api/template") return reply(templateStatus, devices);
            return reply(404, {});
        }
    };
});

const { homeAssistantDriver } = await import("@polaris-app/places/src/lib/drivers/home-assistant");

const HOME = { url: "homeassistant.local", token: "long-lived-token-0123456789" };

beforeEach(() => {
    sent = [];
    tokenValid = true;
    serviceStatus = 200;
    configUnit = "°C";
    devices = [];
    templateStatus = 200;
    states = [
        {
            entity_id: "switch.kettle",
            state: "on",
            attributes: { friendly_name: "Kettle", device_class: "outlet" }
        },
        { entity_id: "switch.porch", state: "off", attributes: { friendly_name: "Porch" } },
        {
            entity_id: "light.lounge",
            state: "unavailable",
            attributes: { friendly_name: "Lounge", restored: true }
        },
        {
            entity_id: "lock.front_door",
            state: "locking",
            attributes: { friendly_name: "Front door", supported_features: 1 }
        },
        {
            entity_id: "binary_sensor.back_door",
            state: "on",
            attributes: { friendly_name: "Back door", device_class: "door" }
        },
        {
            entity_id: "sensor.hall_temperature",
            state: "21.5",
            attributes: { friendly_name: "Hall", unit_of_measurement: "°C" }
        },
        {
            entity_id: "climate.living_room",
            state: "heat",
            attributes: {
                friendly_name: "Living room AC",
                hvac_modes: ["off", "heat", "cool", "heat_cool", "dry", "fan_only"],
                min_temp: 16,
                max_temp: 30,
                target_temp_step: 0.5,
                temperature: 22.5,
                current_temperature: 20.1,
                fan_mode: "medium low",
                fan_modes: ["auto", "low", "medium low", "medium", "high", "focus"],
                swing_mode: "off",
                swing_modes: ["off", "vertical", "horizontal", "both"],
                preset_mode: "none",
                preset_modes: ["none", "eco", "boost", "sleep"]
            }
        },
        { entity_id: "cover.garage", state: "closed", attributes: { friendly_name: "Garage" } }
    ];
});

describe("what a house has", () => {
    it("takes switches, lights, locks, sensors and air conditioners, and leaves the rest", async () => {
        const found = await homeAssistantDriver.list(HOME);
        expect(
            found.map((row) => [row.externalId, row.kind, row.name, row.state, row.online])
        ).toEqual([
            ["switch.kettle", "outlet", "Kettle", "on", true],
            ["switch.porch", "switch", "Porch", "off", true],
            ["light.lounge", "light", "Lounge", "unknown", false],
            ["lock.front_door", "lock", "Front door", "moving", true],
            ["binary_sensor.back_door", "sensor", "Back door", "unknown", true],
            ["sensor.hall_temperature", "sensor", "Hall", "unknown", true],
            ["climate.living_room", "climate", "Living room AC", "on", true]
        ]);
    });

    it("gives a contact readable words and a temperature its unit", async () => {
        const found = await homeAssistantDriver.list(HOME);
        expect(found.find((row) => row.externalId === "binary_sensor.back_door")).toMatchObject({
            value: "Open",
            unit: ""
        });
        expect(found.find((row) => row.externalId === "sensor.hall_temperature")).toMatchObject({
            value: "21.5",
            unit: "°C"
        });
    });

    it("asks at port 8123 when only an address was given, and trusts only real certificates", async () => {
        await homeAssistantDriver.list(HOME);
        expect(sent[0]?.url).toBe("http://homeassistant.local:8123/api/states");
        expect(sent[0]?.trust).toBe("system");
    });
});

describe("an air conditioner", () => {
    it("is read from its attributes, its room temperature as its reading", async () => {
        const found = await homeAssistantDriver.list(HOME);
        const unit = found.find((row) => row.externalId === "climate.living_room")!;
        expect(unit).toMatchObject({ value: "20.1", unit: "°C" });
        expect(unit.climate).toEqual({
            mode: "heat",
            // heat_cool stands in for automatic; "focus" is not a speed.
            modes: ["heat", "cool", "dry", "fan", "auto"],
            target: 22.5,
            min: 16,
            max: 30,
            step: 0.5,
            unit: "C",
            fan: "medium-low",
            fans: ["auto", "low", "medium-low", "medium", "high"],
            options: { swing: false, eco: false, turbo: false }
        });
    });

    it("is in Fahrenheit where the install is", async () => {
        configUnit = "°F";
        const found = await homeAssistantDriver.list(HOME);
        expect(found.find((row) => row.externalId === "climate.living_room")).toMatchObject({
            unit: "°F",
            climate: { unit: "F" }
        });
    });

    it("is off when its state is off", async () => {
        (states as { entity_id: string; state: string }[]).find(
            (entity) => entity.entity_id === "climate.living_room"
        )!.state = "off";
        const found = await homeAssistantDriver.list(HOME);
        expect(found.find((row) => row.externalId === "climate.living_room")).toMatchObject({
            state: "off",
            climate: { mode: null }
        });
    });

    it.each([
        ["turn-on", undefined, "turn_on", {}],
        ["turn-off", undefined, "turn_off", {}],
        [
            "set-mode",
            { action: "set-mode", mode: "auto" },
            "set_hvac_mode",
            { hvac_mode: "heat_cool" }
        ],
        [
            "set-mode",
            { action: "set-mode", mode: "fan" },
            "set_hvac_mode",
            { hvac_mode: "fan_only" }
        ],
        [
            "set-temperature",
            { action: "set-temperature", target: 23.5 },
            "set_temperature",
            { temperature: 23.5 }
        ],
        [
            "set-fan",
            { action: "set-fan", fan: "medium-low" },
            "set_fan_mode",
            { fan_mode: "medium low" }
        ],
        [
            "set-option",
            { action: "set-option", option: "swing", on: true },
            "set_swing_mode",
            { swing_mode: "vertical" }
        ],
        [
            "set-option",
            { action: "set-option", option: "turbo", on: true },
            "set_preset_mode",
            { preset_mode: "boost" }
        ],
        [
            "set-option",
            { action: "set-option", option: "eco", on: false },
            "set_preset_mode",
            { preset_mode: "none" }
        ]
    ] as const)("%s is climate.%s with its own words", async (action, command, service, data) => {
        await homeAssistantDriver.act(
            HOME,
            { externalId: "climate.living_room", kind: "climate" },
            action,
            command
        );
        const call = sent.at(-1)!;
        expect(new URL(call.url).pathname).toBe(`/api/services/climate/${service}`);
        expect(JSON.parse(call.body)).toEqual({ ...data, entity_id: "climate.living_room" });
    });

    it("refuses a mode the entity does not offer, before sending anything", async () => {
        const before = sent.length;
        (states as { entity_id: string; attributes: Record<string, unknown> }[]).find(
            (entity) => entity.entity_id === "climate.living_room"
        )!.attributes.hvac_modes = ["off", "cool"];
        await expect(
            homeAssistantDriver.act(
                HOME,
                { externalId: "climate.living_room", kind: "climate" },
                "set-mode",
                { action: "set-mode", mode: "heat" }
            )
        ).rejects.toThrow("That mode is not one this device has");
        expect(sent.slice(before).some((call) => call.method === "POST")).toBe(false);
    });

    it("refuses one temperature on an entity that only takes a range", async () => {
        const before = sent.length;
        const attributes = (
            states as { entity_id: string; attributes: Record<string, unknown> }[]
        ).find((entity) => entity.entity_id === "climate.living_room")!.attributes;
        delete attributes.temperature;
        attributes.target_temp_low = 20;
        attributes.target_temp_high = 24;
        await expect(
            homeAssistantDriver.act(
                HOME,
                { externalId: "climate.living_room", kind: "climate" },
                "set-temperature",
                { action: "set-temperature", target: 22 }
            )
        ).rejects.toThrow("This device takes a range rather than one temperature");
        expect(sent.slice(before).some((call) => call.method === "POST")).toBe(false);
    });
});

describe("what is sent", () => {
    it("turns a switch on through its domain's service", async () => {
        await homeAssistantDriver.act(
            HOME,
            { externalId: "switch.kettle", kind: "outlet" },
            "turn-on"
        );
        const call = sent.at(-1)!;
        expect(call.method).toBe("POST");
        expect(new URL(call.url).pathname).toBe("/api/services/switch/turn_on");
        expect(JSON.parse(call.body)).toEqual({ entity_id: "switch.kettle" });
    });

    it("opens a lock's latch with lock.open", async () => {
        await homeAssistantDriver.act(
            HOME,
            { externalId: "lock.front_door", kind: "lock" },
            "unlatch"
        );
        expect(new URL(sent.at(-1)!.url).pathname).toBe("/api/services/lock/open");
    });

    it("says the device cannot do it when Home Assistant answers 400", async () => {
        serviceStatus = 400;
        await expect(
            homeAssistantDriver.act(
                HOME,
                { externalId: "lock.front_door", kind: "lock" },
                "unlatch"
            )
        ).rejects.toMatchObject({ kind: "refused" });
    });

    it("refuses an action the domain does not have", async () => {
        await expect(
            homeAssistantDriver.act(HOME, { externalId: "light.lounge", kind: "light" }, "lock")
        ).rejects.toThrow();
    });
});

describe("the token", () => {
    it("is proved before anything is stored", async () => {
        await expect(homeAssistantDriver.verify(HOME)).resolves.toBeUndefined();
        expect(new URL(sent[0]!.url).pathname).toBe("/api/");
    });

    it("that is refused marks the connection, not the house", async () => {
        tokenValid = false;
        await expect(homeAssistantDriver.verify(HOME)).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });
});
describe("an air purifier", () => {
    const PURIFIER = [
        "fan.bedroom_purifier",
        "humidifier.bedroom_purifier",
        "sensor.bedroom_purifier_pm2_5",
        "sensor.bedroom_purifier_indoor_allergen_index",
        "sensor.bedroom_purifier_humidity",
        "sensor.bedroom_purifier_temperature",
        "sensor.bedroom_purifier_hepa_filter",
        "sensor.bedroom_purifier_pre_filter",
        "switch.bedroom_purifier_child_lock",
        "light.bedroom_purifier_display_backlight"
    ];

    beforeEach(() => {
        // As the Philips integration names and describes them.
        states = [
            {
                entity_id: "fan.bedroom_purifier",
                state: "on",
                attributes: {
                    friendly_name: "Bedroom purifier",
                    preset_mode: "sleep",
                    preset_modes: ["auto", "allergen", "sleep", "speed_1", "turbo", "focus"],
                    percentage: 25,
                    percentage_step: 25,
                    supported_features: 57
                }
            },
            {
                entity_id: "humidifier.bedroom_purifier",
                state: "off",
                attributes: { humidity: 50, min_humidity: 40, max_humidity: 70, current_humidity: 44 }
            },
            {
                entity_id: "sensor.bedroom_purifier_pm2_5",
                state: "9",
                attributes: { device_class: "pm25", unit_of_measurement: "µg/m³" }
            },
            { entity_id: "sensor.bedroom_purifier_indoor_allergen_index", state: "3", attributes: {} },
            {
                entity_id: "sensor.bedroom_purifier_humidity",
                state: "45",
                attributes: { device_class: "humidity", unit_of_measurement: "%" }
            },
            {
                entity_id: "sensor.bedroom_purifier_temperature",
                state: "71.6",
                attributes: { device_class: "temperature", unit_of_measurement: "°F" }
            },
            {
                entity_id: "sensor.bedroom_purifier_hepa_filter",
                state: "4",
                attributes: { unit_of_measurement: "%" }
            },
            {
                entity_id: "sensor.bedroom_purifier_pre_filter",
                state: "300",
                attributes: { unit_of_measurement: "h" }
            },
            { entity_id: "switch.bedroom_purifier_child_lock", state: "off", attributes: {} },
            { entity_id: "light.bedroom_purifier_display_backlight", state: "on", attributes: {} },
            // A ceiling fan: nothing on its device a purifier has.
            {
                entity_id: "fan.ceiling",
                state: "on",
                attributes: { friendly_name: "Ceiling", percentage: 50, percentage_step: 33.33, supported_features: 1 }
            },
            // A humidifier on its own.
            {
                entity_id: "humidifier.nursery",
                state: "on",
                attributes: {
                    friendly_name: "Nursery",
                    humidity: 55,
                    min_humidity: 30,
                    max_humidity: 70,
                    target_humidity_step: 5,
                    mode: "sleep",
                    available_modes: ["auto", "sleep", "boost"],
                    current_humidity: 41
                }
            }
        ];
        devices = [
            ["fan.bedroom_purifier", PURIFIER],
            ["humidifier.bedroom_purifier", PURIFIER],
            ["fan.ceiling", ["fan.ceiling"]],
            ["humidifier.nursery", ["humidifier.nursery"]]
        ];
    });

    it("is one row per purifier, with its device's sensors, and a ceiling fan is left out", async () => {
        const rows = (await homeAssistantDriver.list(HOME)).filter((row) => row.kind === "air");
        expect(rows.map((row) => [row.externalId, row.name, row.state])).toEqual([
            ["fan.bedroom_purifier", "Bedroom purifier", "on"],
            ["humidifier.nursery", "Nursery", "on"]
        ]);
        const purifier = rows[0]!;
        expect(purifier).toMatchObject({ value: "9", unit: "µg/m³", online: true });
        expect(purifier.air).toMatchObject({
            mode: "sleep",
            modes: ["auto", "allergen", "sleep", "speed_1", "turbo"],
            speed: "speed_1",
            speeds: ["speed_1", "speed_2", "speed_3", "speed_4"],
            humidity: { target: 50, min: 40, max: 70, step: 1 },
            options: { childLock: false, light: true, humidify: false },
            readings: { pm25: 9, allergen: 3, humidity: 45, temperature: 22 }
        });
        expect(purifier.air?.filters).toEqual([
            { kind: "hepa", percent: 4, hours: null, state: "now" },
            { kind: "pre", percent: null, hours: 300, state: "ok" }
        ]);
        // Asked which entities share a device, with Home Assistant's own functions.
        const template = sent.find((request) => new URL(request.url).pathname === "/api/template");
        expect(JSON.parse(template!.body).template).toContain("device_entities(d)");
    });

    it("reads a humidifier on its own by its modes and its target", async () => {
        const row = (await homeAssistantDriver.list(HOME)).find((entry) => entry.externalId === "humidifier.nursery");
        expect(row?.air).toMatchObject({
            mode: "sleep",
            modes: ["auto", "sleep"],
            speeds: [],
            humidity: { target: 55, min: 30, max: 70, step: 5 },
            readings: { humidity: 41 }
        });
        expect(row).toMatchObject({ value: "41", unit: "%" });
    });

    it("leaves fans out, rather than guessing, when Home Assistant will not say what shares a device", async () => {
        templateStatus = 400;
        const rows = (await homeAssistantDriver.list(HOME)).filter((row) => row.kind === "air");
        expect(rows.map((row) => row.externalId)).toEqual(["humidifier.bedroom_purifier", "humidifier.nursery"]);
    });

    const act = (action: Parameters<typeof homeAssistantDriver.act>[2], command?: unknown) =>
        homeAssistantDriver.act(
            HOME,
            { externalId: "fan.bedroom_purifier", kind: "air" },
            action,
            command as Parameters<typeof homeAssistantDriver.act>[3]
        );
    const lastService = () => {
        const request = sent.filter((entry) => new URL(entry.url).pathname.startsWith("/api/services/")).at(-1)!;
        return [new URL(request.url).pathname, JSON.parse(request.body)];
    };

    it("sets a preset, a speed, a humidity and its switches through the right entity", async () => {
        await act("set-mode", { action: "set-mode", mode: "turbo" });
        expect(lastService()).toEqual([
            "/api/services/fan/set_preset_mode",
            { preset_mode: "turbo", entity_id: "fan.bedroom_purifier" }
        ]);
        await act("set-fan", { action: "set-fan", speed: "speed_3" });
        expect(lastService()).toEqual([
            "/api/services/fan/set_percentage",
            { percentage: 75, entity_id: "fan.bedroom_purifier" }
        ]);
        await act("set-humidity", { action: "set-humidity", target: 60 });
        expect(lastService()).toEqual([
            "/api/services/humidifier/set_humidity",
            { humidity: 60, entity_id: "humidifier.bedroom_purifier" }
        ]);
        await act("set-option", { action: "set-option", option: "childLock", on: true });
        expect(lastService()).toEqual(["/api/services/switch/turn_on", { entity_id: "switch.bedroom_purifier_child_lock" }]);
        await act("set-option", { action: "set-option", option: "humidify", on: true });
        expect(lastService()).toEqual(["/api/services/humidifier/turn_on", { entity_id: "humidifier.bedroom_purifier" }]);
        await act("turn-off");
        expect(lastService()).toEqual(["/api/services/fan/turn_off", { entity_id: "fan.bedroom_purifier" }]);
    });

    it("refuses a preset or a speed the entity does not have, before sending anything", async () => {
        await expect(act("set-mode", { action: "set-mode", mode: "gas" })).rejects.toThrow(
            "That mode is not one this device has"
        );
        await expect(act("set-fan", { action: "set-fan", speed: "speed_5" })).rejects.toThrow(
            "That fan speed is not one this device has"
        );
        expect(sent.some((entry) => new URL(entry.url).pathname.startsWith("/api/services/"))).toBe(false);
    });
});
