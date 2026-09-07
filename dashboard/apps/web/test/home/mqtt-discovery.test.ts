/**
 * Devices that announce themselves on a broker.
 *
 * One driver stands in for every bridge that publishes the discovery convention -
 * Zigbee2MQTT, Tasmota, ESPHome, Shelly - so what it makes of a description is
 * what a whole class of houses sees. The traps are all in that reading: the keys
 * come in two spellings, the state comes as a bare word or as JSON, a bridge
 * says separately whether it can reach the thing at all, and a command payload is
 * the device's own rather than a word this app chose.
 *
 * The broker is replaced. Nothing here is about MQTT.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readRetained: vi.fn(), publish: vi.fn() }));

vi.mock("@/lib/integrations/mqtt-broker", () => ({
    BrokerError: class extends Error {
        kind = "unreachable";
    },
    readRetained: mocks.readRetained,
    publish: mocks.publish
}));

const { mqttDiscoveryDriver } = await import("@/lib/home/drivers/mqtt-discovery");

const BROKER = { host: "192.168.1.20", port: "1883", username: "", password: "", prefix: "homeassistant" };

/** The two reads the driver makes, in order: the descriptions, then everything
 *  they pointed at. */
function broker(configs: Record<string, unknown>, states: Record<string, string> = {}): void {
    mocks.readRetained.mockReset();
    mocks.readRetained.mockImplementation(async (_address: unknown, filters: string[]) => {
        if (filters.some((filter) => filter.endsWith("/config"))) {
            return new Map(Object.entries(configs).map(([topic, body]) => [topic, JSON.stringify(body)]));
        }
        return new Map(Object.entries(states));
    });
}

beforeEach(() => {
    mocks.publish.mockReset();
});

describe("what a broker is announcing", () => {
    it("reads a switch and the state its description pointed at", async () => {
        broker(
            {
                "homeassistant/switch/kitchen/config": {
                    name: "Kettle",
                    unique_id: "z2m_kettle",
                    state_topic: "zigbee2mqtt/Kettle",
                    command_topic: "zigbee2mqtt/Kettle/set",
                    value_template: "{{ value_json.state }}",
                    device: { name: "Kitchen", manufacturer: "Sonoff", model: "S26" }
                }
            },
            { "zigbee2mqtt/Kettle": JSON.stringify({ state: "ON" }) }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found).toHaveLength(1);
        expect(found[0]?.kind).toBe("switch");
        expect(found[0]?.state).toBe("on");
        expect(found[0]?.externalId).toBe("z2m_kettle");
        expect(found[0]?.model).toBe("Sonoff S26");
        // The device's own name and the entity's, without saying "Kitchen" twice.
        expect(found[0]?.name).toBe("Kitchen Kettle");
    });

    it("reads the short spellings, which is what Tasmota publishes", async () => {
        broker(
            {
                "homeassistant/light/lamp/config": {
                    name: "Lamp",
                    uniq_id: "tas_lamp",
                    stat_t: "stat/lamp/POWER",
                    cmd_t: "cmnd/lamp/POWER",
                    pl_on: "ON",
                    pl_off: "OFF"
                }
            },
            { "stat/lamp/POWER": "OFF" }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found[0]?.kind).toBe("light");
        expect(found[0]?.state).toBe("off");
    });

    it("leaves out what it could only pretend to control", async () => {
        // A blind announces itself exactly like a switch. Drawing it as one would
        // be a row with an On that means something else entirely.
        broker({
            "homeassistant/cover/blind/config": {
                name: "Blind",
                state_topic: "z/b",
                command_topic: "z/b/set"
            },
            "homeassistant/switch/plug/config": {
                name: "Plug",
                state_topic: "z/p",
                command_topic: "z/p/set"
            }
        });

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found.map((device) => device.name)).toEqual(["Plug"]);
    });

    it("leaves out a switch with no way to work it", async () => {
        // Something that is only read needs a state topic; something that is
        // worked needs both, and half of one is a button that goes nowhere.
        broker({
            "homeassistant/switch/half/config": { name: "Half", state_topic: "z/h" }
        });
        expect(await mqttDiscoveryDriver.list(BROKER)).toHaveLength(0);
    });

    it("takes a sensor, which needs no way to be worked", async () => {
        broker(
            {
                "homeassistant/sensor/temp/config": {
                    name: "Temperature",
                    unique_id: "t1",
                    state_topic: "z/t",
                    unit_of_measurement: "°C",
                    device_class: "temperature",
                    value_template: "{{ value_json.temperature }}"
                }
            },
            { "z/t": JSON.stringify({ temperature: 21.5, humidity: 48 }) }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found[0]?.kind).toBe("sensor");
        expect(found[0]?.value).toBe("21.5");
        expect(found[0]?.unit).toBe("°C");
        // It reads rather than is: borrowing a lock's word here would put "Not
        // answering" beside a perfectly good temperature.
        expect(found[0]?.state).toBe("unknown");
    });

    it("says what a contact means rather than what it published", async () => {
        // "on" is what the device says and "Open" is what somebody needs to read.
        broker(
            {
                "homeassistant/binary_sensor/front/config": {
                    name: "Front door",
                    unique_id: "c1",
                    state_topic: "z/c",
                    device_class: "door",
                    payload_on: "true",
                    payload_off: "false"
                }
            },
            { "z/c": "true" }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found[0]?.value).toBe("Open");
        expect(found[0]?.unit).toBe("");
    });

    it("falls back to on and off for a contact whose class it does not know", async () => {
        broker(
            {
                "homeassistant/binary_sensor/thing/config": {
                    name: "Thing",
                    unique_id: "c2",
                    state_topic: "z/x"
                }
            },
            { "z/x": "ON" }
        );
        expect((await mqttDiscoveryDriver.list(BROKER))[0]?.value).toBe("On");
    });

    it("says nothing about the state of something the bridge cannot reach", async () => {
        broker(
            {
                "homeassistant/switch/shed/config": {
                    name: "Shed",
                    unique_id: "shed",
                    state_topic: "z/shed",
                    command_topic: "z/shed/set",
                    availability_topic: "z/shed/availability"
                }
            },
            { "z/shed": "ON", "z/shed/availability": "offline" }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found[0]?.online).toBe(false);
        expect(found[0]?.state).toBe("unknown");
    });

    it("reads a lock in the words a lock uses", async () => {
        broker(
            {
                "homeassistant/lock/front/config": {
                    name: "Front door",
                    unique_id: "front",
                    state_topic: "z/front",
                    command_topic: "z/front/set"
                }
            },
            { "z/front": "LOCKED" }
        );

        const found = await mqttDiscoveryDriver.list(BROKER);
        expect(found[0]?.kind).toBe("lock");
        expect(found[0]?.state).toBe("locked");
    });

    it("refuses a broker that answers and is announcing nothing", async () => {
        // The address is right, the password is right, and discovery is off or
        // under another prefix. Connecting would leave an empty screen with no
        // reason on it.
        broker({});
        await expect(mqttDiscoveryDriver.verify(BROKER)).rejects.toThrow(/announcing itself/);
    });
});

