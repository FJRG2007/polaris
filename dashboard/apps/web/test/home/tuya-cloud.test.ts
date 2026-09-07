/**
 * Tuya: the signature, and what their taxonomy means here.
 *
 * Two things about this integration fail silently rather than loudly. The
 * signature is an HMAC over the method, a hash of the body, and the path with its
 * query sorted, prefixed with the key, the token, the timestamp and the nonce -
 * and every one of those being in the wrong order answers "sign invalid" with no
 * hint as to which. The formula is checked here against the one their
 * documentation states, so a refactor cannot quietly change it.
 *
 * The other is that a switch is a data point, not a device: a three-gang wall
 * switch is one device with three switches on it. Getting that wrong does not
 * error - it silently makes two thirds of somebody's switches unreachable.
 *
 * No network. `fetch` is replaced, and what is asserted is what would have been
 * sent.
 */

import { createHash, createHmac } from "node:crypto";
import { tuyaCloudDriver } from "@/lib/home/drivers/tuya-cloud";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCESS_SECRET = "secret-secret-secret";
const TOKEN = "token-from-tuya";

/**
 * Fresh keys for every test.
 *
 * A token is held for as long as it lasts, keyed by the account it was fetched
 * for - which is the behaviour one of these tests exists to check, and which
 * would otherwise leak between all of them: the second test in the file would
 * never see a token call, and would be reading the wrong request.
 */
let account = 0;
function credentials(region = "eu") {
    account += 1;
    return { accessId: `access-id-${account}`, accessSecret: ACCESS_SECRET, region };
}

interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

let sent: Sent[] = [];
let devices: unknown[] = [];

function answer(result: unknown): Response {
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
}

