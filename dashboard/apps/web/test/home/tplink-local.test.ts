/**
 * TP-Link on the local network: the two ciphers, and what a device is made into.
 *
 * Everything that can go wrong here goes wrong silently: a seed in the wrong
 * order, the wrong one of two hash formulas, a sequence number packed unsigned -
 * and the device simply stops answering. So the device on the other end of these
 * tests is written from python-kasa's description of the protocol, separately
 * from the code under test, and the driver has to get through its handshake and
 * its cipher to read anything at all.
 *
 * No network. The HTTP client and the socket are replaced by that device.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// A device, written from python-kasa's klaptransport.py and xortransport.py
// ---------------------------------------------------------------------------

const sha256 = (...parts: Buffer[]) => createHash("sha256").update(Buffer.concat(parts)).digest();
const sha1 = (value: Buffer) => createHash("sha1").update(value).digest();
const md5 = (value: Buffer) => createHash("md5").update(value).digest();

function authHash(version: 1 | 2, user: string, pass: string): Buffer {
    const u = Buffer.from(user);
    const p = Buffer.from(pass);
    return version === 1 ? md5(Buffer.concat([md5(u), md5(p)])) : sha256(sha1(u), sha1(p));
}

interface Device {
    version: 1 | 2;
    user: string;
    pass: string;
    /** What the device answers each decrypted request with. */
    answer: (request: Record<string, unknown>) => unknown;
    requests: Record<string, unknown>[];
    local?: Buffer;
    remote?: Buffer;
    authed?: boolean;
}

let device: Device | null = null;
let xorDevice: { answer: (request: Record<string, unknown>) => unknown; requests: Record<string, unknown>[] } | null =
    null;

function sessionKeys(local: Buffer, remote: Buffer, auth: Buffer) {
    const key = sha256(Buffer.from("lsk"), local, remote, auth).subarray(0, 16);
    const full = sha256(Buffer.from("iv"), local, remote, auth);
    const sig = sha256(Buffer.from("ldk"), local, remote, auth).subarray(0, 28);
    return { key, iv: full.subarray(0, 12), sig };
}

function ivFor(iv: Buffer, seq: number): Buffer {
    const tail = Buffer.alloc(4);
    tail.writeInt32BE(seq);
    return Buffer.concat([iv, tail]);
}

vi.mock("@polaris-app/places/src/lib/integrations/lan-http", async () => {
    const { DriverError } = await import("@polaris-app/places/src/lib/drivers/contract");
    return {
        lanRequest: async (options: { url: string; body?: Buffer; headers?: Record<string, string> }) => {
            if (!device) throw new DriverError("Nothing answered on that address and port.", "unreachable");
            const url = new URL(options.url);
            const body = options.body ?? Buffer.alloc(0);
            const auth = authHash(device.version, device.user, device.pass);
            if (url.pathname === "/app/handshake1") {
                device.local = body;
                device.remote = randomBytes(16);
                const hash =
                    device.version === 1
                        ? sha256(device.local, auth)
                        : sha256(device.local, device.remote, auth);
                return {
                    status: 200,
                    headers: { "set-cookie": ["TP_SESSIONID=abc123;TIMEOUT=86400"] },
                    body: Buffer.concat([device.remote, hash]),
                    certificate: null
                };
            }
            if (url.pathname === "/app/handshake2") {
                const expected =
                    device.version === 1
                        ? sha256(device.remote!, auth)
                        : sha256(device.remote!, device.local!, auth);
                device.authed = body.equals(expected) && options.headers?.cookie === "TP_SESSIONID=abc123";
                return { status: device.authed ? 200 : 403, headers: {}, body: Buffer.alloc(0), certificate: null };
            }
            if (url.pathname === "/app/request") {
                if (!device.authed) return { status: 403, headers: {}, body: Buffer.alloc(0), certificate: null };
                const seq = Number(url.searchParams.get("seq"));
                const keys = sessionKeys(device.local!, device.remote!, auth);
                const signature = body.subarray(0, 32);
                const ciphertext = body.subarray(32);
                const sequence = Buffer.alloc(4);
                sequence.writeInt32BE(seq);
                expect(signature.equals(sha256(keys.sig, sequence, ciphertext))).toBe(true);
                const decipher = createDecipheriv("aes-128-cbc", keys.key, ivFor(keys.iv, seq));
                const request = JSON.parse(
                    Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString()
                ) as Record<string, unknown>;
                device.requests.push(request);
                const cipher = createCipheriv("aes-128-cbc", keys.key, ivFor(keys.iv, seq));
                const reply = Buffer.concat([cipher.update(JSON.stringify(device.answer(request))), cipher.final()]);
                return {
                    status: 200,
                    headers: {},
                    body: Buffer.concat([Buffer.alloc(32), reply]),
                    certificate: null
                };
            }
            throw new DriverError("Nothing answered on that address and port.", "unreachable");
        }
    };
});