describe("working one", () => {
    it("says the device's own payload on the device's own topic", async () => {
        broker({
            "homeassistant/switch/plug/config": {
                name: "Plug",
                unique_id: "plug",
                state_topic: "z/p",
                command_topic: "z/p/set",
                payload_on: "1",
                payload_off: "0"
            }
        });

        await mqttDiscoveryDriver.act(BROKER, { externalId: "plug", kind: "switch" }, "turn-on");
        expect(mocks.publish).toHaveBeenCalledWith(
            expect.anything(),
            "z/p/set",
            "1",
            expect.objectContaining({ qos: 1, expirySeconds: 10 })
        );
    });

    it("never leaves a command on the broker to be replayed", async () => {
        // A retained command is a door that opens the next time something
        // reconnects.
        broker({
            "homeassistant/lock/front/config": {
                name: "Front",
                unique_id: "front",
                state_topic: "z/f",
                command_topic: "z/f/set"
            }
        });

        await mqttDiscoveryDriver.act(BROKER, { externalId: "front", kind: "lock" }, "lock");
        const options = mocks.publish.mock.calls[0]?.[3] as { retain?: boolean } | undefined;
        expect(options?.retain).not.toBe(true);
    });

    it("refuses an action the kind does not have rather than publishing something odd", async () => {
        broker({
            "homeassistant/lock/front/config": {
                name: "Front",
                unique_id: "front",
                state_topic: "z/f",
                command_topic: "z/f/set"
            }
        });

        await expect(
            mqttDiscoveryDriver.act(BROKER, { externalId: "front", kind: "lock" }, "turn-on")
        ).rejects.toThrow();
        expect(mocks.publish).not.toHaveBeenCalled();
    });

    it("says so when the device has stopped announcing itself", async () => {
        broker({});
        await expect(
            mqttDiscoveryDriver.act(BROKER, { externalId: "gone", kind: "switch" }, "turn-off")
        ).rejects.toThrow(/no longer announcing/);
    });
});
