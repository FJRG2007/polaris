/**
 * Tuya through the Smart Life app: the QR sign-in, the sealed and signed calls,
 * the token trade, and what the devices become.
 *
 * The sealing and the signature fail silently: a key cut one character short or
 * a header signed in the wrong order is answered "sign invalid" with no hint as
 * to which. So they are held here to values computed by the functions of Tuya's
 * own SDK (`tuya_sharing/customerapi.py`: `_secret_generating`,
 * `_aes_gcm_encrypt` with its random nonce fixed, `_restful_sign`,
 * `_form_to_json`), run under Python with the inputs below - a test that
 * recomputed them from this implementation would prove nothing.
 *
 * Everything past that talks to a pretend Tuya, which opens each request with
 * the key the SDK's rules give, checks its signature, and seals its answer the
 * same way - so a request this client built wrong is refused here as it would be
 * there. No network.
 */

import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriverError } from "@polaris-app/places/src/lib/drivers/contract";
import { tuyaAppDriver } from "@polaris-app/places/src/lib/drivers/tuya-app";
import * as sharing from "@polaris-app/places/src/lib/integrations/tuya-sharing";

/** Computed by the SDK itself; see the header. */
const SDK = {
    rid: "8a4f0c1e-2b3d-4e5f-9a8b-7c6d5e4f3a2b",
    refresh: "fixture-refresh-token",
    hashKey: "cec9692b814eefd41d63f89006d1a012",
    secret: "67a655fd8c8cbbf4",
    nonce: "ABCDEFGHJKMN",
    query: '{"homeId":"fixture-home-1"}',
    queryEnc: "QUJDREVGR0hKS01OjlR3CXLtjPrOXdrTqtIkls0amNL2Xb5vgvcJ5Zsjs1O2bavyXOi302sbzA==",
    body: '{"commands":[{"code":"switch_1","value":true}],"name":"Sal\\u00f3n"}',
    bodyEnc:
        "QUJDREVGR0hKS01OjlR8CXLlpPCIFNqPmNFygNAb0JijEqg12qEXW/GPXjRAM9ea4FlnV3YAYhSMsV8xxMsm3W+WOuHjbbKNZ9chtw3bjxRMAdD1QPh+Q6oxu0DO6qw=",
    headers: {
        "X-appKey": "HA_3y9q4ak7g4ephrvke",
        "X-requestId": "8a4f0c1e-2b3d-4e5f-9a8b-7c6d5e4f3a2b",
        "X-sid": "",
        "X-time": "1767225600000",
        "X-token": "fixture-access-token"
    },
    sign: "f21bbddde67871fc3f8698af8f80e5bcb0088837ad71e27da1cb8ff727b26822",
    signGet: "af4006015e5a108c7f6a07473956c9da65015945b3a854541d8d2fe5a2ecd7b0"
};

describe("the sealing and the signature, against the SDK", () => {
    it("derives the same signing key and AES key", () => {
        expect(sharing.hashKeyFor(SDK.rid, SDK.refresh)).toBe(SDK.hashKey);
        expect(sharing.secretFor(SDK.rid, SDK.hashKey)).toBe(SDK.secret);
    });

    it("writes JSON the way the SDK seals it, accents escaped", () => {
        expect(sharing.tuyaJson({ homeId: "fixture-home-1" })).toBe(SDK.query);
        expect(
            sharing.tuyaJson({ commands: [{ code: "switch_1", value: true }], name: "Salón" })
        ).toBe(SDK.body);
    });

    it("seals to the same bytes for the same nonce", () => {
        expect(sharing.sealTuya(SDK.query, SDK.secret, SDK.nonce)).toBe(SDK.queryEnc);
        expect(sharing.sealTuya(SDK.body, SDK.secret, SDK.nonce)).toBe(SDK.bodyEnc);
    });

    it("opens what the SDK sealed", () => {
        expect(sharing.openTuya(SDK.bodyEnc, SDK.secret)).toBe(SDK.body);
        const own = sharing.sealTuya("round trip", SDK.secret);
        expect(sharing.openTuya(own, SDK.secret)).toBe("round trip");
    });

    it("refuses a sealed answer that was tampered with", () => {
        const tampered = `${SDK.bodyEnc.slice(0, 30)}A${SDK.bodyEnc.slice(31)}`;
        expect(() => sharing.openTuya(tampered, SDK.secret)).toThrow();
    });

    it("signs the headers, the query and the body as the SDK does", () => {
        expect(sharing.signTuya(SDK.hashKey, SDK.headers, SDK.queryEnc, SDK.bodyEnc)).toBe(SDK.sign);
        expect(sharing.signTuya(SDK.hashKey, SDK.headers, "", "")).toBe(SDK.signGet);
    });
});

