/**
 * Philips Hue: pairing, the certificate rule, and what a bridge's resources make.
 *
 * The part that must not quietly go wrong is trust. Every call to a bridge is
 * checked against Hue's own authorities and against the id recorded at pairing,
 * so these assert the rule each call was handed, not only what came back. The
 * authorities themselves are checked by fingerprint, so a pasted certificate that
 * lost a line cannot pass as Hue's.
 *
 * No network. The HTTP client is replaced by a bridge made of the shapes in the
 * CLIP v2 reference.
 */

import { X509Certificate } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Sent {
    url: string;
    method: string;
    body: string;
    headers: Record<string, string>;
    trust: { authority?: string; name?: (commonName: string) => boolean } | undefined;
}

const BRIDGE_ID = "001788fffe6a1b2c";

let sent: Sent[] = [];
let buttonPressed = false;
let keyValid = true;
let resources: Record<string, unknown[]> = {};

vi.mock("@polaris-app/places/src/lib/integrations/lan-http", async (original) => {
    const actual = await original<typeof import("@polaris-app/places/src/lib/integrations/lan-http")>();
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
                body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
                // The Bridge Pro writes its id in capitals.
                certificate: { fingerprint: "AA", commonName: BRIDGE_ID.toUpperCase() }
            });
            const path = new URL(options.url).pathname;
            if (path === "/api/config") return reply(200, { name: "Hue Bridge", bridgeid: BRIDGE_ID.toUpperCase() });
            if (path === "/api") {
                return buttonPressed
                    ? reply(200, [{ success: { username: "new-app-key", clientkey: "CK" } }])
                    : reply(200, [{ error: { type: 101, address: "", description: "link button not pressed" } }]);
            }
            if (path.startsWith("/clip/v2/resource/")) {
                if (!keyValid || !request.headers["hue-application-key"]) {
                    return reply(403, "<html><title>hue personal wireless lighting</title></html>");
                }
                const type = path.slice("/clip/v2/resource/".length);
                if (request.method === "PUT") return reply(200, { errors: [], data: [{ rid: type, rtype: "light" }] });
                return reply(200, { errors: [], data: resources[type] ?? [] });
            }
            return reply(404, "");
        }
    };
});

const hue = await import("@polaris-app/places/src/lib/integrations/hue-api");
const { hueBridgeDriver } = await import("@polaris-app/places/src/lib/drivers/hue-bridge");

const PAIRED = { host: "192.168.1.20", appKey: "stored-key", bridgeId: BRIDGE_ID };

beforeEach(() => {
    sent = [];
    buttonPressed = false;
    keyValid = true;
    resources = {};
});

describe("Hue's authorities", () => {
    it("are exactly the two certificates Hue issues bridges under", () => {
        const pems = hue.HUE_AUTHORITIES.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
        const certificates = pems.map((pem) => new X509Certificate(pem));
        expect(certificates.map((certificate) => certificate.subject)).toEqual([
            "C=NL\nO=Philips Hue\nCN=root-bridge",
            "C=NL\nO=Signify Hue\nCN=Hue Root CA 01"
        ]);
        expect(certificates.map((certificate) => certificate.fingerprint256)).toEqual([
            "F0:BD:8E:65:09:E8:2F:77:4D:63:BC:00:9D:53:88:C9:69:FE:3D:CF:7D:6D:54:1D:63:51:B7:2B:89:8D:8A:CF",
            "D8:B8:94:48:B2:AF:8E:16:76:18:5A:C0:72:19:EE:9D:CB:C8:F0:1C:12:2A:02:6A:2A:4B:7B:5C:FE:03:28:B8"
        ]);
    });

    it("are what every call is checked against, and a later call only accepts the paired bridge", async () => {
        resources = { light: [], device: [], zigbee_connectivity: [] };
        await hueBridgeDriver.list(PAIRED);
        for (const request of sent) {
            expect(request.trust?.authority).toBe(hue.HUE_AUTHORITIES);
            expect(request.trust?.name?.(BRIDGE_ID.toUpperCase())).toBe(true);
            expect(request.trust?.name?.("001788fffe000000")).toBe(false);
        }
    });
});

