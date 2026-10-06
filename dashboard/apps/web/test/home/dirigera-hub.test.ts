/**
 * IKEA DIRIGERA: the PKCE pairing, the pinned certificate, and what a hub has.
 *
 * The challenge is checked against RFC 7636's own example. The pairing is checked
 * for the one property that matters most: the certificate the hub answered with
 * when it was paired is the only one every later call - the token call included -
 * will accept.
 *
 * No network. The HTTP client is replaced by a hub made of the shapes the
 * reference library's tests use.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
    trust: { pin?: string | null } | undefined;
}

const PIN = "3F2A00";

let sent: Sent[] = [];
/** How many token calls the hub answers 403 to before its button is pressed. */
let pressAfter = 0;
let devices: unknown[] = [];
let tokenValid = true;

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
            trust?: Sent["trust"];
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
                body: Buffer.from(body === undefined ? "" : JSON.stringify(body)),
                certificate: { fingerprint: PIN, commonName: "DIRIGERA HUB FOR SMART PRODUCTS" }
            });
            const path = new URL(options.url).pathname;
            if (path === "/v1/oauth/authorize") return reply(200, { code: "auth-code" });
            if (path === "/v1/oauth/token") {
                if (pressAfter > 0) {
                    pressAfter -= 1;
                    return reply(403, { error: "waiting" });
                }
                return reply(200, { access_token: "hub-token" });
            }
            if (request.headers.authorization !== "Bearer hub-token" || !tokenValid)
                return reply(401, {});
            if (path === "/v1/devices" && request.method === "GET") return reply(200, devices);
            if (path.startsWith("/v1/devices/") && request.method === "PATCH")
                return reply(202, undefined);
            return reply(404, {});
        }
    };
});

/** The event stream: what it was opened with, and the messages it carries. */
const stream = vi.hoisted(() => ({
    opened: [] as { url: string; headers?: Record<string, string>; trust?: unknown }[],
    messages: [] as string[]
}));

vi.mock("@polaris-app/places/src/lib/integrations/lan-socket", () => ({
    openLanSocket: async (options: (typeof stream.opened)[number]) => {
        stream.opened.push(options);
        return {};
    },
    eachMessage: async (_ws: unknown, onMessage: (text: string) => void) => {
        for (const message of stream.messages) onMessage(message);
    }
}));

const ikea = await import("@polaris-app/places/src/lib/integrations/dirigera-api");
const { dirigeraHubDriver } = await import("@polaris-app/places/src/lib/drivers/dirigera-hub");

const PAIRED = { host: "10.0.1.25", token: "hub-token", fingerprint: PIN };

beforeEach(() => {
    sent = [];
    pressAfter = 0;
    devices = [];
    tokenValid = true;
});

