/**
 * The Midea LAN protocol, pinned byte for byte against vectors midea-local's own
 * Python produced (`fixtures/midea-vectors.json`): the CRC8 table, the a1 query
 * and set frames, a status frame read back, the 5A5A packet, the v3 handshake and
 * the 8370 envelope both ways, and the cloud's hashes and ciphers.
 */

import { describe, expect, it } from "vitest";
import vectors from "./fixtures/midea-vectors.json";
import * as cloud from "@polaris-app/places/src/lib/integrations/midea-cloud";
import * as protocol from "@polaris-app/places/src/lib/integrations/midea-protocol";

const hex = (value: string) => Buffer.from(value, "hex");

describe("the a1 frames", () => {
    it("computes midea-local's CRC8 table", () => {
        const table = Array.from({ length: 256 }, (_, i) => protocol.crc8(Uint8Array.of(i)));
        expect(table).toEqual(vectors.crc8Table);
        expect(protocol.crc8(hex(vectors.crc8[0]!.data))).toBe(vectors.crc8[0]!.crc);
    });

    it("builds the query and the set exactly as MessageQuery and MessageSet do", () => {
        expect(protocol.a1Query(7).toString("hex")).toBe(vectors.query);
        const set = protocol.a1Set(
            {
                power: true,
                promptTone: true,
                modeCode: 3,
                fanCode: 60,
                targetHumidity: 55,
                childLock: false,
                swing: true,
                anion: false,
                pump: true,
                pumpEnable: true,
                waterLevelSet: 75
            },
            vectors.setMessageId
        );
        expect(set.toString("hex")).toBe(vectors.set);
    });

    it("reads a status frame as MessageA1Response does, and derives a full tank", () => {
        const status = protocol.parseA1(hex(vectors.response.frame))!;
        const parsed = vectors.response.parsed;
        expect(status).toMatchObject({
            power: parsed.power,
            modeCode: parsed.mode,
            fanCode: parsed.fan_speed,
            targetHumidity: parsed.target_humidity,
            childLock: parsed.child_lock,
            pump: parsed.pump,
            tank: parsed.tank,
            waterLevelSet: parsed.water_level_set,
            currentHumidity: parsed.current_humidity,
            currentTemperature: parsed.current_temperature,
            swing: parsed.swing,
            tankFull: true
        });
        expect(protocol.A1_MODES[status.modeCode]).toBe("continuous");
        expect(protocol.A1_SPEEDS[status.fanCode]).toBe("high");
    });

    it("refuses what is not an a1 status", () => {
        expect(protocol.parseA1(hex("aa0bac0000000000000341"))).toBeNull();
        expect(protocol.parseA1(new Uint8Array(3))).toBeNull();
    });

    it("keeps everything the unit reported when building a set from it", () => {
        const status = protocol.parseA1(hex(vectors.response.frame))!;
        expect(protocol.commandFromStatus(status)).toMatchObject({
            power: true,
            modeCode: 2,
            fanCode: 80,
            targetHumidity: 50,
            waterLevelSet: 75
        });
        expect(protocol.a1ModeCode("auto")).toBe(3);
        expect(protocol.a1SpeedCode("auto")).toBe(102);
    });
});

describe("the 5A5A packet", () => {
    it("wraps a frame as PacketBuilder.finalize does, and unwraps it again", () => {
        const built = protocol.packet(
            BigInt(`0x${vectors.packet.deviceId}`),
            hex(vectors.packet.command),
            hex(vectors.packet.time)
        );
        expect(built.toString("hex")).toBe(vectors.packet.bytes);
        expect(protocol.unpacket(built)?.toString("hex")).toBe(vectors.packet.command);
    });

    it("writes the clock in packet_time's order", () => {
        const time = protocol.packetTime(new Date(Date.UTC(2026, 10, 5, 12, 34, 56, 789)));
        // "20261105123456789000"[:16] in pairs, last first.
        expect([...time]).toEqual([78, 56, 34, 12, 5, 11, 26, 20]);
    });

    it("reads the appliance id out of a discovery answer", () => {
        const answer = Buffer.alloc(120);
        answer.set([0x5a, 0x5a]);
        answer.writeBigUInt64LE(0x1122334455n, 20);
        expect(protocol.discoveredId(answer)).toBe(0x1122334455n);
        expect(protocol.discoveredId(Buffer.alloc(10))).toBeNull();
        expect(protocol.DISCOVERY_MESSAGE.toString("hex")).toBe(vectors.broadcast);
    });
});

