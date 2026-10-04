/**
 * Philips Dynalite: the Dynet messages, and areas as lights through a gateway.
 *
 * The bytes are pinned to what python-dynalite-devices (the library Home
 * Assistant's dynalite integration uses) writes for the same calls - its
 * `select_area_preset_packet`, `request_area_preset_packet` and checksum - and
 * the gateway is a fixture that answers the way one does: a report for every
 * area it knows, silence for one it does not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the fake gateway was sent, and what it answers each request with. */
const gateway = {
    sent: [] as { host: string; port: number; bytes: number[][] }[],
    /** The preset each area is in; an area missing here never answers. */
    presets: new Map<number, number>(),
    fail: null as Error | null
};

vi.mock("@polaris-app/places/src/lib/integrations/dynet-link", async () => {
    const dynet = await import("@polaris-app/places/src/lib/integrations/dynet");
    return {
        dynetExchange: async (host: string, port: number, messages: Buffer[]) => {
            if (gateway.fail) throw gateway.fail;
            gateway.sent.push({ host, port, bytes: messages.map((message) => [...message]) });
            const heard: ReturnType<typeof dynet.decodeDynet>["messages"] = [];
            for (const message of messages) {
                const [decoded] = dynet.decodeDynet(message).messages;
                if (!decoded || decoded.opcode !== dynet.REQUEST_PRESET) continue;
                const preset = gateway.presets.get(decoded.area);
                if (preset === undefined) continue;
                heard.push({
                    area: decoded.area,
                    opcode: dynet.REPORT_PRESET,
                    data: [preset - 1, 0, 0]
                });
            }
            return heard;
        }
    };
});

const dynet = await import("@polaris-app/places/src/lib/integrations/dynet");
const { philipsDynaliteDriver } = await import(
    "@polaris-app/places/src/lib/drivers/philips-dynalite"
);
const registry = await import("@polaris-app/places/src/lib/device-connections");

/** The library's checksum, written out: the two's complement of the sum of
 *  the first seven bytes. */
function libraryChecksum(bytes: number[]): number {
    return -(bytes.slice(0, 7).reduce((a, b) => a + b, 0) % 256) & 0xff;
}

const CONNECTION = { host: "192.168.1.50", areas: "1, 2, 7" };

beforeEach(() => {
    gateway.sent = [];
    gateway.presets = new Map();
    gateway.fail = null;
});

describe("Dynet messages", () => {
    it("selects presets 1-4 and 5-8 with the library's opcodes, banks and checksum", () => {
        expect([...dynet.selectPreset(1, 1)]).toEqual([0x1c, 1, 0, 0, 0, 0, 0xff, 0xe4]);
        // Preset 4: opcode 3. Preset 5: opcode 10. Preset 9: bank 1, opcode 0.
        expect([...dynet.selectPreset(2, 4)].slice(0, 7)).toEqual([0x1c, 2, 0, 3, 0, 0, 0xff]);
        expect([...dynet.selectPreset(2, 5)].slice(0, 7)).toEqual([0x1c, 2, 0, 10, 0, 0, 0xff]);
        expect([...dynet.selectPreset(2, 9)].slice(0, 7)).toEqual([0x1c, 2, 0, 0, 0, 1, 0xff]);
        // A two-second fade is a hundred 20 ms steps, low byte first.
        expect([...dynet.selectPreset(3, 1, 2)].slice(0, 7)).toEqual([0x1c, 3, 100, 0, 0, 0, 0xff]);
        for (const message of [dynet.selectPreset(9, 6, 7.5), dynet.requestPreset(200)]) {
            expect(message[7]).toBe(libraryChecksum([...message]));
        }
    });

    it("asks an area for its preset with opcode 0x63", () => {
        expect([...dynet.requestPreset(7)].slice(0, 7)).toEqual([0x1c, 7, 0, 0x63, 0, 0, 0xff]);
    });

    it("refuses what does not fit in the protocol", () => {
        expect(() => dynet.selectPreset(1, 0)).toThrow(RangeError);
        expect(() => dynet.selectPreset(1, 65)).toThrow(RangeError);
        expect(() => dynet.requestPreset(256)).toThrow(RangeError);
    });

    it("reads messages out of a stream, skipping noise and bad checksums, keeping the rest", () => {
        const report = dynet.encodeDynet({ area: 7, opcode: dynet.REPORT_PRESET, data: [3, 0, 0] });
        const broken = Buffer.from(report);
        broken[7] = (broken[7]! + 1) & 0xff;
        const stream = Buffer.concat([
            Buffer.from([0x00, 0x42]),
            broken,
            report,
            dynet.selectPreset(2, 6),
            report.subarray(0, 5)
        ]);
        const { messages, rest } = dynet.decodeDynet(stream);
        expect(messages.map((message) => [message.area, dynet.presetOf(message)])).toEqual([
            [7, 4],
            [2, 6]
        ]);
        expect([...rest]).toEqual([...report.subarray(0, 5)]);
    });

    it("says nothing about a preset for a message that is not about one", () => {
        expect(dynet.presetOf({ area: 1, opcode: 0x60, data: [0, 0, 0] })).toBeNull();
    });
});