describe("PKCE", () => {
    it("derives the challenge exactly as RFC 7636's example does", () => {
        expect(ikea.codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    });

    it("makes a 128-character verifier from the reference's alphabet", () => {
        const verifier = ikea.codeVerifier();
        expect(verifier).toMatch(/^[_\-~.A-Za-z0-9]{128}$/);
        expect(ikea.codeVerifier()).not.toBe(verifier);
    });
});

describe("pairing", () => {
    it("waits for the button, then keeps the token and the certificate it was paired over", async () => {
        pressAfter = 2;
        const hub = await ikea.pairHub("10.0.1.25", { pollMs: 1 });
        expect(hub).toEqual({ host: "10.0.1.25", token: "hub-token", fingerprint: PIN });

        const authorize = sent[0]!;
        const query = new URL(authorize.url).searchParams;
        expect(new URL(authorize.url).port).toBe("8443");
        expect(query.get("audience")).toBe("homesmart.local");
        expect(query.get("code_challenge_method")).toBe("S256");
        expect(authorize.trust).toEqual({ pin: null });

        const tokens = sent.filter(
            (request) => new URL(request.url).pathname === "/v1/oauth/token"
        );
        expect(tokens).toHaveLength(3);
        const form = new URLSearchParams(tokens[0]!.body);
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("auth-code");
        // The verifier sent is the one the challenge was made from.
        expect(ikea.codeChallenge(form.get("code_verifier")!)).toBe(query.get("code_challenge"));
        // Once the certificate is recorded, nothing else is trusted - not even
        // for the call that fetches the token.
        for (const request of tokens) expect(request.trust).toEqual({ pin: PIN });
    });

    it("says the button was not pressed when the window closes", async () => {
        pressAfter = 1000;
        await expect(ikea.pairHub("10.0.1.25", { pollMs: 1, windowMs: 5 })).rejects.toMatchObject({
            kind: "refused",
            message: expect.stringContaining("action button")
        });
    });

    it("stores what pairing produced, not what was typed", async () => {
        const stored = await dirigeraHubDriver.verify({ host: "10.0.1.25" });
        expect(stored).toEqual({ host: "10.0.1.25", token: "hub-token", fingerprint: PIN });
    });
});

describe("what a hub has", () => {
    beforeEach(() => {
        devices = [
            {
                id: "light-1",
                type: "light",
                deviceType: "light",
                isReachable: true,
                attributes: {
                    customName: "Bed",
                    model: "TRADFRIbulbE27WSglobeopal1055lm",
                    manufacturer: "IKEA of Sweden",
                    firmwareVersion: "1.0.21",
                    isOn: false,
                    lightLevel: 43
                }
            },
            {
                id: "outlet-1",
                type: "outlet",
                deviceType: "outlet",
                isReachable: false,
                attributes: { customName: "Heater", model: "TRETAKT Smart plug", isOn: true }
            },
            {
                id: "door-1",
                type: "sensor",
                deviceType: "openCloseSensor",
                isReachable: true,
                attributes: {
                    customName: "Balcony door",
                    model: "PARASOLL",
                    isOpen: true,
                    batteryPercentage: 90
                }
            },
            {
                id: "air-1",
                type: "sensor",
                deviceType: "environmentSensor",
                isReachable: true,
                attributes: {
                    customName: "Bedroom",
                    model: "VINDSTYRKA",
                    currentTemperature: 21,
                    currentRH: 48
                }
            },
            {
                id: "blind-1",
                type: "blinds",
                deviceType: "blinds",
                isReachable: true,
                attributes: { customName: "Blind" }
            }
        ];
    });

    it("makes lights, outlets and readings, and leaves blinds out", async () => {
        const found = await dirigeraHubDriver.list(PAIRED);
        expect(
            found.map((row) => [
                row.externalId,
                row.kind,
                row.name,
                row.state,
                row.value ?? null,
                row.unit ?? null
            ])
        ).toEqual([
            ["light-1", "light", "Bed", "off", null, null],
            ["outlet-1", "outlet", "Heater", "unknown", null, null],
            ["door-1", "sensor", "Balcony door", "unknown", "Open", ""],
            ["air-1#temperature", "sensor", "Bedroom", "unknown", "21", "°C"],
            ["air-1#humidity", "sensor", "Bedroom", "unknown", "48", "%"]
        ]);
        expect(found[1]?.online).toBe(false);
        expect(found[2]?.batteryPercent).toBe(90);
    });

    it("switches with a list of attribute changes, over the pinned certificate", async () => {
        await dirigeraHubDriver.act(PAIRED, { externalId: "outlet-1", kind: "outlet" }, "turn-off");
        const patch = sent.at(-1)!;
        expect(patch.method).toBe("PATCH");
        expect(new URL(patch.url).pathname).toBe("/v1/devices/outlet-1");
        expect(JSON.parse(patch.body)).toEqual([{ attributes: { isOn: false } }]);
        expect(patch.trust).toEqual({ pin: PIN });
    });

    it("asks to be paired again when the hub refuses the token", async () => {
        tokenValid = false;
        await expect(dirigeraHubDriver.list(PAIRED)).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });

    it("asks to be paired again when a connection never was", async () => {
        await expect(dirigeraHubDriver.list({ host: "10.0.1.25" })).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });
});

describe("the hub's event stream", () => {
    it("is opened with the token over the pinned certificate, and names each device that changed", async () => {
        stream.opened = [];
        stream.messages = [
            JSON.stringify({
                type: "deviceStateChanged",
                data: { id: "lamp-1", attributes: { isOn: true } }
            }),
            JSON.stringify({ type: "sceneUpdated", data: { id: "scene-1" } }),
            "not json",
            JSON.stringify({ type: "deviceAdded", data: {} })
        ];
        const changed: (readonly string[])[] = [];
        await dirigeraHubDriver.listen!(
            { host: "10.0.1.25", token: "hub-token", fingerprint: PIN },
            (ids) => changed.push(ids),
            new AbortController().signal
        );
        expect(stream.opened[0]).toMatchObject({
            url: "wss://10.0.1.25:8443/v1",
            headers: { authorization: "Bearer hub-token" },
            trust: { pin: PIN }
        });
        expect(changed).toEqual([["lamp-1", "lamp-1#temperature", "lamp-1#humidity"], []]);
    });
});