// ---------------------------------------------------------------------------
// A pretend Tuya
// ---------------------------------------------------------------------------

const USER_CODE = "fixture-user-code";
const QR_TOKEN = "fixture-qr-token";
const ENDPOINT = "https://apigw.fixture-tuya.example";
const LOGIN = "https://apigw.iotbing.com";

interface Seen {
    readonly method: string;
    readonly url: URL;
    readonly headers: Record<string, string>;
    /** The query and the body, opened. */
    readonly params: unknown;
    readonly body: unknown;
}

let seen: Seen[] = [];
/** The refresh token the pretend Tuya expects requests to be keyed with. */
let refreshToken = "refresh-1";
let scanned = false;
let refreshRefused = false;
let homes: unknown[] = [];
let devicesByHome: Record<string, unknown[]> = {};

function reply(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), { status });
}

/** Answer a signed call the way Tuya does: open it with the key its request id
 *  and the account's refresh token give, check the signature, and seal the
 *  result with the same key. */
function signed(
    method: string,
    url: URL,
    headers: Record<string, string>,
    raw: string,
    answer: (params: unknown) => unknown
): Response {
    const requestId = headers["X-requestId"]!;
    const hashKey = createHash("md5").update(`${requestId}${refreshToken}`).digest("hex");
    const secret = createHmac("sha256", requestId).update(hashKey).digest("hex").slice(0, 16);
    const query = url.searchParams.get("encdata") ?? "";
    const body = raw ? (JSON.parse(raw) as { encdata: string }).encdata : "";
    const expected = sharing.signTuya(hashKey, headers, query, body);
    if (headers["X-sign"] !== expected) return reply({ success: false, code: 1004, msg: "sign invalid" });
    const params: unknown = query ? JSON.parse(sharing.openTuya(query, secret)) : null;
    seen.push({ method, url, headers, params, body: body ? JSON.parse(sharing.openTuya(body, secret)) : null });
    const result = sharing.sealTuya(JSON.stringify(answer(params)), secret);
    return reply({ success: true, t: 1_800_000_000_000, result });
}