describe("the connection's fields", () => {
    const dynalite = registry.deviceConnection("philips-dynalite")!;
    const field = (key: string) => dynalite.fields.find((entry) => entry.key === key)!;

    it("takes area numbers, in order and once each", () => {
        expect(registry.dynaliteAreas("1, 2 7;2")).toEqual([1, 2, 7]);
        for (const typed of ["0", "256", "1,a", "", "1.5"]) {
            expect(registry.dynaliteAreas(typed), typed).toBeNull();
        }
        expect(
            registry.dynaliteAreas(Array.from({ length: 65 }, (_, i) => i + 1).join(","))
        ).toBeNull();
        expect(registry.fieldIssue(field("areas"), "1, x")).toMatch(/area numbers from 1 to 255/);
        expect(registry.fieldIssue(field("areas"), "1, 2")).toBeNull();
    });

    it("takes a port from 1 to 65535, and starts on the gateways' own", () => {
        expect(field("port").defaultValue).toBe("12345");
        expect(registry.fieldIssue(field("port"), "70000")).toMatch(/port number/);
        expect(registry.fieldIssue(field("port"), "12345")).toBeNull();
        expect(registry.fieldsComplete(dynalite, { host: "192.168.1.50", areas: "1" })).toBe(true);
        expect(registry.fieldsComplete(dynalite, { host: "192.168.1.50" })).toBe(false);
    });
});

describe("areas as lights", () => {
    it("lists every area typed, on, off or not known by the preset it reports", async () => {
        gateway.presets = new Map([
            [1, 1],
            [2, 4]
        ]);
        const devices = await philipsDynaliteDriver.list(CONNECTION);
        expect(
            devices.map((device) => [device.externalId, device.kind, device.name, device.state])
        ).toEqual([
            ["area-1", "light", "Area 1", "on"],
            ["area-2", "light", "Area 2", "off"],
            ["area-7", "light", "Area 7", "unknown"]
        ]);
        // One request per area, to the gateway's default port.
        expect(gateway.sent).toHaveLength(1);
        expect(gateway.sent[0]).toMatchObject({ host: "192.168.1.50", port: 12345 });
        expect(gateway.sent[0]!.bytes).toEqual(
            [1, 2, 7].map((area) => [...dynet.requestPreset(area)])
        );
    });

    it("reads a preset other than off as on", async () => {
        gateway.presets = new Map([[1, 3]]);
        const [area] = await philipsDynaliteDriver.list({ ...CONNECTION, areas: "1" });
        expect(area!.state).toBe("on");
    });

    it("turns an area on with preset 1 and off with preset 4, on the port typed", async () => {
        const typed = { ...CONNECTION, port: "4000" };
        const device = { externalId: "area-7", kind: "light" };
        await philipsDynaliteDriver.act(typed, device, "turn-on");
        await philipsDynaliteDriver.act(typed, device, "turn-off");
        expect(gateway.sent.map((call) => [call.port, call.bytes])).toEqual([
            [4000, [[...dynet.selectPreset(7, 1)]]],
            [4000, [[...dynet.selectPreset(7, 4)]]]
        ]);
    });

    it("refuses an area no longer on the connection, and an action an area has not got", async () => {
        await expect(
            philipsDynaliteDriver.act(
                CONNECTION,
                { externalId: "area-9", kind: "light" },
                "turn-on"
            )
        ).rejects.toThrow("That area is no longer on this connection.");
        await expect(
            philipsDynaliteDriver.act(CONNECTION, { externalId: "area-1", kind: "light" }, "lock")
        ).rejects.toThrow("A Dynalite area cannot be told to do that");
        expect(gateway.sent).toEqual([]);
    });

    it("checks the gateway answers before connecting, and says so when it does not", async () => {
        await expect(philipsDynaliteDriver.verify(CONNECTION)).resolves.toBeUndefined();
        const { DriverError } = await import("@polaris-app/places/src/lib/drivers/contract");
        gateway.fail = new DriverError(
            "The Dynalite gateway did not answer in time.",
            "unreachable"
        );
        await expect(philipsDynaliteDriver.verify(CONNECTION)).rejects.toThrow(
            "The Dynalite gateway did not answer in time."
        );
    });

    it("refuses a connection with no areas or a bad port before dialling anything", async () => {
        await expect(philipsDynaliteDriver.list({ host: "192.168.1.50" })).rejects.toThrow(
            "List the area numbers to bring in"
        );
        await expect(philipsDynaliteDriver.list({ ...CONNECTION, port: "99999" })).rejects.toThrow(
            "Type a port number from 1 to 65535"
        );
        expect(gateway.sent).toEqual([]);
    });
});
