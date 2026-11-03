/**
 * Tuya devices reached on the local network: the connection a command opens,
 * the key agreement 3.4 adds, and the layer that reads devices locally where
 * they are found and lets the cloud carry what is not.
 *
 * The device is a fake on the other end of a fake socket, speaking the
 * protocol module's own frames from the device side - checked against
 * tinytuya's frames in `tuya-protocol.test.ts`.
 */

import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as protocol from "@polaris-app/places/src/lib/integrations/tuya-protocol";

const heard = vi.hoisted(() => ({ list: [] as { id: string; address: string }[] }));
const probes = vi.hoisted(() => ({ count: 0, open: [] as string[] }));

vi.mock("@polaris-app/places/src/lib/integrations/tuya-lan", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("@polaris-app/places/src/lib/integrations/tuya-lan")>();
    return {
        ...actual,
        listenForTuya: async () => heard.list,
        probeTuyaPorts: async () => {
            probes.count += 1;
            return probes.open;
        }
    };
});
vi.mock("@polaris-app/places/src/lib/integrations/lan-unit", () => ({
    subnetTargets: async () => []
}));

const lan = await import("@polaris-app/places/src/lib/integrations/tuya-lan");
const local = await import("@polaris-app/places/src/lib/drivers/tuya-local");

const KEY = "0123456789abcdef";
const ID = "bf2gangsocket000001";
const ADDRESS = "192.168.1.40";

function hmacOf(key: Buffer, data: Buffer): Buffer {
    return createHmac("sha256", key).update(data).digest();
}

/** One device on the other end of a socket. */
class FakeDevice {
    dps: Record<string, unknown> = { "1": false, "2": true, "7": 0, "38": "last" };
    reachable = true;

    constructor(
        readonly version: protocol.TuyaVersion,
        readonly key = KEY
    ) {}

    socket(): never {
        const socket = new EventEmitter() as EventEmitter & {
            write(data: Buffer): boolean;
            destroy(): void;
        };
        const session = protocol.newSession(this.version, Buffer.from(this.key));
        const signed = this.version !== "3.3";
        let nonce: Buffer | null = null;
        const remote = Buffer.from("ponmlkjihgfedcba");
        let seq = 100;
        const emit = (cmd: number, body: Buffer, key?: Buffer) => {
            const out = protocol.pack55aa(seq++, cmd, Buffer.concat([Buffer.alloc(4), body]), key);
            setImmediate(() => socket.emit("data", out));
        };
        const reply = (cmd: number, body: unknown) =>
            emit(
                cmd,
                protocol.ecbEncrypt(session.key, Buffer.from(JSON.stringify(body))),
                signed ? session.key : undefined
            );
        socket.write = (data: Buffer) => {
            let frame: protocol.TuyaFrame;
            try {
                frame = protocol.parseFrame(data, {
                    key: signed ? session.key : null,
                    retcode: false
                })!.frame;
            } catch {
                // What a device does with a frame under another key: hang up.
                setImmediate(() => socket.emit("close"));
                return true;
            }
            if (frame.cmd === protocol.TUYA_CMD.SESS_KEY_NEG_START) {
                nonce = protocol.ecbDecrypt(session.localKey, frame.payload);
                const proof = Buffer.concat([remote, hmacOf(session.localKey, nonce)]);
                emit(4, protocol.ecbEncrypt(session.localKey, proof), session.localKey);
                return true;
            }
            if (frame.cmd === protocol.TUYA_CMD.SESS_KEY_NEG_FINISH) {
                session.key = protocol.sessionKeyOf("3.4", session.localKey, nonce!, remote);
                return true;
            }
            const decoded = protocol.decodePayload(session, frame);
            if (
                frame.cmd === protocol.TUYA_CMD.DP_QUERY ||
                frame.cmd === protocol.TUYA_CMD.DP_QUERY_NEW
            ) {
                reply(frame.cmd, { dps: this.dps });
            } else {
                Object.assign(this.dps, protocol.dpsOf(decoded) ?? {});
                reply(protocol.TUYA_CMD.STATUS, { dps: this.dps, t: 1 });
            }
            return true;
        };
        socket.destroy = () => undefined;
        setImmediate(() =>
            this.reachable
                ? socket.emit("connect")
                : socket.emit("error", new Error("EHOSTUNREACH"))
        );
        return socket as never;
    }
}

