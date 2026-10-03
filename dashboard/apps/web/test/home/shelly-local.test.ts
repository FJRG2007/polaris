/**
 * Shelly on the local network: both generations, and the digest in front of the
 * newer one.
 *
 * The digest is checked against the worked example in RFC 7616, which is the
 * scheme Shelly's documentation names; everything else is checked against a
 * device made of the example answers in Shelly's own API documentation.
 *
 * No network. The HTTP client is replaced by that device, and what is asserted is
 * what would have been sent to it.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
}

let sent: Sent[] = [];
let answer: (request: Sent) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
} = () => ({
    status: 404
});

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
        }) => {
            const request: Sent = {
                url: options.url,
                method: options.method ?? "GET",
                body: typeof options.body === "string" ? options.body : "",
                headers: options.headers ?? {}
            };
            sent.push(request);
            const reply = answer(request);
            return {
                status: reply.status,
                headers: reply.headers ?? {},
                body: Buffer.from(reply.body === undefined ? "" : JSON.stringify(reply.body)),
                certificate: null
            };
        }
    };
});

const shelly = await import("@polaris-app/places/src/lib/integrations/shelly-api");
const { shellyLocalDriver } = await import("@polaris-app/places/src/lib/drivers/shelly-local");

const HOST = { host: "10.0.1.30" };

beforeEach(() => {
    sent = [];
});

const path = (request: Sent) => new URL(request.url).pathname + new URL(request.url).search;

describe("digest authentication", () => {
    it("computes RFC 7616's own SHA-256 example", () => {
        // RFC 7616 section 3.9.1.
        expect(
            shelly.digestResponse({
                username: "Mufasa",
                password: "Circle of Life",
                realm: "http-auth@example.org",
                nonce: "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
                nc: "00000001",
                cnonce: "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
                qop: "auth",
                method: "GET",
                uri: "/dir/index.html"
            })
        ).toBe("753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1");
    });

    it("reads a challenge written the way Shelly's documentation shows it", () => {
        expect(
            shelly.digestChallenge(
                'Digest qop="auth", realm="shellypro4pm-f008d1d8b8b8", nonce="AAAAAABnabc", algorithm=SHA-256'
            )
        ).toMatchObject({
            qop: "auth",
            realm: "shellypro4pm-f008d1d8b8b8",
            nonce: "AAAAAABnabc",
            algorithm: "SHA-256"
        });
    });

    it("answers a challenge once, as admin, with the method and path it is calling", async () => {
        answer = (request) => {
            if (!request.headers.authorization) {
                return {
                    status: 401,
                    headers: {
                        "www-authenticate":
                            'Digest qop="auth", realm="shellyplus1-abc", nonce="n0nce", algorithm=SHA-256'
                    }
                };
            }
            return { status: 200, body: { was_on: false } };
        };
        await shelly.shellyRpc(
            { origin: "http://10.0.1.30", username: "admin", password: "pw" },
            "Switch.Set",
            {
                id: 0,
                on: true
            }
        );
        const header = sent[1]!.headers.authorization!;
        const field = (name: string) => new RegExp(`${name}="?([^",]+)"?`).exec(header)?.[1] ?? "";
        const h = (value: string) => createHash("sha256").update(value).digest("hex");
        const expected = h(
            `${h("admin:shellyplus1-abc:pw")}:n0nce:${field("nc")}:${field("cnonce")}:auth:${h("POST:/rpc/Switch.Set")}`
        );
        expect(field("username")).toBe("admin");
        expect(field("uri")).toBe("/rpc/Switch.Set");
        expect(field("response")).toBe(expected);
    });
});

/** A Plus 2PM in switch profile, from the shapes in Shelly's gen2 docs. */
function gen2(model = "SNSW-102P16EU", extra: Record<string, unknown> = {}) {
    answer = (request) => {
        const at = path(request);
        if (at === "/shelly")
            return {
                status: 200,
                body: {
                    id: "shellyplus2pm-a8032ab",
                    mac: "A8:03:2A:B0:00:01",
                    model,
                    gen: 2,
                    ver: "1.4.4"
                }
            };
        if (at === "/rpc/Shelly.GetStatus") {
            return {
                status: 200,
                body: {
                    "switch:0": { id: 0, output: true, apower: 12 },
                    "switch:1": { id: 1, output: false },
                    "input:0": { id: 0, state: false },
                    sys: {},
                    ...extra
                }
            };
        }
        if (at === "/rpc/Shelly.GetConfig") {
            return {
                status: 200,
                body: {
                    "switch:0": { name: "Porch" },
                    "switch:1": { name: null },
                    sys: { device: { name: "Front" } }
                }
            };
        }
        if (at.startsWith("/rpc/")) return { status: 200, body: { was_on: false } };
        return { status: 404 };
    };
}

