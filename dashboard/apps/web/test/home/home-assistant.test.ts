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

vi.mock("@polaris-app/places/src/lib/integrations/lan-http", async (original) => {
    const actual = await original<typeof import("@polaris-app/places/src/lib/integrations/lan-http")>();
    return {
        ...actual,
        lanRequest: async (options: { url: string; method?: string; body?: string; headers?: Record<string, string>; trust?: unknown }) => {
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
            if (!tokenValid || request.headers.authorization !== "Bearer long-lived-token-0123456789") {
                return reply(401, { message: "401: Unauthorized" });
            }
            const path = new URL(options.url).pathname;
            if (path === "/api/") return reply(200, { message: "API running." });
            if (path === "/api/states") return reply(200, states);
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
    states = [
        { entity_id: "switch.kettle", state: "on", attributes: { friendly_name: "Kettle", device_class: "outlet" } },
        { entity_id: "switch.porch", state: "off", attributes: { friendly_name: "Porch" } },
        { entity_id: "light.lounge", state: "unavailable", attributes: { friendly_name: "Lounge", restored: true } },
        { entity_id: "lock.front_door", state: "locking", attributes: { friendly_name: "Front door", supported_features: 1 } },
        { entity_id: "binary_sensor.back_door", state: "on", attributes: { friendly_name: "Back door", device_class: "door" } },
        { entity_id: "sensor.hall_temperature", state: "21.5", attributes: { friendly_name: "Hall", unit_of_measurement: "°C" } },
        { entity_id: "climate.living_room", state: "heat", attributes: { friendly_name: "Thermostat" } },
        { entity_id: "cover.garage", state: "closed", attributes: { friendly_name: "Garage" } }
    ];
});

describe("what a house has", () => {
    it("takes switches, lights, locks and sensors, and leaves the rest", async () => {
        const found = await homeAssistantDriver.list(HOME);
        expect(found.map((row) => [row.externalId, row.kind, row.name, row.state, row.online])).toEqual([
            ["switch.kettle", "outlet", "Kettle", "on", true],
            ["switch.porch", "switch", "Porch", "off", true],
            ["light.lounge", "light", "Lounge", "unknown", false],
            ["lock.front_door", "lock", "Front door", "moving", true],
            ["binary_sensor.back_door", "sensor", "Back door", "unknown", true],
            ["sensor.hall_temperature", "sensor", "Hall", "unknown", true]
        ]);
    });

    it("gives a contact readable words and a temperature its unit", async () => {
        const found = await homeAssistantDriver.list(HOME);
        expect(found.find((row) => row.externalId === "binary_sensor.back_door")).toMatchObject({ value: "Open", unit: "" });
        expect(found.find((row) => row.externalId === "sensor.hall_temperature")).toMatchObject({ value: "21.5", unit: "°C" });
    });

    it("asks at port 8123 when only an address was given, and trusts only real certificates", async () => {
        await homeAssistantDriver.list(HOME);
        expect(sent[0]?.url).toBe("http://homeassistant.local:8123/api/states");
        expect(sent[0]?.trust).toBe("system");
    });
});

describe("what is sent", () => {
    it("turns a switch on through its domain's service", async () => {
        await homeAssistantDriver.act(HOME, { externalId: "switch.kettle", kind: "outlet" }, "turn-on");
        const call = sent.at(-1)!;
        expect(call.method).toBe("POST");
        expect(new URL(call.url).pathname).toBe("/api/services/switch/turn_on");
        expect(JSON.parse(call.body)).toEqual({ entity_id: "switch.kettle" });
    });

    it("opens a lock's latch with lock.open", async () => {
        await homeAssistantDriver.act(HOME, { externalId: "lock.front_door", kind: "lock" }, "unlatch");
        expect(new URL(sent.at(-1)!.url).pathname).toBe("/api/services/lock/open");
    });

    it("says the device cannot do it when Home Assistant answers 400", async () => {
        serviceStatus = 400;
        await expect(
            homeAssistantDriver.act(HOME, { externalId: "lock.front_door", kind: "lock" }, "unlatch")
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
        await expect(homeAssistantDriver.verify(HOME)).rejects.toMatchObject({ kind: "unauthorized" });
    });
});