const target = (version: protocol.TuyaVersion) => ({
    id: ID,
    address: ADDRESS,
    version,
    localKey: KEY
});

let device: FakeDevice;
let connections = 0;
beforeEach(() => {
    device = new FakeDevice("3.3");
    connections = 0;
    lan.setTuyaConnector(() => {
        connections += 1;
        return device.socket();
    });
    local.forgetTuyaLocal();
    heard.list = [];
    probes.count = 0;
    probes.open = [];
});
afterEach(() => lan.setTuyaConnector());

const announced = () => {
    heard.list = [{ id: ID, address: ADDRESS, version: "3.3", productKey: null } as never];
};

describe("Tuya on the local network", () => {
    it("reads and sets a 3.3 device's points", async () => {
        expect(await lan.readTuyaLocal(target("3.3"))).toMatchObject({ "1": false, "2": true });
        await lan.writeTuyaLocal(target("3.3"), { "1": true });
        expect(device.dps["1"]).toBe(true);
    });

    it("agrees a session with a 3.4 device first", async () => {
        device = new FakeDevice("3.4");
        expect(await lan.readTuyaLocal(target("3.4"))).toMatchObject({ "2": true });
        await lan.writeTuyaLocal(target("3.4"), { "2": false });
        expect(device.dps["2"]).toBe(false);
    });

    it("gives up on a 3.4 device that hangs up on a key it was re-paired away from", async () => {
        device = new FakeDevice("3.4", "fedcba9876543210");
        await expect(lan.readTuyaLocal(target("3.4"))).rejects.toBeInstanceOf(lan.TuyaLanError);
    });

    it("never dials this machine", async () => {
        await expect(
            lan.readTuyaLocal({ ...target("3.3"), address: "127.0.0.1" })
        ).rejects.toMatchObject({ reason: "unreachable" });
    });
});