/** The old port: a socket that answers like a Kasa on 9999, or refuses. */
vi.mock("node:net", async (original) => {
    const actual = await original<typeof import("node:net")>();
    const { EventEmitter } = await import("node:events");
    class FakeSocket extends EventEmitter {
        setTimeout() {}
        setNoDelay() {}
        destroy() {}
        connect(_port: number, _host: string, done: () => void) {
            queueMicrotask(() => {
                if (!xorDevice) {
                    this.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
                    return;
                }
                done();
            });
        }
        write(frame: Buffer) {
            // xortransport.py: the key for each byte is the cipher byte before it.
            let key = 171;
            const plain = Buffer.alloc(frame.length - 4);
            for (let i = 4; i < frame.length; i += 1) {
                plain[i - 4] = key ^ frame[i]!;
                key = frame[i]!;
            }
            const request = JSON.parse(plain.toString()) as Record<string, unknown>;
            xorDevice!.requests.push(request);
            const reply = Buffer.from(JSON.stringify(xorDevice!.answer(request)));
            const out = Buffer.alloc(4 + reply.length);
            out.writeUInt32BE(reply.length);
            let running = 171;
            for (let i = 0; i < reply.length; i += 1) {
                running ^= reply[i]!;
                out[4 + i] = running;
            }
            queueMicrotask(() => this.emit("data", out));
        }
    }
    return { ...actual, Socket: FakeSocket };
});

const crypto = await import("@polaris-app/places/src/lib/integrations/tplink-crypto");
const { tapoLocalDriver, kasaLocalDriver } = await import("@polaris-app/places/src/lib/drivers/tplink-local");

const TAPO = { host: "192.168.1.40", email: "owner@example.test", password: "correct horse" };
const b64 = (value: string) => Buffer.from(value).toString("base64");

beforeEach(() => {
    device = null;
    xorDevice = null;
});

function tapo(answer: Device["answer"], overrides: Partial<Device> = {}): Device {
    device = { version: 2, user: TAPO.email, pass: TAPO.password, answer, requests: [], ...overrides };
    return device;
}

function methodOf(request: Record<string, unknown>): string {
    return String(request.method);
}

describe("the ciphers", () => {
    it("encrypts the old protocol exactly as python-kasa's own test expects", () => {
        // tests/protocols/test_iotprotocol.py, test_encrypt_unicode.
        const plain = "{'snowman': '☃'}";
        const expected = Buffer.from([208, 247, 132, 234, 133, 242, 159, 254, 144, 183, 141, 173, 138, 104, 240, 115, 84, 41]);
        const frame = crypto.xorEncrypt(plain);
        expect(frame.readUInt32BE(0)).toBe(18);
        expect(frame.subarray(4).equals(expected)).toBe(true);
        expect(crypto.xorDecrypt(expected)).toBe(plain);
    });

    it("round-trips a KLAP message under the session both sides derive", () => {
        const seed = randomBytes(16);
        const auth = crypto.klapAuthHash(2, "user", "pass");
        const session = new crypto.KlapSession(seed, seed, auth);
        const { body, seq } = session.encrypt('{"method":"get_device_info"}');
        // The reply is decrypted with the request's own IV; reusing the request
        // as the reply is exactly that.
        expect(session.decrypt(body, seq)).toBe('{"method":"get_device_info"}');
    });

    it("hashes the account the way each version does", () => {
        expect(crypto.klapAuthHash(1, "u", "p").equals(authHash(1, "u", "p"))).toBe(true);
        expect(crypto.klapAuthHash(2, "u", "p").equals(authHash(2, "u", "p"))).toBe(true);
    });
});

