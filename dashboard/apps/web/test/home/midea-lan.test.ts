/**
 * The Midea / Comfee driver against a simulated account and a simulated unit:
 * the cloud answers through a replaced fetch, and the unit is a v3 session
 * built from midea-local's own vectors (`fixtures/midea-vectors.json`),
 * speaking back through a replaced socket. No real unit has been on the other
 * end of this.
 */

import vectors from "./fixtures/midea-vectors.json";
import * as driver from "@polaris-app/places/src/lib/drivers/midea-lan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverError } from "@polaris-app/places/src/lib/drivers/contract";
import * as cloud from "@polaris-app/places/src/lib/integrations/midea-cloud";
import * as protocol from "@polaris-app/places/src/lib/integrations/midea-protocol";

vi.mock("@polaris-app/places/src/lib/integrations/lan-unit", async (original) => ({
    ...(await original<object>()),
    subnetTargets: async () => []
}));

const hex = (value: string) => Buffer.from(value, "hex");
const ID = "1122334455";
const ADDRESS = "192.168.1.40";
const CREDENTIALS = { email: "Someone@Example.com ", password: "secret", hosts: "" };

/** What the account answers, endpoint by endpoint; tests change parts of it. */
let answers: Record<string, unknown>;
let online = "1";
let fetched: string[] = [];

function cloudAnswers(): Record<string, unknown> {
    return {
        "/v1/unitcenter/router/user/name": { code: 0, data: {} },
        "/v1/user/login/id/get": { code: 0, data: { loginId: "login-1" } },
        "/mj/user/login": {
            code: 0,
            data: {
                uid: "uid-1",
                accessToken: vectors.cloud.keys.accessToken,
                randomData: vectors.cloud.keys.randomData,
                mdata: { accessToken: "token-1" }
            }
        },
        "/v1/appliance/user/list/get": {
            code: 0,
            data: {
                list: [
                    {
                        id: ID,
                        name: "Bedroom",
                        type: "0xA1",
                        sn: vectors.cloud.keys.snCipher,
                        onlineStatus: online
                    },
                    { id: "99", name: "Air conditioner", type: "0xAC", sn: "", onlineStatus: "1" }
                ]
            }
        },
        "/v1/iot/secure/getToken": {
            code: 0,
            data: {
                tokenlist: [
                    {
                        udpId: cloud.udpId(BigInt(ID), 1),
                        token: vectors.handshake.token,
                        key: vectors.handshake.key
                    }
                ]
            }
        }
    };
}

/** A unit: shakes hands with the vector's key, answers every frame with the
 *  vector's status, and records what it was sent. */
let reachable = true;
let unitKey = vectors.handshake.key;
let received: Buffer[] = [];
let scans: string[][] = [];

function fakeLink(): driver.MideaLink {
    const unit = new protocol.Session8370();
    const queue: Buffer[] = [];
    return {
        write(data) {
            const { messages } = unit.decode(data);
            for (const message of messages) {
                if (message.length === 64 && data[5] === protocol.HANDSHAKE_REQUEST) {
                    if (unitKey !== vectors.handshake.key) {
                        queue.push(Buffer.from("ERROR"));
                        continue;
                    }
                    queue.push(
                        unit.encode(hex(vectors.handshake.response), protocol.HANDSHAKE_RESPONSE)
                    );
                    unit.accept(hex(vectors.handshake.response), hex(vectors.handshake.key));
                    continue;
                }
                const frame = protocol.unpacket(message)!;
                received.push(frame);
                const reply = protocol.packet(
                    BigInt(ID),
                    hex(vectors.response.frame),
                    protocol.packetTime(new Date())
                );
                queue.push(unit.encode(reply, protocol.ENCRYPTED_RESPONSE));
            }
        },
        read: async () => {
            const next = queue.shift();
            if (!next) throw new Error("closed");
            return next;
        },
        close: () => undefined
    };
}

function discoveryAnswer(id: string): Buffer {
    const out = Buffer.alloc(104);
    out[0] = 0x5a;
    out[1] = 0x5a;
    const raw = Buffer.alloc(8);
    raw.writeBigUInt64LE(BigInt(id));
    raw.copy(out, 20, 0, 6);
    return out;
}

beforeEach(() => {
    online = "1";
    answers = cloudAnswers();
    fetched = [];
    reachable = true;
    unitKey = vectors.handshake.key;
    received = [];
    scans = [];
    driver.forgetMideaUnits();
    cloud.setMideaPause(async () => undefined);
    cloud.setMideaFetcher(async (input, init) => {
        const alias = decodeURI(new URL(String(input)).searchParams.get("alias") ?? "");
        fetched.push(alias);
        if (alias === "/mj/user/login") {
            const sent = JSON.parse(String(init?.body));
            expect(sent.iotData.loginAccount).toBe("someone@example.com");
        }
        return new Response(JSON.stringify(answers[alias] ?? { code: 1, msg: "unknown" }));
    });
    driver.setMideaTransport({
        connect: async () => {
            if (!reachable) throw new Error("ECONNREFUSED");
            return fakeLink();
        },
        scan: async (targets) => {
            scans.push([...targets]);
            return [{ address: ADDRESS, data: discoveryAnswer(ID) }];
        }
    });
});

afterEach(() => {
    cloud.setMideaFetcher();
    cloud.setMideaPause();
    driver.setMideaTransport();
});