describe("local first, cloud when it cannot", () => {
    const cloudShape = {
        id: ID,
        name: "Salón",
        category: "kg",
        product_name: "Interruptor 2 gang con enchufe",
        online: true,
        local_key: KEY,
        status: [
            { code: "switch_1", value: true },
            { code: "switch_2", value: false },
            { code: "countdown_1", value: 0 }
        ]
    };
    const source = {
        dpMap: async () => ({ switch_1: 1, switch_2: 2, countdown_1: 7, relay_status: 38 })
    };

    it("reads through the cloud until the device is found, then from the device", async () => {
        announced();
        const first = await local.tuyaLocalRead("a", {}, [cloudShape], source, 1);
        expect(first!.reach.get(ID)).toEqual({ route: "cloud", reason: "not-found" });
        await local.settleTuyaLocal("a");
        const second = await local.tuyaLocalRead("a", {}, [cloudShape], source, 2);
        expect(second!.reach.get(ID)).toEqual({ route: "local", reason: null });
        const status = Object.fromEntries(
            second!.devices[0]!.status.map((point) => [point.code, point.value])
        );
        expect(status).toMatchObject({ switch_1: false, switch_2: true, relay_status: "last" });
    });

    it("tells a found device directly, and hands back to the cloud once it stops answering", async () => {
        announced();
        await local.tuyaLocalRead("a", {}, [cloudShape], source, 1);
        await local.settleTuyaLocal("a");
        expect(await local.tuyaLocalAct("a", {}, ID, [{ code: "switch_2", value: false }])).toBe(
            true
        );
        expect(device.dps["2"]).toBe(false);
        device.reachable = false;
        connections = 0;
        expect(await local.tuyaLocalAct("a", {}, ID, [{ code: "switch_1", value: true }])).toBe(
            false
        );
        expect(connections).toBe(1);
    });

    it("stops guessing at a device that is never on this network", async () => {
        const LOOK = 10 * 60 * 1000;
        device.reachable = false;
        probes.open = [ADDRESS];
        for (let look = 0; look < 5; look += 1) {
            await local.tuyaLocalRead("a", {}, [cloudShape], source, 1 + look * LOOK);
            await local.settleTuyaLocal("a");
        }
        expect(probes.count).toBe(3);
        announced();
        device.reachable = true;
        await local.tuyaLocalRead("a", {}, [cloudShape], source, 1 + 5 * LOOK);
        await local.settleTuyaLocal("a");
        const found = await local.tuyaLocalRead("a", {}, [cloudShape], source, 2 + 5 * LOOK);
        expect(found!.reach.get(ID)).toEqual({ route: "local", reason: null });
    });

    it("does not look again straight away for a device that stopped answering", async () => {
        announced();
        await local.tuyaLocalRead("a", {}, [cloudShape], source, 1);
        await local.settleTuyaLocal("a");
        device.reachable = false;
        heard.list = [];
        await local.tuyaLocalRead("a", {}, [cloudShape], source, 2);
        await local.settleTuyaLocal("a");
        expect(probes.count).toBe(0);
    });

    it("asks for a map once a day where it came back empty, and never for a device Places does not draw", async () => {
        const asked: string[] = [];
        const empty = {
            dpMap: async (id: string) => {
                asked.push(id);
                return {};
            }
        };
        const camera = { ...cloudShape, id: "bfcamera0000000001", category: "sp" };
        await local.tuyaLocalRead("a", {}, [cloudShape, camera], empty, 1);
        await local.tuyaLocalRead("a", {}, [cloudShape, camera], empty, 2);
        expect(asked).toEqual([ID]);
        await local.tuyaLocalRead("a", {}, [cloudShape, camera], empty, 1 + 24 * 60 * 60 * 1000);
        expect(asked).toEqual([ID, ID]);
        await local.settleTuyaLocal("a");
    });

    it("keeps reading what answers locally with the cloud unreachable", async () => {
        announced();
        await local.tuyaLocalRead("a", {}, [cloudShape], source, 1);
        await local.settleTuyaLocal("a");
        const offline = await local.tuyaLocalRead("a", {}, null, source, 2);
        expect(offline!.devices[0]!.online).toBe(true);
        expect(await local.tuyaLocalRead("other", {}, null, source, 2)).toBeNull();
    });

    it("stores the keys with the credentials and reads them back after a restart", async () => {
        await local.tuyaLocalRead("a", { uid: "u" }, [cloudShape], source, 1);
        const renewed = local.tuyaLocalRenewal("a", { uid: "u" });
        expect(renewed).toMatchObject({ uid: "u" });
        expect(JSON.parse(renewed![local.LAN_KEYS_FIELD]!)[ID].k).toBe(KEY);
        expect(local.tuyaLocalRenewal("a", renewed!)).toBeNull();
        local.forgetTuyaLocal();
        announced();
        await local.tuyaLocalRead("a", renewed!, null, source, 1);
        expect(local.tuyaLocalRenewal("a", renewed!)).toBeNull();
        await local.settleTuyaLocal("a");
    });

    it("reads data point numbers from either API's answer", () => {
        expect(local.dpMapOf({ status: [{ code: "switch_1", dp_id: 1 }], functions: [] })).toEqual({
            switch_1: 1
        });
        expect(
            local.dpMapOf({
                dpStatusRelationDTOS: [{ dpId: 38, statusCode: "relay_status", supportLocal: true }]
            })
        ).toEqual({ relay_status: 38 });
    });
});
