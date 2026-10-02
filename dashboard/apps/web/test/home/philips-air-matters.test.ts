/**
 * Philips' fan and heater cloud ("air-matters"): the signed sign-in, the device
 * list, the single-use broker address, the device shadow and what its codes
 * mean - with Philips' HTTP and the AWS broker both played by the test.
 *
 * The shapes are the ones Yooork/HA_Philips_Air_Plus documents and was verified
 * against (`airmatters_auth.py`, `notes/properties.md` - a real CX3550/01
 * shadow, ids replaced), and the signature is pinned to the value that
 * project's own `_signature` gives for the same inputs, computed with its
 * Python. Nothing here reaches Philips or AWS.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- a fake broker ----------------------------------------------------------------

class FakeClient extends EventEmitter {
    connected = false;
    published: { topic: string; payload: string; qos: number; retain: boolean }[] = [];
    subscribed: string[] = [];
    constructor(readonly options: Record<string, unknown>) {
        super();
    }
    subscribe(
        topics: string[],
        _options: unknown,
        callback: (error: Error | null, granted: { topic: string; qos: number }[]) => void
    ) {
        this.subscribed.push(...topics);
        setImmediate(() =>
            callback(
                null,
                topics.map((topic) => ({ topic, qos: 1 }))
            )
        );
    }
    publish(
        topic: string,
        payload: string,
        options: { qos: number; retain: boolean },
        callback: (error?: Error) => void
    ) {
        this.published.push({ topic, payload, qos: options.qos, retain: options.retain });
        setImmediate(() => {
            callback();
            shadow.answer?.(this, topic, payload);
        });
    }
    end() {
        this.connected = false;
    }
}

const shadow: {
    clients: FakeClient[];
    answer: ((client: FakeClient, topic: string, payload: string) => void) | null;
} = { clients: [], answer: null };

vi.mock("mqtt", () => ({
    default: {
        connect: (options: Record<string, unknown>) => {
            const client = new FakeClient(options);
            shadow.clients.push(client);
            setImmediate(() => {
                client.connected = true;
                client.emit("connect");
            });
            return client;
        }
    }
}));

const air = await import("@polaris-app/places/src/lib/integrations/air-matters");
const linkModule = await import("@polaris-app/places/src/lib/integrations/air-matters-link");
const mapping = await import("@polaris-app/places/src/lib/drivers/philips-air-matters");
const driverModule = await import("@polaris-app/places/src/lib/drivers/philips-cloud");

/** A CX3550/01's reported state as the source captured it (`properties.md`). */
const CX3550_REPORTED = {
    ConnectType: "Online",
    DeviceId: "00000000000000000000000000000001",
    StatusType: "status",
    D01S03: "Fan1",
    D01S04: "Trident",
    D01S05: "CX3550/01",
    D01S12: "0.1.7",
    ProductId: "b3d240e5b11711ee88c206d016384e4a",
    Runtime: 161799392,
    rssi: -67,
    free_memory: 95536,
    D03102: 1,
    D03105: 0,
    D0310A: 1,
    D0310C: 2,
    D0310D: 2,
    D0320F: 23040,
    D03110: 0,
    D03211: 0,
    D03130: 0,
    D0313B: 20
};

const SECRET = `a_${"c0ffee00".repeat(4)}`;
const USER = "0123456789abcdef0123456789abcdef";

let calls: { url: URL; init: RequestInit }[] = [];
let replies: ((url: URL, init: RequestInit) => Response | null)[] = [];

function envelope(code: number, data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ meta: { code, message: "" }, data }), { status });
}