describe("the Midea / Comfee driver", () => {
    it("verifies the account and checks the addresses typed", async () => {
        await expect(driver.mideaLanDriver.verify(CREDENTIALS)).resolves.toBeUndefined();
        await expect(
            driver.mideaLanDriver.verify({ ...CREDENTIALS, hosts: "192.168.1.40, 127.0.0.1" })
        ).rejects.toBeInstanceOf(DriverError);
    });

    it("lists the dehumidifiers only, read on the unit itself", async () => {
        const [unit, ...rest] = await driver.mideaLanDriver.list(CREDENTIALS);
        expect(rest).toEqual([]);
        expect(unit).toMatchObject({
            externalId: ID,
            kind: "dehumidifier",
            name: "Bedroom",
            model: vectors.cloud.keys.sn.slice(9, 17),
            state: "on",
            online: true
        });
        expect(unit!.air).toMatchObject({
            mode: "continuous",
            speed: "high",
            humidity: { target: 50, min: 35, max: 85 },
            readings: { humidity: 63, temperature: 20 },
            tankFull: true
        });
        expect(received.map((frame) => frame.toString("hex"))).toEqual([
            protocol.a1Query(1).toString("hex")
        ]);
        expect(scans[0]).toContain("255.255.255.255");
    });

    it("sets on top of the state it just read", async () => {
        await driver.mideaLanDriver.act(
            CREDENTIALS,
            { externalId: ID, kind: "dehumidifier" },
            "set-humidity",
            {
                action: "set-humidity",
                target: 45
            }
        );
        expect(received).toHaveLength(2);
        const status = protocol.parseA1(hex(vectors.response.frame))!;
        const expected = protocol.a1Set(
            { ...protocol.commandFromStatus(status), promptTone: true, targetHumidity: 45 },
            received[1]![received[1]!.length - 3]!
        );
        expect(received[1]!.toString("hex")).toBe(expected.toString("hex"));
    });

    it("turns off and changes mode", async () => {
        await driver.mideaLanDriver.act(
            CREDENTIALS,
            { externalId: ID, kind: "dehumidifier" },
            "turn-off"
        );
        expect(received[1]![11]! & 0x01).toBe(0);
        received = [];
        await driver.mideaLanDriver.act(
            CREDENTIALS,
            { externalId: ID, kind: "dehumidifier" },
            "set-mode",
            {
                action: "set-mode",
                mode: "clothes_dry"
            }
        );
        expect(received[1]![12]).toBe(4);
    });

    it("refuses a mode the unit does not have", async () => {
        await expect(
            driver.mideaLanDriver.act(
                CREDENTIALS,
                { externalId: ID, kind: "dehumidifier" },
                "set-mode",
                {
                    action: "set-mode",
                    mode: "turbo"
                }
            )
        ).rejects.toMatchObject({ kind: "refused" });
    });
});

describe("what the driver says when it cannot", () => {
    it("says the password was refused", async () => {
        answers["/mj/user/login"] = { code: 3101, msg: "bad" };
        await expect(driver.mideaLanDriver.verify(CREDENTIALS)).rejects.toMatchObject({
            kind: "unauthorized",
            message: "MSmartHome refused that email or password."
        });
    });

    it("says MSmartHome could not be reached", async () => {
        cloud.setMideaFetcher(async () => {
            throw new Error("offline");
        });
        await expect(driver.mideaLanDriver.list(CREDENTIALS)).rejects.toMatchObject({
            kind: "unreachable"
        });
    });

    it("says a unit is offline in the app", async () => {
        online = "0";
        answers = cloudAnswers();
        const [unit] = await driver.mideaLanDriver.list(CREDENTIALS);
        expect(unit).toMatchObject({ online: false, state: "unknown" });
        await expect(
            driver.mideaLanDriver.act(
                CREDENTIALS,
                { externalId: ID, kind: "dehumidifier" },
                "turn-on"
            )
        ).rejects.toMatchObject({
            kind: "unreachable",
            message:
                "Bedroom shows as offline in the MSmartHome app. Check it is plugged in and on Wi-Fi."
        });
    });

    it("says where a unit did not answer", async () => {
        reachable = false;
        const [unit] = await driver.mideaLanDriver.list(CREDENTIALS);
        expect(unit).toMatchObject({ online: false });
        await expect(
            driver.mideaLanDriver.act(
                CREDENTIALS,
                { externalId: ID, kind: "dehumidifier" },
                "turn-on"
            )
        ).rejects.toMatchObject({
            kind: "unreachable",
            message: `The dehumidifier did not answer at ${ADDRESS}. Check it is switched on and on the same network as Polaris.`
        });
    });

    it("says a unit the scan missed should have its address typed", async () => {
        driver.setMideaTransport({ connect: async () => fakeLink(), scan: async () => [] });
        await expect(
            driver.mideaLanDriver.act(
                CREDENTIALS,
                { externalId: ID, kind: "dehumidifier" },
                "turn-on"
            )
        ).rejects.toMatchObject({
            kind: "unreachable",
            message: expect.stringContaining("Type its IP address")
        });
    });

    it("says a unit refused the key", async () => {
        unitKey = "00".repeat(32);
        await expect(
            driver.mideaLanDriver.act(
                CREDENTIALS,
                { externalId: ID, kind: "dehumidifier" },
                "turn-on"
            )
        ).rejects.toMatchObject({
            kind: "refused",
            message: expect.stringContaining(`at ${ADDRESS} refused`)
        });
    });
});