beforeEach(() => {
    sent = [];
    devices = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({
            url: String(url),
            method: String(init.method),
            headers: init.headers as Record<string, string>,
            body: typeof init.body === "string" ? init.body : ""
        });
        if (String(url).includes("/v1.0/token")) {
            return answer({ access_token: TOKEN, expire_time: 7200, uid: "uid-1" });
        }
        if (String(url).includes("/commands")) return answer(true);
        return answer({ devices, has_more: false });
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The signature exactly as Tuya document it, rebuilt from what was actually
 *  sent. A test that recomputed it from the implementation would prove nothing;
 *  this one fails the moment the implementation stops matching the spec. */
function expectedSign(request: Sent, accessId: string, accessToken: string): string {
    const path = new URL(request.url).pathname + new URL(request.url).search;
    const contentSha = createHash("sha256").update(request.body).digest("hex");
    const stringToSign = `${request.method}\n${contentSha}\n\n${path}`;
    const payload = `${accessId}${accessToken}${request.headers.t}${request.headers.nonce}${stringToSign}`;
    return createHmac("sha256", ACCESS_SECRET).update(payload).digest("hex").toUpperCase();
}

/** The one call that fetched a token, and the one that used it. Found by what
 *  they are rather than by the order they happen to be in. */
function tokenCall(): Sent {
    return sent.find((request) => request.url.includes("/v1.0/token"))!;
}
function businessCall(): Sent {
    return sent.find((request) => !request.url.includes("/v1.0/token"))!;
}

describe("what Tuya is sent", () => {
    it("signs the token call without a token, as their documentation says", async () => {
        const keys = credentials();
        await tuyaCloudDriver.list(keys);
        const token = tokenCall();
        expect(token.url).toContain("/v1.0/token?grant_type=1");
        expect(token.headers.access_token).toBeUndefined();
        expect(token.headers.sign).toBe(expectedSign(token, keys.accessId, ""));
    });

    it("signs every other call with the token in the string, not only the header", async () => {
        const keys = credentials();
        await tuyaCloudDriver.list(keys);
        const list = businessCall();
        expect(list.headers.access_token).toBe(TOKEN);
        expect(list.headers.sign).toBe(expectedSign(list, keys.accessId, TOKEN));
    });

    it("goes to the data centre the project was made in", async () => {
        await tuyaCloudDriver.list(credentials("us"));
        expect(sent[0]?.url.startsWith("https://openapi.tuyaus.com")).toBe(true);
    });

    it("falls back to one data centre rather than to no host at all", async () => {
        await tuyaCloudDriver.list(credentials("nowhere"));
        expect(sent[0]?.url.startsWith("https://openapi.tuyaeu.com")).toBe(true);
    });

    it("asks for one token and keeps it, rather than one per call", async () => {
        const keys = credentials();
        await tuyaCloudDriver.list(keys);
        const before = sent.filter((request) => request.url.includes("/v1.0/token")).length;
        await tuyaCloudDriver.list(keys);
        const after = sent.filter((request) => request.url.includes("/v1.0/token")).length;
        expect(before).toBe(1);
        expect(after).toBe(1);
    });

    it("sends the data point a row stands for, not the device", async () => {
        await tuyaCloudDriver.act(
            credentials(),
            { externalId: "vdev-9#switch_2", kind: "switch" },
            "turn-on"
        );
        const command = sent.find((request) => request.url.includes("/commands"))!;
        expect(command.url).toContain("/v1.0/devices/vdev-9/commands");
        expect(JSON.parse(command.body)).toEqual({ commands: [{ code: "switch_2", value: true }] });
    });

    it("refuses an action a plug does not have rather than sending something odd", async () => {
        await expect(
            tuyaCloudDriver.act(
                credentials(),
                { externalId: "vdev-9#switch", kind: "switch" },
                "unlatch"
            )
        ).rejects.toThrow();
    });
});

describe("what comes back", () => {
    it("makes a row per gang of a multi-gang switch", async () => {
        // One device, three switches on it. Two thirds of somebody's wall switch
        // is unreachable if this is read as one row.
        devices = [
            {
                id: "vdev-1",
                name: "Hallway",
                category: "kg",
                product_name: "3 Gang Switch",
                online: true,
                status: [
                    { code: "switch_1", value: true },
                    { code: "switch_2", value: false },
                    { code: "switch_3", value: false }
                ]
            }
        ];
        const found = await tuyaCloudDriver.list(credentials());
        expect(found.map((device) => device.externalId)).toEqual([
            "vdev-1#switch_1",
            "vdev-1#switch_2",
            "vdev-1#switch_3"
        ]);
        expect(found.map((device) => device.name)).toEqual(["Hallway 1", "Hallway 2", "Hallway 3"]);
        expect(found.map((device) => device.state)).toEqual(["on", "off", "off"]);
    });

    it("leaves a single switch under its own name", async () => {
        devices = [
            {
                id: "vdev-2",
                name: "Desk lamp",
                category: "dj",
                online: true,
                status: [
                    { code: "switch_led", value: true },
                    { code: "bright_value", value: 40 }
                ]
            }
        ];
        const found = await tuyaCloudDriver.list(credentials());
        expect(found).toHaveLength(1);
        expect(found[0]?.name).toBe("Desk lamp");
        expect(found[0]?.kind).toBe("light");
    });

    it("leaves out what it could only pretend to control", async () => {
        // A curtain motor is a real device on the same account. Listing it with an
        // "On" would be a button that does something other than what it says.
        devices = [
            { id: "vdev-3", name: "Curtains", category: "cl", online: true, status: [] },
            {
                id: "vdev-4",
                name: "Socket",
                category: "cz",
                online: true,
                status: [{ code: "switch_1", value: false }]
            }
        ];
        const found = await tuyaCloudDriver.list(credentials());
        expect(found.map((device) => device.name)).toEqual(["Socket"]);
        expect(found[0]?.kind).toBe("outlet");
    });

    it("says nothing about the state of something it cannot reach", async () => {
        devices = [
            {
                id: "vdev-5",
                name: "Shed plug",
                category: "cz",
                online: false,
                status: [{ code: "switch_1", value: true }]
            }
        ];
        const found = await tuyaCloudDriver.list(credentials());
        expect(found[0]?.online).toBe(false);
        expect(found[0]?.state).toBe("unknown");
    });
});