describe("a Tapo", () => {
    it("is read through the handshake and the cipher", async () => {
        tapo((request) =>
            methodOf(request) === "get_device_info"
                ? {
                      error_code: 0,
                      result: {
                          device_id: "80221AA",
                          type: "SMART.TAPOPLUG",
                          model: "P110",
                          nickname: b64("Desk lamp"),
                          fw_ver: "1.3.0 Build 230905 Rel.152200",
                          device_on: true
                      }
                  }
                : { error_code: -1002 }
        );
        const found = await tapoLocalDriver.list(TAPO);
        expect(found).toEqual([
            expect.objectContaining({
                externalId: "80221AA",
                kind: "outlet",
                name: "Desk lamp",
                model: "P110",
                firmware: "1.3.0",
                state: "on",
                online: true
            })
        ]);
    });

    it("makes a row per outlet of a strip, walking its pages", async () => {
        tapo((request) => {
            if (methodOf(request) === "get_device_info") {
                return {
                    error_code: 0,
                    result: { device_id: "STRIP", type: "SMART.TAPOPLUG", model: "P300", nickname: b64("Desk"), device_on: true }
                };
            }
            const start = (request.params as { start_index?: number } | undefined)?.start_index ?? 0;
            const all = [
                { device_id: "C1", nickname: b64("Monitor"), device_on: true },
                { device_id: "C2", nickname: b64("Printer"), device_on: false },
                { device_id: "C3", nickname: "", device_on: false }
            ];
            return { error_code: 0, result: { child_device_list: all.slice(start, start + 2), start_index: start, sum: 3 } };
        });
        const found = await tapoLocalDriver.list(TAPO);
        expect(found.map((row) => [row.externalId, row.name, row.state])).toEqual([
            ["STRIP#C1", "Monitor", "on"],
            ["STRIP#C2", "Printer", "off"],
            ["STRIP#C3", "Desk 3", "off"]
        ]);
    });

    it("switches one outlet of a strip through the strip", async () => {
        const at = tapo(() => ({ error_code: 0, result: { responseData: { error_code: 0 } } }));
        await tapoLocalDriver.act(TAPO, { externalId: "STRIP#C2", kind: "outlet" }, "turn-on");
        expect(at.requests.at(-1)).toMatchObject({
            method: "control_child",
            params: {
                device_id: "C2",
                requestData: { method: "set_device_info", params: { device_on: true } }
            }
        });
    });

    it("switches a single plug by itself", async () => {
        const at = tapo(() => ({ error_code: 0 }));
        await tapoLocalDriver.act(TAPO, { externalId: "80221AA", kind: "outlet" }, "turn-off");
        expect(at.requests.at(-1)).toMatchObject({ method: "set_device_info", params: { device_on: false } });
    });

    it("gets in on TP-Link's setup account, as a device that has been bound to one does", async () => {
        tapo(
            () => ({ error_code: 0, result: { device_id: "X", type: "SMART.TAPOBULB", nickname: b64("Hall"), device_on: false } }),
            { user: "test@tp-link.net", pass: "test" }
        );
        await expect(tapoLocalDriver.list(TAPO)).resolves.toHaveLength(1);
    });

    it("says the account is wrong when the device holds another", async () => {
        tapo(() => ({ error_code: 0 }), { pass: "a different password" });
        await expect(tapoLocalDriver.verify(TAPO)).rejects.toMatchObject({ kind: "unauthorized" });
    });

    it("says so when nothing is at the address", async () => {
        await expect(tapoLocalDriver.verify(TAPO)).rejects.toMatchObject({ kind: "unreachable" });
    });

    it("refuses a hub, which answers but has nothing to switch", async () => {
        tapo(() => ({ error_code: 0, result: { device_id: "H", type: "SMART.TAPOHUB", nickname: b64("Hub") } }));
        await expect(tapoLocalDriver.verify(TAPO)).rejects.toMatchObject({ kind: "refused" });
    });

    it("refuses an action a plug does not have", async () => {
        tapo(() => ({ error_code: 0 }));
        await expect(
            tapoLocalDriver.act(TAPO, { externalId: "80221AA", kind: "outlet" }, "unlatch")
        ).rejects.toThrow();
    });
});