beforeEach(() => {
    seen = [];
    refreshToken = "refresh-1";
    scanned = false;
    refreshRefused = false;
    homes = [{ ownerId: 42, name: "Home" }];
    devicesByHome = {};
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
        const url = new URL(String(input));
        const method = String(init.method);
        const headers = (init.headers ?? {}) as Record<string, string>;
        const raw = typeof init.body === "string" ? init.body : "";

        if (url.origin === LOGIN && url.pathname === "/v1.0/m/life/home-assistant/qrcode/tokens") {
            seen.push({ method, url, headers, params: null, body: null });
            if (url.searchParams.get("usercode") !== USER_CODE) {
                return reply({ success: false, code: 1106, msg: "user code invalid" });
            }
            return reply({ success: true, result: { qrcode: QR_TOKEN } });
        }
        if (url.origin === LOGIN && url.pathname === `/v1.0/m/life/home-assistant/qrcode/tokens/${QR_TOKEN}`) {
            seen.push({ method, url, headers, params: null, body: null });
            if (!scanned) return reply({ success: false, code: 1010, msg: "not yet" });
            return reply({
                success: true,
                t: 1_700_000_000_000,
                result: {
                    access_token: "access-1",
                    refresh_token: "refresh-1",
                    uid: "uid-1",
                    expire_time: 7200,
                    terminal_id: "terminal-1",
                    endpoint: ENDPOINT,
                    username: "somebody"
                }
            });
        }
        if (url.origin !== ENDPOINT) throw new Error(`unexpected ${url}`);

        if (url.pathname === `/v1.0/m/token/${refreshToken}`) {
            if (refreshRefused) return reply({ success: false, code: 1010, msg: "token invalid" });
            return signed(method, url, headers, raw, () => ({
                accessToken: "access-2",
                refreshToken: "refresh-2",
                uid: "uid-1",
                expireTime: 7200
            }));
        }
        if (url.pathname === "/v1.0/m/life/users/homes") return signed(method, url, headers, raw, () => homes);
        if (url.pathname === "/v1.0/m/life/ha/home/devices") {
            return signed(method, url, headers, raw, (params) => {
                const homeId = (params as { homeId?: string } | null)?.homeId ?? "";
                return devicesByHome[homeId] ?? [];
            });
        }
        if (/^\/v1\.1\/m\/thing\/[^/]+\/commands$/.test(url.pathname)) {
            return signed(method, url, headers, raw, () => true);
        }
        if (url.pathname === "/v1.0/m/token/terminal/expire") return signed(method, url, headers, raw, () => true);
        throw new Error(`unexpected ${url}`);
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Signed in, as the pairing leaves it: a token good for two hours from now. */
function session(overrides: Record<string, string> = {}): Record<string, string> {
    return {
        userCode: USER_CODE,
        accessToken: "access-1",
        refreshToken: "refresh-1",
        uid: "uid-1",
        expiresAt: String(Date.now() + 2 * 3_600_000),
        terminalId: "terminal-1",
        endpoint: ENDPOINT,
        ...overrides
    };
}

describe("signing in by scanning a code", () => {
    const pair = tuyaAppDriver.pair!;

    it("asks for a code for the user code, under the client the app knows", async () => {
        const started = await pair.start({ userCode: USER_CODE });
        const request = seen[0]!;
        expect(request.method).toBe("POST");
        expect(request.url.searchParams.get("clientid")).toBe("HA_3y9q4ak7g4ephrvke");
        expect(request.url.searchParams.get("schema")).toBe("haauthorize");
        expect(request.url.searchParams.get("usercode")).toBe(USER_CODE);
        expect(started.qr).toBe(`tuyaSmart--qrLogin?token=${QR_TOKEN}`);
        // Only the token behind the code on the screen goes to the browser.
        expect(started.state).toEqual({ token: QR_TOKEN });
    });

    it("says why a user code was refused, in Tuya's words", async () => {
        const failure = await pair.start({ userCode: "wrong-code" }).catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(DriverError);
        expect((failure as DriverError).message).toBe("Tuya refused the User Code: user code invalid.");
    });

    it("waits until the code has been scanned, then hands back the sign-in", async () => {
        const started = await pair.start({ userCode: USER_CODE });
        expect(await pair.poll({ userCode: USER_CODE }, started.state)).toEqual({ done: false });

        scanned = true;
        const answer = await pair.poll({ userCode: USER_CODE }, started.state);
        expect(answer.done).toBe(true);
        if (!answer.done) return;
        expect(answer.credentials).toEqual({
            userCode: USER_CODE,
            accessToken: "access-1",
            refreshToken: "refresh-1",
            uid: "uid-1",
            // `t` of the answer plus the lifetime, in milliseconds.
            expiresAt: String(1_700_000_000_000 + 7200 * 1000),
            terminalId: "terminal-1",
            endpoint: ENDPOINT
        });
        const poll = seen.find((request) => request.url.pathname.endsWith(QR_TOKEN))!;
        expect(poll.method).toBe("GET");
        expect(poll.url.searchParams.get("usercode")).toBe(USER_CODE);
    });

    it("keeps waiting through a poll that did not get through", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed");
        });
        expect(await pair.poll({ userCode: USER_CODE }, { token: QR_TOKEN })).toEqual({ done: false });
    });

    it("refuses a state that is not one it started", async () => {
        await expect(pair.poll({ userCode: USER_CODE }, {})).rejects.toThrow();
    });
});

describe("where the account's calls go", () => {
    it("believes only an https address with a host name", () => {
        expect(sharing.tuyaEndpoint("https://apigw.tuyaeu.com")).toBe("https://apigw.tuyaeu.com");
        expect(sharing.tuyaEndpoint("https://apigw.tuyaeu.com/")).toBe("https://apigw.tuyaeu.com");
        for (const bad of [
            "http://apigw.tuyaeu.com",
            "https://192.168.1.10",
            "https://[::1]",
            "https://user:pass@apigw.tuyaeu.com",
            "not a url"
        ]) {
            expect(() => sharing.tuyaEndpoint(bad), bad).toThrow();
        }
    });
});