/** A JWT with this `exp`, signed by nobody. */
function jwt(exp: number): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${part({ alg: "HS256" })}.${part({ exp, identification: `PHILIPS:${USER}` })}.sig`;
}

beforeEach(() => {
    vi.useRealTimers();
    calls = [];
    replies = [];
    shadow.clients = [];
    shadow.answer = null;
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        for (const reply of replies) {
            const answer = reply(url, init);
            if (answer) return answer;
        }
        throw new TypeError("fetch failed");
    });
});

afterEach(() => {
    linkModule.resetShadowLinks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("the signed sign-in", () => {
    it("encodes the username the way Java's URLEncoder does", () => {
        expect(air.javaUrlEncode("PHILIPS:ab cd@x*")).toBe("PHILIPS%3Aab+cd%40x*");
        expect(air.javaUrlEncode("a.b-c_d*e")).toBe("a.b-c_d*e");
    });

    it("signs exactly as the source does", () => {
        // `_signature("1700000000", "PHILIPS:<user>", "a_c0ffee00...")` in
        // airmatters_auth.py.
        expect(air.airMattersSignature("1700000000", `PHILIPS:${USER}`, SECRET)).toBe(
            "4e149de4e0e5cfa5f9c451dd3e963a2f31f2b5efe190767d590809e8f88ee9b5"
        );
    });

    it("asks for a token with the signature, and reads its end from the token", async () => {
        const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        replies.push((url) =>
            url.pathname === "/enduser/v2/getToken/" ? envelope(0, { token: jwt(exp) }) : null
        );
        const token = await air.airMattersToken(USER, SECRET, () => 1_700_000_000_000);
        expect(token.expiresAt).toBe(exp * 1000);
        const sent = calls[0]!;
        expect(sent.url.href).toBe("https://www.api.air.philips.com/enduser/v2/getToken/");
        expect(sent.init.method).toBe("POST");
        const headers = new Headers(sent.init.headers);
        expect(headers.get("signature")).toBe(
            "4e149de4e0e5cfa5f9c451dd3e963a2f31f2b5efe190767d590809e8f88ee9b5"
        );
        expect(headers.get("user-agent")).toBe("okhttp/4.9.3");
        expect(JSON.parse(String(sent.init.body))).toEqual({
            timestamp: "1700000000",
            username: `PHILIPS:${USER}`,
            app_id: "9fd505fa9c7111e9a1e3061302926720"
        });
    });

    it("says a refused signature is the app file, not an outage", async () => {
        replies.push(() => envelope(10001, null));
        await expect(air.airMattersToken(USER, SECRET)).rejects.toMatchObject({
            kind: "unauthorized",
            message:
                "Philips' fan and heater cloud refused the sign-in. Upload the Philips Air+ app again."
        });
    });

    it("asks again through the load balancer's 503", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
        let first = true;
        replies.push(() => {
            if (first) {
                first = false;
                return new Response("Service Unavailable", { status: 503 });
            }
            return envelope(0, { token: jwt(Math.floor(Date.now() / 1000) + 3600 * 200) });
        });
        const token = await air.airMattersToken(USER, SECRET);
        expect(token.token).toContain(".");
        expect(calls).toHaveLength(2);
    });

    it("renews a token a day before it ends", () => {
        const now = Date.now();
        expect(air.airMattersNeedsToken(undefined, now)).toBe(true);
        expect(air.airMattersNeedsToken({ token: "t", expiresAt: now + 2 * 86_400_000 }, now)).toBe(
            false
        );
        expect(air.airMattersNeedsToken({ token: "t", expiresAt: now + 3_600_000 }, now)).toBe(
            true
        );
    });
});

describe("the device list", () => {
    it("keeps the id, name, model and type of each, and nothing else", async () => {
        replies.push((url, init) => {
            if (url.pathname !== "/enduser/deviceList/") return null;
            expect(new Headers(init.headers).get("authorization")).toBe("jwt token-1");
            return envelope(0, [
                {
                    device_id: "00000000000000000000000000000001",
                    device_info: {
                        name: "Fan1",
                        modelid: "CX3550/01",
                        type: "Trident",
                        mac: "000000000000",
                        swversion: "0.1.7",
                        product_id: "b3d240e5b11711ee88c206d016384e4a",
                        is_online: true
                    }
                },
                { device_id: "../../etc", device_info: { name: "bad" } },
                { device_info: { name: "no id" } },
                {
                    device_id: "00000000000000000000000000000002",
                    device_info: { name: null, modelid: 3360, type: "LavenderLite" }
                }
            ]);
        });
        expect(await air.listAirMattersDevices("token-1")).toEqual([
            {
                id: "00000000000000000000000000000001",
                name: "Fan1",
                model: "CX3550/01",
                type: "Trident"
            },
            {
                id: "00000000000000000000000000000002",
                name: "",
                model: "3360",
                type: "LavenderLite"
            }
        ]);
    });
});

describe("the broker address", () => {
    it("takes the broker from endpoint and the signed path as it came", () => {
        expect(
            air.airMattersTarget({
                device_id: "d1",
                endpoint: "a2gv4wmvb0sdt5-ats.iot.eu-central-1.amazonaws.com",
                host: "wss://a2gv4wmvb0sdt5-ats.iot.eu-central-1.amazonaws.com/mqtt?X-Amz-Signature=abc",
                path: "/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=A%2F20260627&X-Amz-Signature=abc",
                client_id: "b16b2dff"
            })
        ).toEqual({
            hostname: "a2gv4wmvb0sdt5-ats.iot.eu-central-1.amazonaws.com",
            path: "/mqtt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=A%2F20260627&X-Amz-Signature=abc",
            clientId: "b16b2dff"
        });
    });

    it("reads the broker out of a whole host address where there is no endpoint", () => {
        expect(
            air.airMattersTarget({
                host: "wss://x-ats.iot.eu-central-1.amazonaws.com/mqtt?a=1",
                path: "/mqtt?a=1",
                client_id: "c"
            })?.hostname
        ).toBe("x-ats.iot.eu-central-1.amazonaws.com");
    });

    it("refuses anything that is not an AWS IoT broker", () => {
        for (const endpoint of ["evil.example.com", "127.0.0.1", "amazonaws.com.evil.example"]) {
            expect(air.airMattersTarget({ endpoint, path: "/mqtt", client_id: "c" })).toBeNull();
        }
        expect(
            air.airMattersTarget({ endpoint: "x.iot.eu-central-1.amazonaws.com", path: "/mqtt" })
        ).toBeNull();
    });

    it("asks again while the backend says the device is not bound yet", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
        let first = true;
        replies.push((url, init) => {
            if (url.pathname !== "/enduser/v2/mqttInfo/") return null;
            expect(JSON.parse(String(init.body))).toEqual({ device_id: ["d1"] });
            if (first) {
                first = false;
                return envelope(16002, null);
            }
            return envelope(0, {
                mqttinfos: [
                    {
                        device_id: "d1",
                        endpoint: "x-ats.iot.eu-central-1.amazonaws.com",
                        path: "/mqtt?sig=1",
                        client_id: "client-1"
                    }
                ]
            });
        });
        expect(await air.airMattersMqttTarget("token-1", "d1")).toEqual({
            hostname: "x-ats.iot.eu-central-1.amazonaws.com",
            path: "/mqtt?sig=1",
            clientId: "client-1"
        });
    });
});

describe("the device shadow", () => {
    const target = vi.fn(async () => ({
        hostname: "x-ats.iot.eu-central-1.amazonaws.com",
        path: "/mqtt?sig=1",
        clientId: "client-1"
    }));

    beforeEach(() => {
        target.mockClear();
        shadow.answer = (client, topic, payload) => {
            if (topic.endsWith("/shadow/get")) {
                client.emit(
                    "message",
                    "$aws/things/d1/shadow/get/accepted",
                    Buffer.from(JSON.stringify({ state: { reported: CX3550_REPORTED } }))
                );
            }
            if (topic.endsWith("/shadow/update")) {
                const desired = JSON.parse(payload).state.desired as Record<string, unknown>;
                client.emit(
                    "message",
                    "$aws/things/d1/shadow/update/documents",
                    Buffer.from(
                        JSON.stringify({
                            current: { state: { reported: { ...CX3550_REPORTED, ...desired } } }
                        })
                    )
                );
            }
        };
    });

    it("connects to the signed address with its own client id, and reads the reported state", async () => {
        const link = linkModule.shadowLink("owner@example.com", "d1");
        const read = await link.read(target);
        expect(read.answered).toBe(true);
        expect(read.reported.D01S05).toBe("CX3550/01");
        const client = shadow.clients[0]!;
        expect(client.options).toMatchObject({
            protocol: "wss",
            hostname: "x-ats.iot.eu-central-1.amazonaws.com",
            port: 443,
            path: "/mqtt?sig=1",
            clientId: "client-1",
            protocolVersion: 4,
            reconnectPeriod: 0
        });
        expect(client.subscribed).toEqual([
            "$aws/things/d1/shadow/get/accepted",
            "$aws/things/d1/shadow/update/accepted",
            "$aws/things/d1/shadow/update/documents"
        ]);
    });

    it("writes a desired patch, never retained, and reads the new state", async () => {
        const link = linkModule.shadowLink("owner@example.com", "d1");
        await link.desire(target, { D03102: 0 });
        const update = shadow.clients[0]!.published.find((entry) =>
            entry.topic.endsWith("/shadow/update")
        )!;
        expect(JSON.parse(update.payload)).toEqual({ state: { desired: { D03102: 0 } } });
        expect(update.retain).toBe(false);
        expect(update.qos).toBe(1);
        expect(link.reported.D03102).toBe(0);
    });

    it("asks for a fresh address after the socket closes, since each is good once", async () => {
        const link = linkModule.shadowLink("owner@example.com", "d1");
        await link.read(target);
        shadow.clients[0]!.emit("close");
        // The backoff after a drop is a second.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await link.read(target);
        expect(target).toHaveBeenCalledTimes(2);
        expect(shadow.clients).toHaveLength(2);
    });

    it("merges what the device pushes by itself", () => {
        expect(
            linkModule.shadowReported(
                "$aws/things/d1/shadow/update/accepted",
                JSON.stringify({ state: { desired: null, reported: { D0310C: 3 } } })
            )
        ).toEqual({ reported: { D0310C: 3 }, whole: false });
    });
});

describe("what a fan or purifier on this cloud is", () => {
    const fan = { id: "d1", name: "", model: "CX3550/01", type: "Trident" };

    it("reads a CX3550 as an air device: on, manual speed 2, swinging", () => {
        const snapshot = mapping.airMattersSnapshot(fan, {
            reported: CX3550_REPORTED,
            answered: true
        });
        expect(snapshot).toMatchObject({
            externalId: "am:d1",
            kind: "air",
            name: "Fan1",
            model: "CX3550/01",
            firmware: "0.1.7",
            state: "on",
            online: true
        });
        expect(snapshot.air).toMatchObject({
            mode: null,
            modes: ["sleep", "natural"],
            speed: "speed_2",
            speeds: ["speed_1", "speed_2", "speed_3"],
            options: { oscillate: true },
            readings: {}
        });
    });

    it("reads natural wind sent back as a signed byte", () => {
        const snapshot = mapping.airMattersSnapshot(fan, {
            reported: { ...CX3550_REPORTED, D0310C: -126, D0320F: 0 },
            answered: true
        });
        expect(snapshot.air?.mode).toBe("natural");
        expect(snapshot.air?.options.oscillate).toBe(false);
    });

    it("takes online from the device's own word, not from the broker answering", () => {
        const snapshot = mapping.airMattersSnapshot(fan, {
            reported: { ...CX3550_REPORTED, ConnectType: "Offline" },
            answered: true
        });
        expect(snapshot.online).toBe(false);
    });

    it("writes a manual speed as the level and the mode, turning it on", () => {
        const model = mapping.airMattersModel(fan);
        expect(
            mapping.airMattersDesired(model, "set-fan", { action: "set-fan", speed: "speed_3" })
        ).toEqual({ D03102: 1, D0310D: 3, D0310C: 3 });
        expect(
            mapping.airMattersDesired(model, "set-mode", { action: "set-mode", mode: "natural" })
        ).toEqual({ D03102: 1, D0310C: 130 });
        expect(
            mapping.airMattersDesired(model, "set-option", {
                action: "set-option",
                option: "oscillate",
                on: true
            })
        ).toEqual({ D0320F: 90 });
        expect(mapping.airMattersDesired(model, "turn-off", undefined)).toEqual({ D03102: 0 });
    });

    it("reads an AC3360 by its type, with its modes, switches and readings", () => {
        const purifier = { id: "d2", name: "Living", model: null, type: "LavenderLite" };
        const snapshot = mapping.airMattersSnapshot(purifier, {
            reported: {
                ConnectType: "Online",
                D03102: 1,
                D0310C: 49,
                D03103: 1,
                D03105: 115,
                D03221: 7,
                D03120: 2,
                D03224: 215,
                D03125: 44
            },
            answered: true
        });
        expect(snapshot.air).toMatchObject({
            mode: "pet_hair",
            options: { childLock: true, light: true },
            readings: { pm25: 7, allergen: 2, temperature: 21.5, humidity: 44 }
        });
        expect(snapshot.value).toBe("7");
        const model = mapping.airMattersModel(purifier);
        expect(
            mapping.airMattersDesired(model, "set-option", {
                action: "set-option",
                option: "light",
                on: true
            })
        ).toEqual({ D03105: 123 });
    });

    it("lists a model nobody verified, and drives none of it", () => {
        const heater = { id: "d3", name: "Heater", model: "CX5120/11", type: "Sirius" };
        const snapshot = mapping.airMattersSnapshot(heater, {
            reported: { ConnectType: "Online", D03102: 0 },
            answered: true
        });
        expect(snapshot.state).toBe("off");
        expect(snapshot.air?.modes).toEqual([]);
        expect(() =>
            mapping.airMattersDesired(mapping.airMattersModel(heater), "turn-on", undefined)
        ).toThrow("That device cannot be told to do that");
        expect(mapping.unsupportedAirMatters([fan, heater])).toEqual(["CX5120/11"]);
    });
});

describe("the driver, for a connection on this cloud alone", () => {
    const credentials = {
        email: "owner@example.com",
        source: "none",
        airMattersUser: USER,
        airMattersSecret: SECRET
    };

    beforeEach(() => {
        const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        replies.push((url) => {
            if (url.hostname !== "www.api.air.philips.com") return null;
            if (url.pathname === "/enduser/v2/getToken/") return envelope(0, { token: jwt(exp) });
            if (url.pathname === "/enduser/deviceList/")
                return envelope(0, [
                    {
                        device_id: "d1",
                        device_info: { name: "Fan1", modelid: "CX3550/01", type: "Trident" }
                    }
                ]);
            if (url.pathname === "/enduser/v2/mqttInfo/")
                return envelope(0, {
                    mqttinfos: [
                        {
                            device_id: "d1",
                            endpoint: "x-ats.iot.eu-central-1.amazonaws.com",
                            path: "/mqtt?sig=1",
                            client_id: "client-1"
                        }
                    ]
                });
            return null;
        });
        shadow.answer = (client, topic, payload) => {
            const thing = topic.split("/")[2];
            if (topic.endsWith("/shadow/get"))
                client.emit(
                    "message",
                    `$aws/things/${thing}/shadow/get/accepted`,
                    Buffer.from(JSON.stringify({ state: { reported: CX3550_REPORTED } }))
                );
            if (topic.endsWith("/shadow/update")) {
                const desired = JSON.parse(payload).state.desired as Record<string, unknown>;
                client.emit(
                    "message",
                    `$aws/things/${thing}/shadow/update/documents`,
                    Buffer.from(
                        JSON.stringify({
                            current: { state: { reported: { ...CX3550_REPORTED, ...desired } } }
                        })
                    )
                );
            }
        };
    });

    afterEach(async () => {
        await driverModule.philipsCloudDriver.forget!(credentials);
    });

    it("lists the fan, reads nothing from Versuni, and renews nothing there", async () => {
        const [snapshot, ...rest] = await driverModule.philipsCloudDriver.list(credentials);
        expect(rest).toEqual([]);
        expect(snapshot).toMatchObject({ externalId: "am:d1", kind: "air", state: "on" });
        expect(calls.every((call) => call.url.hostname === "www.api.air.philips.com")).toBe(true);
        expect(await driverModule.philipsCloudDriver.renew!(credentials)).toBeNull();
    });

    it("asks for one token for the week, not one per read", async () => {
        await driverModule.philipsCloudDriver.list(credentials);
        await driverModule.philipsCloudDriver.list(credentials);
        expect(calls.filter((call) => call.url.pathname === "/enduser/v2/getToken/")).toHaveLength(
            1
        );
    });

    it("keeps the listed fan, as last heard, through an outage of this cloud", async () => {
        await driverModule.philipsCloudDriver.list(credentials);
        replies.unshift((url) =>
            url.pathname === "/enduser/deviceList/" ? envelope(500, null, 500) : null
        );
        const [snapshot, ...rest] = await driverModule.philipsCloudDriver.list(credentials);
        expect(rest).toEqual([]);
        expect(snapshot).toMatchObject({ externalId: "am:d1", kind: "air", state: "on" });
    });

    it("fails a sync through an outage before anything was listed", async () => {
        replies.unshift((url) =>
            url.pathname === "/enduser/deviceList/" ? envelope(500, null, 500) : null
        );
        await expect(driverModule.philipsCloudDriver.list(credentials)).rejects.toMatchObject({
            kind: "unreachable"
        });
    });

    it("fails a sync whose sign-in is refused, whatever was listed before", async () => {
        await driverModule.philipsCloudDriver.list(credentials);
        replies.unshift((url) =>
            url.pathname === "/enduser/deviceList/" ? envelope(401, null, 401) : null
        );
        await expect(driverModule.philipsCloudDriver.list(credentials)).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });

    it("sets a speed through the shadow", async () => {
        await driverModule.philipsCloudDriver.list(credentials);
        await driverModule.philipsCloudDriver.act(
            credentials,
            { externalId: "am:d1", kind: "air" },
            "set-fan",
            { action: "set-fan", speed: "speed_1" }
        );
        const update = shadow.clients
            .flatMap((client) => client.published)
            .find((entry) => entry.topic === "$aws/things/d1/shadow/update")!;
        expect(JSON.parse(update.payload)).toEqual({
            state: { desired: { D03102: 1, D0310D: 1, D0310C: 1 } }
        });
    });

    it("refuses a device that is not on the account", async () => {
        await expect(
            driverModule.philipsCloudDriver.act(
                credentials,
                { externalId: "am:nope", kind: "air" },
                "turn-on"
            )
        ).rejects.toThrow("That device is not on this Philips account.");
    });
});