describe("the 8370 envelope", () => {
    it("shakes hands and derives the session key as LocalSecurity.tcp_key does", () => {
        const session = new protocol.Session8370();
        const request = session.encode(hex(vectors.handshake.token), protocol.HANDSHAKE_REQUEST);
        expect(request.toString("hex")).toBe(vectors.handshake.request);
        const key = session.accept(hex(vectors.handshake.response), hex(vectors.handshake.key));
        expect(key.toString("hex")).toBe(vectors.handshake.tcpKey);
    });

    it("encrypts a request and decodes a response byte for byte", () => {
        const session = new protocol.Session8370((size) => Buffer.alloc(size, 0xee));
        session.accept(hex(vectors.handshake.response), hex(vectors.handshake.key));
        const sent = session.encode(hex(vectors.encrypted.data), protocol.ENCRYPTED_REQUEST);
        expect(sent.toString("hex")).toBe(vectors.encrypted.bytes);
        const { messages, rest } = session.decode(hex(vectors.decoded.bytes));
        expect(messages.map((message) => message.toString("hex"))).toEqual(vectors.decoded.packets);
        expect(rest.length).toBe(0);
    });

    it("waits for the rest of a message that arrived in pieces", () => {
        const session = new protocol.Session8370();
        session.accept(hex(vectors.handshake.response), hex(vectors.handshake.key));
        const whole = hex(vectors.decoded.bytes);
        const first = session.decode(whole.subarray(0, 20));
        expect(first.messages).toEqual([]);
        const second = session.decode(Buffer.concat([first.rest, whole.subarray(20)]));
        expect(second.messages).toHaveLength(1);
    });

    it("refuses a handshake answer made with another key", () => {
        const session = new protocol.Session8370();
        expect(() => session.accept(hex(vectors.handshake.response), Buffer.alloc(32, 1))).toThrow(
            protocol.MideaProtocolError
        );
        expect(() => session.accept(Buffer.from("ERROR"), Buffer.alloc(32))).toThrow(/refused/);
    });
});

describe("the MSmartHome cloud's crypto", () => {
    const c = vectors.cloud;

    it("uses the app's public constants", () => {
        expect(cloud.MSMART_HOME).toMatchObject({
            appId: c.appId,
            appKey: c.appKey,
            iotKey: c.iotKey,
            hmacKey: c.hmacKey
        });
        expect(c.apiUrl.startsWith(cloud.MSMART_HOME.apiUrl)).toBe(true);
    });

    it("hashes, signs and ciphers as MSmartCloudSecurity does", () => {
        expect(cloud.cloudDeviceId("someone@example.com")).toBe(c.deviceId);
        expect(cloud.encryptPassword("loginid-1", "Secret1!")).toBe(c.password);
        expect(cloud.encryptIamPassword("loginid-1", "Secret1!")).toBe(c.iamPassword);
        expect(cloud.sign('{"a": 1}', "1700000000")).toBe(c.sign);
        expect(cloud.udpId(151732605161920n, 1)).toBe(c.udp1);
        expect(cloud.udpId(151732605161920n, 2)).toBe(c.udp2);
        expect(cloud.encryptAccount("someone@example.com")).toBe(c.account);
        const keys = cloud.sessionKeys(c.keys.accessToken, c.keys.randomData);
        expect(cloud.decryptWithSession(keys, c.keys.snCipher)).toBe(c.keys.sn);
    });
});
