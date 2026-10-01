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