describe("a second-generation Shelly", () => {
    it("makes a row per channel, named from its own config", async () => {
        gen2();
        const found = await shellyLocalDriver.list(HOST);
        expect(found.map((row) => [row.externalId, row.kind, row.name, row.state])).toEqual([
            ["A8032AB00001#switch:0", "switch", "Porch", "on"],
            ["A8032AB00001#switch:1", "switch", "Front 2", "off"]
        ]);
    });

    it("calls a plug's relay a socket", async () => {
        gen2("S3PL-00112EU");
        const found = await shellyLocalDriver.list(HOST);
        expect(found[0]?.kind).toBe("outlet");
    });

    it("draws a dimmer as a light and leaves a blind out", async () => {
        gen2("S3DM-0A101WWL", {
            "light:0": { id: 0, output: true, brightness: 40 },
            "cover:0": { state: "open" }
        });
        const found = await shellyLocalDriver.list(HOST);
        expect(found.map((row) => [row.externalId, row.kind])).toContainEqual([
            "A8032AB00001#light:0",
            "light"
        ]);
        expect(found.some((row) => row.externalId.includes("cover"))).toBe(false);
    });

    it("switches the channel a row stands for", async () => {
        gen2();
        await shellyLocalDriver.act(
            HOST,
            { externalId: "A8032AB00001#switch:1", kind: "switch" },
            "turn-on"
        );
        const call = sent.at(-1)!;
        expect(path(call)).toBe("/rpc/Switch.Set");
        expect(call.method).toBe("POST");
        expect(JSON.parse(call.body)).toEqual({ id: 1, on: true });
    });

    it("turns a light channel off with Light.Set", async () => {
        gen2();
        await shellyLocalDriver.act(
            HOST,
            { externalId: "A8032AB00001#light:0", kind: "light" },
            "turn-off"
        );
        expect(path(sent.at(-1)!)).toBe("/rpc/Light.Set");
        expect(JSON.parse(sent.at(-1)!.body)).toEqual({ id: 0, on: false });
    });

    it("asks for the password when the device has one and none was given", async () => {
        answer = (request) =>
            path(request) === "/shelly"
                ? { status: 200, body: { id: "x", mac: "AA", gen: 2 } }
                : {
                      status: 401,
                      headers: { "www-authenticate": 'Digest realm="x", nonce="n", qop="auth"' }
                  };
        await expect(shellyLocalDriver.verify(HOST)).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });

    it("says the password is wrong when the answer to the challenge is refused too", async () => {
        answer = (request) =>
            path(request) === "/shelly"
                ? { status: 200, body: { id: "x", mac: "AA", gen: 2 } }
                : {
                      status: 401,
                      headers: { "www-authenticate": 'Digest realm="x", nonce="n", qop="auth"' }
                  };
        await expect(
            shellyLocalDriver.verify({ ...HOST, password: "wrong" })
        ).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });
});

describe("a first-generation Shelly", () => {
    function gen1(
        type: string,
        settings: Record<string, unknown>,
        status: Record<string, unknown>
    ) {
        answer = (request) => {
            const at = path(request);
            if (at === "/shelly")
                return {
                    status: 200,
                    body: { type, mac: "5ECF7F1632E8", auth: false, fw: "20230913-112003/v1.14.0" }
                };
            if (at === "/settings") return { status: 200, body: settings };
            if (at === "/status") return { status: 200, body: status };
            return { status: 200, body: { ison: true } };
        };
    }

    it("reads a plug's relay as a socket", async () => {
        gen1("SHPLG-S", { name: "Heater", relays: [{ name: null }] }, { relays: [{ ison: true }] });
        const found = await shellyLocalDriver.list(HOST);
        expect(found).toEqual([
            expect.objectContaining({
                externalId: "5ECF7F1632E8#relay/0",
                kind: "outlet",
                name: "Heater",
                state: "on"
            })
        ]);
    });

    it("skips a Shelly 2.5 in roller mode", async () => {
        gen1(
            "SHSW-25",
            { mode: "roller", relays: [{}, {}] },
            { relays: [{ ison: false }, { ison: false }], rollers: [{}] }
        );
        await expect(shellyLocalDriver.verify(HOST)).rejects.toMatchObject({ kind: "refused" });
    });

    it("switches a relay with its own path, behind basic auth", async () => {
        gen1("SHSW-1", { relays: [{}] }, { relays: [{ ison: false }] });
        await shellyLocalDriver.act(
            { ...HOST, password: "pw", username: "boss" },
            { externalId: "5ECF7F1632E8#relay/0", kind: "switch" },
            "turn-on"
        );
        const call = sent.at(-1)!;
        expect(path(call)).toBe("/relay/0?turn=on");
        expect(call.headers.authorization).toBe(
            `Basic ${Buffer.from("boss:pw").toString("base64")}`
        );
    });

    it("turns a dimmer off on its light path", async () => {
        gen1(
            "SHDM-2",
            { lights: [{ name: "Lounge" }] },
            { lights: [{ ison: true, brightness: 50 }] }
        );
        const found = await shellyLocalDriver.list(HOST);
        expect(found[0]).toMatchObject({
            externalId: "5ECF7F1632E8#light/0",
            kind: "light",
            name: "Lounge"
        });
        await shellyLocalDriver.act(
            HOST,
            { externalId: "5ECF7F1632E8#light/0", kind: "light" },
            "turn-off"
        );
        expect(path(sent.at(-1)!)).toBe("/light/0?turn=off");
    });
});

describe("an address", () => {
    it("that is not a Shelly is refused before anything is connected", async () => {
        answer = () => ({ status: 200, body: { hello: "router" } });
        await expect(shellyLocalDriver.verify(HOST)).rejects.toMatchObject({ kind: "refused" });
    });

    it("with a path in it is refused rather than trimmed", async () => {
        await expect(shellyLocalDriver.verify({ host: "10.0.1.30/admin" })).rejects.toThrow();
    });
});