describe("a Kasa", () => {
    const KASA = { host: "192.168.1.41" };
    const HS300 = {
        system: {
            get_sysinfo: {
                err_code: 0,
                deviceId: "8006AA",
                alias: "TV stand",
                model: "HS300(US)",
                mic_type: "IOT.SMARTPLUGSWITCH",
                sw_ver: "1.0.10 Build 190103 Rel.163517",
                children: [
                    { id: "8006AA00", alias: "TV", state: 1 },
                    { id: "8006AA01", alias: "Console", state: 0 }
                ]
            }
        }
    };

    it("is read on the old port with no account at all", async () => {
        xorDevice = { answer: () => HS300, requests: [] };
        const found = await kasaLocalDriver.list(KASA);
        expect(found.map((row) => [row.externalId, row.name, row.kind, row.state, row.firmware])).toEqual([
            ["8006AA#8006AA00", "TV", "outlet", "on", "1.0.10"],
            ["8006AA#8006AA01", "Console", "outlet", "off", "1.0.10"]
        ]);
        expect(xorDevice.requests[0]).toEqual({ system: { get_sysinfo: {} } });
    });

    it("switches one outlet of a strip by its id in the context", async () => {
        xorDevice = {
            answer: (request) => ("context" in request ? { system: { set_relay_state: { err_code: 0 } } } : HS300),
            requests: []
        };
        await kasaLocalDriver.act(KASA, { externalId: "8006AA#8006AA01", kind: "outlet" }, "turn-on");
        expect(xorDevice.requests.at(-1)).toEqual({
            context: { child_ids: ["8006AA01"] },
            system: { set_relay_state: { state: 1 } }
        });
    });

    it("turns a bulb off through its lighting service", async () => {
        xorDevice = {
            answer: (request) =>
                "smartlife.iot.smartbulb.lightingservice" in request
                    ? { "smartlife.iot.smartbulb.lightingservice": { transition_light_state: { err_code: 0 } } }
                    : { system: { get_sysinfo: { err_code: 0 } } },
            requests: []
        };
        await kasaLocalDriver.act(KASA, { externalId: "BULB", kind: "light" }, "turn-off");
        expect(xorDevice.requests.at(-1)).toEqual({
            "smartlife.iot.smartbulb.lightingservice": { transition_light_state: { on_off: 0 } }
        });
    });

    it("falls back to KLAP on newer firmware, with the md5 handshake and the same JSON", async () => {
        device = {
            version: 1,
            user: "owner@example.test",
            pass: "pw",
            answer: () => ({
                system: {
                    get_sysinfo: {
                        err_code: 0,
                        deviceId: "KP",
                        alias: "Kettle",
                        model: "KP115(UK)",
                        type: "IOT.SMARTPLUGSWITCH",
                        relay_state: 1
                    }
                }
            }),
            requests: []
        };
        const found = await kasaLocalDriver.list({ ...KASA, email: "owner@example.test", password: "pw" });
        expect(found).toEqual([expect.objectContaining({ externalId: "KP", name: "Kettle", state: "on" })]);
    });

    it("says so when nothing answers on either port", async () => {
        await expect(kasaLocalDriver.verify(KASA)).rejects.toMatchObject({ kind: "unreachable" });
    });
});