describe("the token", () => {
    it("is used as it is while it has more than a minute left", async () => {
        expect(await tuyaAppDriver.renew!(session())).toBeNull();
        expect(seen).toHaveLength(0);
    });

    // A trade is remembered for a while by the refresh token it spent, so each
    // test here spends one of its own.
    it("is traded a minute before it lapses, with the refresh token in the key", async () => {
        refreshToken = "refresh-a";
        const renewed = await tuyaAppDriver.renew!(
            session({ refreshToken: "refresh-a", expiresAt: String(Date.now() + 30_000) })
        );
        expect(renewed).toMatchObject({
            accessToken: "access-2",
            refreshToken: "refresh-2",
            expiresAt: String(1_800_000_000_000 + 7200 * 1000),
            // What the trade does not touch stays.
            terminalId: "terminal-1",
            endpoint: ENDPOINT,
            userCode: USER_CODE
        });
        const trade = seen[0]!;
        expect(trade.method).toBe("GET");
        expect(trade.url.pathname).toBe("/v1.0/m/token/refresh-a");
        expect(trade.headers["X-token"]).toBe("access-1");
    });

    it("is traded once when two reads find it lapsing at the same moment", async () => {
        // A second trade of the same refresh token could be refused for one the
        // first just used up, and mark a good account as signed out.
        refreshToken = "refresh-b";
        const lapsing = session({ refreshToken: "refresh-b", expiresAt: "0" });
        const [first, second] = await Promise.all([
            tuyaAppDriver.renew!(lapsing),
            tuyaAppDriver.renew!(lapsing)
        ]);
        expect(first).toEqual(second);
        expect(seen.filter((request) => request.url.pathname.startsWith("/v1.0/m/token/"))).toHaveLength(1);
    });

    it("says the account is signed out when the trade is refused", async () => {
        refreshRefused = true;
        refreshToken = "refresh-revoked";
        const failure = await tuyaAppDriver
            .renew!(session({ refreshToken: "refresh-revoked", expiresAt: "0" }))
            .catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(DriverError);
        expect((failure as DriverError).kind).toBe("unauthorized");
        expect((failure as DriverError).message).toBe(
            "Tuya no longer accepts this sign-in. Scan a new code from the app."
        );
    });
});

describe("the devices", () => {
    it("lists every home's devices, as rows Places can operate", async () => {
        homes = [
            { ownerId: 42, name: "Home" },
            { ownerId: "43", name: "Cabin" }
        ];
        devicesByHome = {
            "42": [
                {
                    id: "dev-1",
                    name: "Hallway",
                    category: "kg",
                    product_name: "2 Gang Switch",
                    online: true,
                    status: [
                        { code: "switch_1", value: true },
                        { code: "switch_2", value: false },
                        // The local form of a point, which the SDK skips too.
                        { dpId: 7, value: 1 }
                    ]
                },
                { id: "dev-2", name: "Curtains", category: "cl", online: true, status: [] }
            ],
            "43": [
                {
                    id: "dev-3",
                    name: "Porch light",
                    category: "dj",
                    online: false,
                    status: [{ code: "switch_led", value: true }]
                },
                // Shared into both homes: one device, one row.
                {
                    id: "dev-1",
                    name: "Hallway",
                    category: "kg",
                    online: true,
                    status: [{ code: "switch_1", value: true }]
                }
            ]
        };
        const found = await tuyaAppDriver.list(session());
        expect(found.map((device) => [device.externalId, device.kind, device.name, device.state])).toEqual([
            ["dev-1#switch_1", "switch", "Hallway 1", "on"],
            ["dev-1#switch_2", "switch", "Hallway 2", "off"],
            ["dev-3#switch_led", "light", "Porch light", "unknown"]
        ]);
        expect(found[0]?.model).toBe("2 Gang Switch");
        const asked = seen.filter((request) => request.url.pathname === "/v1.0/m/life/ha/home/devices");
        expect(asked.map((request) => request.params)).toEqual([{ homeId: "42" }, { homeId: "43" }]);
    });

    it("sends the data point a row stands for, sealed in the body", async () => {
        await tuyaAppDriver.act(session(), { externalId: "dev-1#switch_2", kind: "switch" }, "turn-on");
        const command = seen.find((request) => request.url.pathname.endsWith("/commands"))!;
        expect(command.method).toBe("POST");
        expect(command.url.pathname).toBe("/v1.1/m/thing/dev-1/commands");
        expect(command.body).toEqual({ commands: [{ code: "switch_2", value: true }] });
    });

    it("refuses an action a switch does not have before sending anything", async () => {
        await expect(
            tuyaAppDriver.act(session(), { externalId: "dev-1#switch_1", kind: "switch" }, "unlock")
        ).rejects.toThrow("A Tuya device cannot be told to do that");
        expect(seen).toHaveLength(0);
    });

    it("signs this terminal out when the connection is removed", async () => {
        await tuyaAppDriver.forget!(session());
        const expire = seen.find((request) => request.url.pathname === "/v1.0/m/token/terminal/expire")!;
        expect(expire.body).toEqual({ accessToken: "access-1", terminalId: "terminal-1" });
    });

    it("refuses stored credentials that have no sign-in in them", async () => {
        await expect(tuyaAppDriver.list({ userCode: USER_CODE })).rejects.toThrow(
            "That connection is missing its sign-in"
        );
    });
});