describe("pairing", () => {
    it("says to press the button when it has not been pressed", async () => {
        await expect(hueBridgeDriver.verify({ host: "192.168.1.20" })).rejects.toMatchObject({
            kind: "refused",
            message: expect.stringContaining("link button")
        });
    });

    it("keeps the key the bridge handed back and the id its certificate names", async () => {
        buttonPressed = true;
        resources = { light: [], device: [], zigbee_connectivity: [] };
        const stored = await hueBridgeDriver.verify({ host: "192.168.1.20" });
        expect(stored).toEqual({ host: "192.168.1.20", appKey: "new-app-key", bridgeId: BRIDGE_ID });
        const pairing = sent.find((request) => new URL(request.url).pathname === "/api")!;
        expect(pairing.method).toBe("POST");
        expect(JSON.parse(pairing.body)).toEqual({ devicetype: "polaris#places", generateclientkey: true });
    });

    it("uses a key somebody already had instead of pairing again", async () => {
        resources = { light: [], device: [], zigbee_connectivity: [] };
        const stored = await hueBridgeDriver.verify({ host: "192.168.1.20", appKey: "their-key" });
        expect(stored).toMatchObject({ appKey: "their-key" });
        expect(sent.some((request) => new URL(request.url).pathname === "/api")).toBe(false);
    });

    it("says a key the bridge refuses is the problem, from a page that is not even JSON", async () => {
        keyValid = false;
        await expect(hueBridgeDriver.verify({ host: "192.168.1.20", appKey: "revoked" })).rejects.toMatchObject({
            kind: "unauthorized"
        });
    });
});

describe("what a bridge has", () => {
    beforeEach(() => {
        resources = {
            device: [
                {
                    id: "dev-1",
                    type: "device",
                    product_data: { model_id: "LCA001", product_name: "Hue color lamp", product_archetype: "sultan_bulb", software_version: "1.104.2" },
                    metadata: { name: "Sofa lamp", archetype: "sultan_bulb" },
                    services: [{ rid: "light-1", rtype: "light" }, { rid: "zc-1", rtype: "zigbee_connectivity" }]
                },
                {
                    id: "dev-2",
                    type: "device",
                    product_data: { model_id: "LOM007", product_name: "Hue smart plug", product_archetype: "plug", software_version: "1.104.2" },
                    metadata: { name: "Christmas tree", archetype: "plug" },
                    services: [{ rid: "light-2", rtype: "light" }, { rid: "zc-2", rtype: "zigbee_connectivity" }]
                }
            ],
            light: [
                { id: "light-1", type: "light", owner: { rid: "dev-1", rtype: "device" }, metadata: { name: "Sofa lamp", archetype: "sultan_bulb" }, on: { on: true } },
                { id: "light-2", type: "light", owner: { rid: "dev-2", rtype: "device" }, metadata: { name: "Christmas tree", archetype: "plug" }, on: { on: false } }
            ],
            zigbee_connectivity: [
                { id: "zc-1", type: "zigbee_connectivity", owner: { rid: "dev-1", rtype: "device" }, status: "connected" },
                { id: "zc-2", type: "zigbee_connectivity", owner: { rid: "dev-2", rtype: "device" }, status: "connectivity_issue" }
            ]
        };
    });

    it("makes lights lights and plugs sockets, and says which are not answering", async () => {
        const found = await hueBridgeDriver.list(PAIRED);
        expect(found.map((row) => [row.externalId, row.kind, row.name, row.state, row.online, row.model])).toEqual([
            ["light-1", "light", "Sofa lamp", "on", true, "Hue color lamp"],
            ["light-2", "outlet", "Christmas tree", "unknown", false, "Hue smart plug"]
        ]);
    });

    it("switches the light service a row stands for", async () => {
        await hueBridgeDriver.act(PAIRED, { externalId: "light-2", kind: "outlet" }, "turn-on");
        const put = sent.at(-1)!;
        expect(put.method).toBe("PUT");
        expect(new URL(put.url).pathname).toBe("/clip/v2/resource/light/light-2");
        expect(put.headers["hue-application-key"]).toBe("stored-key");
        expect(JSON.parse(put.body)).toEqual({ on: { on: true } });
    });

    it("asks to be paired again when a connection has no key", async () => {
        await expect(hueBridgeDriver.list({ host: "192.168.1.20" })).rejects.toMatchObject({ kind: "unauthorized" });
    });
});
