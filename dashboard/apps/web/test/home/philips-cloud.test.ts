/**
 * Philips Air+ through the Philips account: the emailed-code sign-in, the token
 * kept alive, the account's devices, what a unit's ports mean and what a command
 * is - with Philips' HTTP and MQTT both played by the test.
 *
 * Nothing here reaches Philips. Every request is answered by a stub that checks
 * it was asked the way the community integrations ask (`email_auth.py`,
 * `mqtt_client.py`), and the broker is a fake client that answers commands the
 * way a unit does.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { zipFiles } from "@polaris-app/calendar/src/lib/zip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- a fake broker ----------------------------------------------------------------

interface Published {
    topic: string;
    payload: string;
    qos: number;
}

class FakeClient extends EventEmitter {
    connected = false;
    ended = false;
    published: Published[] = [];
    subscribed: string[] = [];
    constructor(
        readonly url: string,
        readonly options: Record<string, unknown>
    ) {
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
                topics.map((topic) => ({
                    topic,
                    qos: broker.refuseShadow && topic.includes("shadow") ? 128 : 0
                }))
            )
        );
    }
    publish(
        topic: string,
        payload: string,
        options: { qos: number },
        callback: (error?: Error) => void
    ) {
        this.published.push({ topic, payload, qos: options.qos });
        setImmediate(() => {
            callback();
            broker.answer?.(this, topic, payload);
        });
    }
    end() {
        this.ended = true;
        this.connected = false;
    }
    /** What the unit says on its topic. */
    say(thing: string, message: unknown) {
        this.emit("message", `da_ctrl/${thing}/from_ncp`, Buffer.from(JSON.stringify(message)));
    }
}

const broker: {
    clients: FakeClient[];
    /** What happens when a client connects: "ok", or an error to raise. */
    connect: "ok" | Error;
    refuseShadow: boolean;
    answer: ((client: FakeClient, topic: string, payload: string) => void) | null;
} = { clients: [], connect: "ok", refuseShadow: false, answer: null };

vi.mock("mqtt", () => ({
    default: {
        connect: (url: string, options: Record<string, unknown>) => {
            const client = new FakeClient(url, options);
            broker.clients.push(client);
            setImmediate(() => {
                if (broker.connect === "ok") {
                    client.connected = true;
                    client.emit("connect");
                } else {
                    client.emit("error", broker.connect);
                }
            });
            return client;
        }
    }
}));

const cloud = await import("@polaris-app/places/src/lib/integrations/philips-cloud");
const link = await import("@polaris-app/places/src/lib/integrations/philips-cloud-link");
const driver = await import("@polaris-app/places/src/lib/drivers/philips-cloud");
const { DriverError } = await import("@polaris-app/places/src/lib/drivers/contract");

// --- a fake Philips ---------------------------------------------------------------

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

let routes: { match: (url: URL, init: RequestInit) => boolean; reply: Handler }[] = [];
let calls: { url: URL; init: RequestInit; body: URLSearchParams }[] = [];

function route(match: (url: URL, init: RequestInit) => boolean, reply: Handler) {
    routes.push({ match, reply });
}

function jsonReply(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
}

const at = (path: string) => (url: URL) => url.pathname.endsWith(path);

/** A whole Philips: Gigya, the OIDC issuer and the IoT API, for one account. */
function philips(
    options: {
        airplusDevices?: unknown[];
        homeidDevices?: unknown[];
        /** The device list's whole body, where a test needs a shape of its own. */
        deviceBody?: (client: "airplus" | "homeid") => unknown;
        /** The HomeID backend's appliances, served the way the profile embeds
         *  them or behind its link; absent, the backend is not there. */
        homeIdApp?: { appliances: unknown[]; embedded?: boolean };
        /** The account's id at Gigya, which the email sign-in answers; null
         *  for an answer without one. */
        uid?: string | null;
    } = {}
) {
    const issued = new Map<string, string>();
    route(at("/accounts.auth.otp.email.sendCode"), () =>
        jsonReply({ errorCode: 0, vToken: "vt-1" })
    );
    route(at("/accounts.auth.otp.email.login"), (_url, init) => {
        const body = new URLSearchParams(String(init.body));
        const uid = options.uid === undefined ? "gigya-uid-1" : options.uid;
        return body.get("code") === "123456" && body.get("vToken") === "vt-1"
            ? jsonReply({
                  errorCode: 0,
                  sessionInfo: { cookieValue: "gigya-session" },
                  ...(uid ? { UID: uid } : {})
              })
            : jsonReply({ errorCode: 403042, errorMessage: "Invalid code" });
    });
    route(at("/authorize"), (url) => {
        issued.set(url.searchParams.get("client_id")!, url.searchParams.get("code_challenge")!);
        return redirect("https://cdc.accounts.home.id/login?context=ctx-1");
    });
    route(at("/socialize.getIDs"), () => jsonReply({ errorCode: 0, gmidTicket: "ticket-1" }));
    route(at("/authorize/continue"), (url) => {
        const client = url.searchParams.get("client_id");
        const scheme =
            client === cloud.PHILIPS_CLIENTS.airplus.id
                ? "com.philips.air://loginredirect"
                : "com.philips.ka.oneka.app.prod://oauthredirect";
        return redirect(`${scheme}?code=code-${client}&state=x`);
    });
    route(at("/token"), (_url, init) => {
        const body = new URLSearchParams(String(init.body));
        const client = body.get("client_id")!;
        if (body.get("grant_type") === "authorization_code") {
            const challenge = createHash("sha256")
                .update(body.get("code_verifier")!)
                .digest("base64url");
            if (issued.get(client) !== challenge) return jsonReply({ error: "invalid_grant" }, 400);
            return jsonReply({
                access_token: `access-${client}`,
                refresh_token: `refresh-${client}`,
                expires_in: 3600
            });
        }
        return body.get("refresh_token") === "refresh-good"
            ? jsonReply({ access_token: "access-new", expires_in: 3600 })
            : jsonReply({ error: "invalid_grant" }, 400);
    });
    route(at("/user/self/device"), (_url, init) => {
        const token = new Headers(init.headers).get("authorization");
        const client =
            token === `Bearer access-${cloud.PHILIPS_CLIENTS.homeid.id}` ? "homeid" : "airplus";
        if (options.deviceBody) return jsonReply(options.deviceBody(client));
        return jsonReply({
            devices:
                client === "homeid" ? (options.homeidDevices ?? []) : (options.airplusDevices ?? [])
        });
    });
    const app = options.homeIdApp;
    if (app) {
        // The HAL chain of `get_appliances_via_homeid`, in its recorded shapes.
        route(
            (url) => url.pathname === "/.well-known/tenant/oneka",
            () => jsonReply({ profileUrl: "/user/self/profile", spaces: [] })
        );
        route(
            (url) => url.pathname === "/api/user/self/profile",
            () =>
                jsonReply(
                    app.embedded
                        ? {
                              _embedded: {
                                  userAppliances: { _embedded: { item: app.appliances } }
                              }
                          }
                        : {
                              _links: {
                                  userAppliances: {
                                      href: "/user/self/appliances{?page,size}",
                                      templated: true
                                  }
                              }
                          }
                )
        );
        route(
            (url) => url.pathname === "/api/user/self/appliances",
            () => jsonReply({ _embedded: { item: app.appliances }, page: { totalElements: 1 } })
        );
    }
    route(at("/user/self/signature"), () => jsonReply({ signature: "sig-1" }));
    route(at("/user/self"), () => jsonReply({ id: "0123456789abcdef0123456789abcdef" }));
}

const PURIFIER = {
    uuid: "11111111-2222-3333-4444-555555555555",
    thingName: "da-11111111-2222-3333-4444-555555555555",
    name: "Bedroom",
    ctn: "AC0651/10",
    localCredentials: { clientSecret: "do-not-keep", aesKey: "do-not-keep" }
};

const logged: unknown[][] = [];

beforeEach(() => {
    routes = [];
    calls = [];
    broker.clients = [];
    broker.connect = "ok";
    broker.refuseShadow = false;
    broker.answer = null;
    logged.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            logged.push(args);
        });
    }
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        calls.push({ url, init, body: new URLSearchParams(String(init.body ?? "")) });
        const found = routes.find((entry) => entry.match(url, init));
        if (!found) throw new TypeError("fetch failed");
        return found.reply(url, init);
    });
});

afterEach(() => {
    link.resetCloudLinks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// --- signing in -------------------------------------------------------------------

describe("signing in with an emailed code", () => {
    it("asks Gigya to email a code, and keeps the vToken it answers", async () => {
        philips();
        const started = await driver.philipsCloudDriver.pair!.start({
            email: "  Owner@Example.com "
        });
        expect(started.state).toEqual({ vToken: "vt-1" });
        const sent = calls[0]!;
        expect(sent.url.href).toBe("https://cdc.accounts.home.id/accounts.auth.otp.email.sendCode");
        expect(sent.body.get("email")).toBe("owner@example.com");
        expect(sent.body.get("apiKey")).toBe("4_JGZWlP8eQHpEqkvQElolbA");
    });

    it("says so when no code was sent", async () => {
        route(at("/accounts.auth.otp.email.sendCode"), () =>
            jsonReply({ errorCode: 400006, errorMessage: "Invalid parameter value" })
        );
        await expect(
            driver.philipsCloudDriver.pair!.start({ email: "owner@example.com" })
        ).rejects.toThrow(/did not send a code/);
    });

    it("keeps Philips' own title and code, never its details", async () => {
        route(at("/accounts.auth.otp.email.sendCode"), () =>
            jsonReply({
                errorCode: 400006,
                errorMessage: "Invalid parameter value",
                errorDetails: "Invalid argument: email owner@example.com\napiKey 4_secret"
            })
        );
        await expect(
            driver.philipsCloudDriver.pair!.start({ email: "owner@example.com" })
        ).rejects.toThrow(
            "Philips did not send a code to that address. Check it is the one you sign in to the Air+ app with. Philips said: Invalid parameter value (400006)."
        );
    });

    it("trades the code for tokens through prompt=none and PKCE, and lists the devices", async () => {
        philips({ airplusDevices: [PURIFIER] });
        const answer = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: " 123 456 " }
        );
        expect(answer.done).toBe(true);
        if (!answer.done) return;
        expect(answer.credentials).toMatchObject({
            email: "owner@example.com",
            accessToken: `access-${cloud.PHILIPS_CLIENTS.airplus.id}`,
            refreshToken: `refresh-${cloud.PHILIPS_CLIENTS.airplus.id}`,
            client: "airplus",
            userId: "0123456789abcdef0123456789abcdef"
        });
        expect(Number(answer.credentials.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60 * 1000);

        const authorize = calls.find((call) => call.url.pathname.endsWith("/authorize"))!;
        expect(authorize.url.searchParams.get("prompt")).toBe("none");
        expect(authorize.url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorize.url.searchParams.get("redirect_uri")).toBe(
            "com.philips.air://loginredirect"
        );
        expect(authorize.init.redirect).toBe("manual");
        const resume = calls.find((call) => call.url.pathname.endsWith("/authorize/continue"))!;
        expect(resume.url.searchParams.get("login_token")).toBe("gigya-session");
        expect(resume.url.searchParams.get("gmidTicket")).toBe("ticket-1");
        expect(resume.url.searchParams.get("context")).toBe("ctx-1");
    });

    it("tries the HomeID client when the Air+ one lists nothing", async () => {
        philips({ airplusDevices: [], homeidDevices: [PURIFIER] });
        const answer = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );
        expect(answer.done && answer.credentials.client).toBe("homeid");
    });

    it("asks for the Air+ app when no list holds an air device, saying what it saw", async () => {
        philips({ homeIdApp: { appliances: [] } });
        const answer = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );
        expect(answer).toMatchObject({
            done: false,
            next: {
                step: "file",
                summary: "Air+ (eu-west-1): 0; HomeID (eu-west-1): 0; HomeID app: 0",
                skippable: false
            }
        });
        // The browser gets a handle and nothing it could sign in with.
        const shown = JSON.stringify(answer);
        for (const secret of ["gigya-uid-1", "gigya-session", "access-", "refresh-"]) {
            expect(shown).not.toContain(secret);
        }
        expect(logged).toEqual([]);
    });

    it("refuses an account with nothing on it and no id to ask the third cloud with", async () => {
        philips({ homeIdApp: { appliances: [] }, uid: null });
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { vToken: "vt-1", code: "123456" }
            )
        ).rejects.toThrow(
            "Polaris found no device on this Philips account. It asked Philips' servers for your country (Europe) and every other region it knows. What it saw: Air+ (eu-west-1): 0; HomeID (eu-west-1): 0; HomeID app: 0. Check that the device is in a Philips app under this same email."
        );
    });

    it("calls a wrong code a wrong code, and asks for one that is missing", async () => {
        philips({ airplusDevices: [PURIFIER] });
        const wrong = driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "999999" }
        );
        await expect(wrong).rejects.toBeInstanceOf(DriverError);
        await expect(wrong).rejects.toMatchObject({ kind: "unauthorized" });
        await expect(wrong).rejects.toThrow(
            "Philips did not accept the code. Check it, or ask for a new one. Philips said: Invalid code (403042)."
        );
        await expect(
            driver.philipsCloudDriver.pair!.poll({ email: "owner@example.com" }, { vToken: "vt-1" })
        ).rejects.toThrow("Enter the code from the email");
    });

    it("names an address that never finished signing up", async () => {
        route(at("/accounts.auth.otp.email.login"), () => jsonReply({ errorCode: 206001 }));
        await expect(cloud.signInWithCode("owner@example.com", "1", "vt-1")).rejects.toThrow(
            /not a finished Philips account/
        );
    });

    it("never writes a token, a code or a key to the log", async () => {
        philips({ airplusDevices: [PURIFIER] });
        await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );
        expect(logged).toEqual([]);
    });
});

// --- the third cloud --------------------------------------------------------------

describe("going on to Philips' fan and heater cloud", () => {
    const SECRET = `a_${"c0ffee00".repeat(4)}`;
    let scratch = "";

    beforeEach(async () => {
        scratch = await mkdtemp(join(tmpdir(), "philips-file-test-"));
    });

    afterEach(async () => {
        await rm(scratch, { recursive: true, force: true });
    });

    /** A token shaped like the backend's, ending in 2100, signed by nobody. */
    const fixtureToken = () =>
        `fixture.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString("base64url")}.fixture`;

    /** An app file with the value in its code, as a stored ZIP. */
    async function appFile(): Promise<string> {
        const path = join(scratch, "air.apk");
        await writeFile(
            path,
            zipFiles([{ name: "classes.dex", text: `dex\u0000 ${SECRET} \u0000code` }])
        );
        return path;
    }

    /** Philips' fan and heater cloud, for one account. */
    function airMatters(options: { refuse?: boolean; devices?: unknown[] } = {}) {
        route(
            (url) => url.pathname === "/enduser/v2/getToken/",
            () =>
                jsonReply(
                    options.refuse
                        ? { meta: { code: 10001, message: "Lack of Signature" } }
                        : { meta: { code: 0 }, data: { token: fixtureToken() } }
                )
        );
        route(
            (url) => url.pathname === "/enduser/deviceList/",
            () =>
                jsonReply({
                    meta: { code: 0 },
                    data: options.devices ?? [
                        {
                            device_id: "00000000000000000000000000000001",
                            device_info: { name: "Fan1", modelid: "CX3550/01", type: "Trident" }
                        },
                        {
                            device_id: "00000000000000000000000000000002",
                            device_info: { name: "Heater", modelid: "CX5120/11", type: "Sirius" }
                        }
                    ]
                })
        );
    }

    async function toFileStep() {
        const answer = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );
        if (answer.done || !answer.next) throw new Error("no file step");
        return answer.next;
    }

    it("signs in with the account's id and the app's value, and keeps both", async () => {
        philips({ homeIdApp: { appliances: [] } });
        airMatters();
        const next = await toFileStep();
        const read = await driver.philipsCloudDriver.pair!.file!(await appFile());
        // A handle, never the value.
        expect(JSON.stringify(read)).not.toContain(SECRET);
        const answer = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { ...next.state, ...read }
        );
        expect(answer).toMatchObject({
            done: true,
            credentials: {
                email: "owner@example.com",
                source: "none",
                airMattersUser: "gigya-uid-1",
                airMattersSecret: SECRET
            },
            unsupported: ["CX5120/11"]
        });
        const getToken = calls.find((call) => call.url.pathname === "/enduser/v2/getToken/")!;
        expect(JSON.parse(String(getToken.init.body)).username).toBe("PHILIPS:gigya-uid-1");
        // Used once: the same handles cannot finish a second pairing.
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { ...next.state, ...read }
            )
        ).rejects.toThrow("That step took too long and has run out. Start connecting again.");
        expect(logged).toEqual([]);
    });

    it("keeps the step when the third cloud refuses the value, so another file can be tried", async () => {
        philips({ homeIdApp: { appliances: [] } });
        airMatters({ refuse: true });
        const next = await toFileStep();
        const read = await driver.philipsCloudDriver.pair!.file!(await appFile());
        const poll = () =>
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { ...next.state, ...read }
            );
        await expect(poll()).rejects.toThrow(
            "Philips' fan and heater cloud refused the sign-in. Upload the Philips Air+ app again."
        );
        await expect(poll()).rejects.toThrow(/refused the sign-in/);
    });

    it("says what it saw in all three places when the third holds nothing either", async () => {
        philips({ homeIdApp: { appliances: [] } });
        airMatters({ devices: [] });
        const next = await toFileStep();
        const read = await driver.philipsCloudDriver.pair!.file!(await appFile());
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { ...next.state, ...read }
            )
        ).rejects.toThrow(
            "What it saw: Air+ (eu-west-1): 0; HomeID (eu-west-1): 0; HomeID app: 0; Philips Air: 0. Check that the device is in a Philips app under this same email."
        );
    });

    it("refuses a handle it never gave out, or one for another address", async () => {
        philips({ homeIdApp: { appliances: [] } });
        const next = await toFileStep();
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { ticket: "made-up", appSecret: "made-up" }
            )
        ).rejects.toThrow(/has run out/);
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "someone-else@example.com" },
                { ...next.state, skip: "1" }
            )
        ).rejects.toThrow(/has run out/);
    });

    it("will not go on without the app where there was nothing else", async () => {
        philips({ homeIdApp: { appliances: [] } });
        const next = await toFileStep();
        await expect(
            driver.philipsCloudDriver.pair!.poll(
                { email: "owner@example.com" },
                { ...next.state, skip: "1" }
            )
        ).rejects.toThrow("Upload the Philips Air+ app file to go on");
    });
});
// --- keeping it alive -------------------------------------------------------------

describe("renewing the sign-in", () => {
    const stored = (expiresIn: number, refreshToken = "refresh-good") => ({
        email: "owner@example.com",
        accessToken: "access-old",
        refreshToken,
        expiresAt: String(Date.now() + expiresIn),
        client: "airplus",
        userId: "u-1"
    });

    it("leaves a token with time to run alone", async () => {
        philips();
        expect(await driver.philipsCloudDriver.renew!(stored(60 * 60 * 1000))).toBeNull();
        expect(calls).toEqual([]);
    });

    it("trades one near its end, with the client it was issued to, keeping the refresh token", async () => {
        philips();
        const next = await driver.philipsCloudDriver.renew!(stored(5 * 60 * 1000));
        expect(next).toMatchObject({
            accessToken: "access-new",
            refreshToken: "refresh-good",
            email: "owner@example.com",
            userId: "u-1"
        });
        const token = calls.find((call) => call.url.pathname.endsWith("/token"))!;
        expect(token.body.get("grant_type")).toBe("refresh_token");
        expect(token.body.get("client_id")).toBe(cloud.PHILIPS_CLIENTS.airplus.id);
    });

    it("reports a refused refresh token as a sign-in to make again", async () => {
        philips();
        await expect(
            driver.philipsCloudDriver.renew!(stored(60 * 1000, "refresh-revoked"))
        ).rejects.toMatchObject({ kind: "unauthorized" });
    });

    it("keeps the old token through an outage while it still works", async () => {
        // No routes: every call fails as a network error would.
        expect(await driver.philipsCloudDriver.renew!(stored(5 * 60 * 1000))).toBeNull();
        await expect(driver.philipsCloudDriver.renew!(stored(-1000))).rejects.toMatchObject({
            kind: "unreachable"
        });
    });
});

// --- the account's devices --------------------------------------------------------

describe("the device list", () => {
    it("keeps the id, thing, name and model, and nothing else", () => {
        expect(cloud.philipsCloudDevice(PURIFIER)).toEqual({
            id: "11111111-2222-3333-4444-555555555555",
            thing: "da-11111111-2222-3333-4444-555555555555",
            name: "Bedroom",
            model: "AC0651/10"
        });
    });

    it("names the thing after the id where the list gives none, as the app does", () => {
        expect(cloud.philipsCloudDevice({ uuid: "da-abc", type: "unknown" })).toEqual({
            id: "abc",
            thing: "da-abc",
            name: "",
            model: null
        });
        expect(cloud.philipsCloudDevice({ name: "No id" })).toBeNull();
    });

    it("reads the list however it is wrapped, once per device", async () => {
        route(at("/user/self/device"), () => jsonReply({ data: [PURIFIER, PURIFIER] }));
        expect(await cloud.listPhilipsDevices("t")).toHaveLength(1);
    });

    it("treats a 403 as a refused sign-in, not an outage", async () => {
        route(at("/user/self/device"), () => jsonReply({ message: "Forbidden" }, 403));
        await expect(cloud.listPhilipsDevices("t")).rejects.toMatchObject({ kind: "unauthorized" });
    });

    it("builds the MQTT client id from the account and the device, with a suffix of its own", () => {
        expect(
            cloud.philipsClientId(
                "0123456789abcdef0123456789abcdef",
                "da-11111111-2222-3333-4444-555555555555"
            )
        ).toBe("01234567-89ab-cdef-0123-456789abcdef_11111111-2222-3333-4444-555555555555_polaris");
    });
});

// --- finding the purifiers --------------------------------------------------------

describe("finding the purifiers on an account", () => {
    const sign = () =>
        driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );

    it("keeps a device whose other fields are null, numbers or objects", async () => {
        // The shape that lost a real purifier: one odd field used to drop the
        // whole item, and an account with a purifier read as an empty one.
        philips({
            airplusDevices: [
                {
                    uuid: PURIFIER.uuid,
                    thingName: null,
                    name: null,
                    friendlyName: "Living room",
                    deviceName: { localized: "x" },
                    ctn: "AC0651/10",
                    type: 5,
                    firmwareVersion: null
                }
            ]
        });
        const answer = await sign();
        expect(answer.done).toBe(true);
        expect(cloud.philipsCloudDevice({ id: 42, name: null, deviceType: 3 })).toEqual({
            id: "42",
            thing: "da-42",
            name: "",
            model: "3"
        });
    });

    it.each([
        ["a bare list", [PURIFIER]],
        ["devices", { devices: [PURIFIER] }],
        ["data", { data: [PURIFIER] }],
        ["items", { items: [PURIFIER] }],
        ["any key holding devices", { content: [PURIFIER], page: { size: 20 } }]
    ])("reads the list as %s", (_shape, body) => {
        expect(cloud.deviceItems(body).map(cloud.philipsCloudDevice)).toEqual([
            cloud.philipsCloudDevice(PURIFIER)
        ]);
    });

    it("draws a model nobody has mapped, and names it once connected", async () => {
        philips({ airplusDevices: [{ uuid: "u-1", name: null, ctn: "AC2959/10" }] });
        const answer = await sign();
        expect(answer).toMatchObject({ done: true, unsupported: ["AC2959/10"] });
    });

    it("says nothing about a model it knows", async () => {
        philips({ airplusDevices: [PURIFIER] });
        const answer = await sign();
        expect(answer.done && "unsupported" in answer).toBe(false);
    });

    it("finds a purifier the HomeID backend embeds in the profile", async () => {
        philips({
            homeIdApp: {
                embedded: true,
                appliances: [
                    {
                        name: "Bedroom",
                        macAddress: "aa:bb:cc:dd:ee:ff",
                        externalDeviceId: "ext-1",
                        ctn: "AC0650/10",
                        clientId: "",
                        clientSecret: "",
                        registeredIn: "FUSION"
                    }
                ]
            }
        });
        const answer = await sign();
        expect(answer).toMatchObject({
            done: true,
            credentials: { client: "homeid", source: "homeid-app" }
        });
    });

    it("follows the profile's appliance link, templated, with skipped pairings", async () => {
        philips({
            homeIdApp: {
                appliances: [{ name: "Hall", externalDeviceId: "ext-2", ctn: "AC1715/11" }]
            }
        });
        expect((await sign()).done).toBe(true);
        const appliances = calls.find((call) => call.url.pathname === "/api/user/self/appliances")!;
        expect(appliances.url.searchParams.get("includeSkippedPairing")).toBe("true");
        expect(new Headers(appliances.init.headers).get("accept")).toBe(
            "application/vnd.oneka.v2.0+json"
        );
        const discovery = calls.find((call) => call.url.pathname === "/.well-known/tenant/oneka")!;
        expect(new Headers(discovery.init.headers).get("content-type")).toBeNull();
    });

    it("lists a HomeID backend purifier again from the same place on every sync", async () => {
        philips({
            homeIdApp: {
                appliances: [{ name: "Hall", externalDeviceId: "ext-2", ctn: "AC1715/11" }]
            }
        });
        broker.connect = new Error("connect ETIMEDOUT");
        const answer = await sign();
        if (!answer.done) throw new Error("not signed in");
        const [snapshot] = await driver.philipsCloudDriver.list(answer.credentials);
        expect(snapshot).toMatchObject({ externalId: "ext-2", name: "Hall", model: "AC1715/11" });
    });

    it("keeps a kitchen appliance, and offers to go on without the Air+ app", async () => {
        philips({
            homeIdApp: {
                appliances: [{ name: "Fryer", externalDeviceId: "ext-3", ctn: "HD9880/90" }]
            }
        });
        const answer = await sign();
        expect(answer).toMatchObject({
            done: false,
            next: {
                summary: "Air+ (eu-west-1): 0; HomeID (eu-west-1): 0; HomeID app: 1 (HD9880/90)",
                skippable: true
            }
        });
        if (answer.done || !answer.next) throw new Error("no file step");
        const skipped = await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { ...answer.next.state, skip: "1" }
        );
        expect(skipped).toMatchObject({
            done: true,
            credentials: { client: "homeid", source: "homeid-app" }
        });
        expect(skipped.done && "unsupported" in skipped).toBe(false);
    });

    it("notes a list that failed and still tries the next", async () => {
        philips({
            homeIdApp: { appliances: [{ externalDeviceId: "ext-4", deviceType: "AC0651" }] }
        });
        routes.unshift({
            match: (url, init) =>
                url.pathname.endsWith("/user/self/device") &&
                new Headers(init.headers).get("authorization") ===
                    `Bearer access-${cloud.PHILIPS_CLIENTS.airplus.id}`,
            reply: () => jsonReply({ message: "Forbidden" }, 403)
        });
        const answer = await sign();
        expect(answer).toMatchObject({ done: true, credentials: { source: "homeid-app" } });
    });

    it("says what it saw when the HomeID sign-in finds a purifier it may not control", async () => {
        philips({
            homeIdApp: { appliances: [{ externalDeviceId: "ext-5", ctn: "AC0850/11" }] }
        });
        const homeid = `Bearer access-${cloud.PHILIPS_CLIENTS.homeid.id}`;
        routes.unshift({
            match: (url, init) =>
                (url.pathname.endsWith("/user/self") ||
                    url.pathname.endsWith("/user/self/device")) &&
                new Headers(init.headers).get("authorization") === homeid,
            reply: () => jsonReply({ message: "Forbidden" }, 403)
        });
        expect(await sign()).toMatchObject({
            done: false,
            next: {
                summary:
                    "Air+ (eu-west-1): 0; HomeID (eu-west-1): HTTP 403; HomeID app: 1 (AC0850/11); HomeID account (eu-west-1): HTTP 401/403",
                skippable: false
            }
        });
    });

    it("adds its own query to a backend link that already carries one", async () => {
        philips({ homeIdApp: { appliances: [{ externalDeviceId: "ext-6", ctn: "AC1715/11" }] } });
        routes.unshift({
            match: (url) => url.pathname === "/.well-known/tenant/oneka",
            reply: () => jsonReply({ profileUrl: "/user/self/profile?lang=en" })
        });
        expect(await cloud.listHomeIdAppliances("t")).toHaveLength(1);
        const profile = calls.find((call) => call.url.pathname === "/api/user/self/profile")!;
        expect(profile.url.searchParams.get("lang")).toBe("en");
        expect(profile.url.searchParams.get("ts")).toMatch(/^\d+$/);
    });

    it("logs what it saw once, with no token, id, email or code in it", async () => {
        philips({ uid: null });
        routes.unshift({
            match: (url) => url.pathname.endsWith("/user/self/device"),
            reply: () => jsonReply({ devices: [{ uuid: "secret-uuid", ctn: "HD9280/90" }] })
        });
        routes.unshift({
            match: (url) => url.pathname.endsWith("/user/self"),
            reply: () => jsonReply({ message: "Forbidden" }, 403)
        });
        await expect(sign()).rejects.toThrow(
            "What it saw: Air+ (eu-west-1): 1 (HD9280/90); HomeID (eu-west-1): 1 (HD9280/90); HomeID app: network; Air+ account (eu-west-1): HTTP 401/403; HomeID account (eu-west-1): HTTP 401/403."
        );
        expect(logged).toHaveLength(1);
        const line = JSON.stringify(logged);
        for (const secret of [
            "secret-uuid",
            "owner@example.com",
            "123456",
            "vt-1",
            "gigya-session",
            "access-",
            "refresh-"
        ]) {
            expect(line).not.toContain(secret);
        }
    });

    it("tells a kitchen appliance from an air device by its code, as the HomeID integration does", () => {
        expect(cloud.philipsApplianceKind("AC0651/10")).toBe("air");
        expect(cloud.philipsApplianceKind("HU5710/10")).toBe("air");
        expect(cloud.philipsApplianceKind(null)).toBe("air");
        expect(cloud.philipsApplianceKind("HD9255/90")).toBe("kitchen");
        expect(cloud.philipsApplianceKind("NX0960")).toBe("kitchen");
        expect(cloud.philipsApplianceKind("Flash_Entry_P EP2520")).toBe("kitchen");
    });

    it("never follows a link off Philips' backend with the token", async () => {
        philips();
        routes.unshift({
            match: (url) => url.pathname === "/.well-known/tenant/oneka",
            reply: () => jsonReply({ profileUrl: "https://elsewhere.example/profile" })
        });
        await expect(cloud.listHomeIdAppliances("t")).rejects.toBeInstanceOf(DriverError);
        expect(calls.some((call) => call.url.hostname === "elsewhere.example")).toBe(false);
    });

    it("says what each place answered, in words with nothing private", () => {
        expect(
            cloud.philipsLookupSummary([
                { where: "Air+", count: 0, models: [] },
                { where: "HomeID", count: null, models: [], failure: "HTTP 403" },
                { where: "HomeID app", count: 2, models: ["AC0651/10", "?"] }
            ])
        ).toBe("Air+: 0; HomeID: HTTP 403; HomeID app: 2 (AC0651/10, ?)");
    });
});
// --- what a unit says -------------------------------------------------------------

describe("a unit's status", () => {
    const AC0651 = driver.philipsCloudModel("AC0651/10");

    it("finds models by prefix, as models.yaml is matched", () => {
        expect(driver.philipsCloudModel("AC1715/71")).toBe(driver.PHILIPS_CLOUD_MODELS.AC1715);
        expect(driver.philipsCloudModel("AC9999")).toBeNull();
    });

    it("reads the mode, PM2.5, allergen index and both filters through the local mapping", () => {
        const air = driver.philipsCloudAir(
            {
                D0310C: 17,
                D0310D: 1,
                D03221: 12,
                D03120: 2,
                D05408: 4800,
                D0540E: 480,
                D05207: 720,
                D0520D: 20
            },
            AC0651
        );
        expect(air.mode).toBe("sleep");
        expect(air.modes).toEqual(["auto", "medium", "sleep", "turbo"]);
        expect(air.readings).toEqual({ pm25: 12, allergen: 2 });
        expect(air.filters).toEqual([
            { kind: "nanoprotect", percent: 10, hours: 480, state: "soon" },
            { kind: "pre", percent: 3, hours: 20, state: "now" }
        ]);
    });

    it("shows no preset for a value the model does not name", () => {
        expect(driver.philipsCloudAir({ D0310C: 42 }, AC0651).mode).toBeNull();
    });

    it("takes power from the shadow, and from the fan only where there is no shadow", () => {
        const device = cloud.philipsCloudDevice(PURIFIER)!;
        const snapshot = (powerOn: boolean | null, fan: number) =>
            driver.philipsCloudSnapshot(
                device,
                { properties: { D0310D: fan, D03221: 4 }, powerOn, model: "AC0651/10" },
                true
            ).state;
        expect(snapshot(true, 0)).toBe("on");
        expect(snapshot(false, 3)).toBe("off");
        expect(snapshot(null, 3)).toBe("on");
        expect(snapshot(null, 0)).toBe("off");
    });

    it("draws a unit nothing has been heard from as not answering", () => {
        const snapshot = driver.philipsCloudSnapshot(
            cloud.philipsCloudDevice(PURIFIER)!,
            null,
            false
        );
        expect(snapshot).toMatchObject({
            kind: "air",
            name: "Bedroom",
            online: false,
            state: "unknown"
        });
    });

    it("reads several JSON objects out of one frame", () => {
        expect(link.cloudMessages('{"a":1}{"b":"}"} {"c":{"d":2}}')).toEqual([
            { a: 1 },
            { b: "}" },
            { c: { d: 2 } }
        ]);
    });
});

describe("a command", () => {
    it("writes the model's own mode value", () => {
        expect(
            driver.philipsCloudValues(driver.philipsCloudModel("AC0650"), {
                action: "set-mode",
                mode: "gentle"
            })
        ).toEqual({ D0310C: 1 });
        expect(
            driver.philipsCloudValues(driver.philipsCloudModel("AC3221"), {
                action: "set-fan",
                speed: "speed_3"
            })
        ).toEqual({ D0310C: 3 });
    });

    it("refuses what the model does not have", () => {
        expect(() =>
            driver.philipsCloudValues(driver.philipsCloudModel("AC0650"), {
                action: "set-mode",
                mode: "auto"
            })
        ).toThrow("That mode is not one this device has");
        expect(() =>
            driver.philipsCloudValues(null, { action: "set-option", option: "light", on: true })
        ).toThrow("That setting is not one this device has");
    });

    it("is an NCP setPort with a correlation id and the app's client type", () => {
        const { payload } = link.ncpCommand(
            "setPort",
            "Control",
            { D0310C: 18 },
            "abcd1234",
            new Date("2026-10-01T10:00:00.123Z")
        );
        expect(JSON.parse(payload)).toEqual({
            cid: "abcd1234",
            time: "2026-10-01T10:00:00Z",
            type: "command",
            cn: "setPort",
            ct: "mobile",
            data: { portName: "Control", properties: { D0310C: 18 } }
        });
    });
});

// --- over the link ----------------------------------------------------------------

const THING = PURIFIER.thingName;
const AUTH = { accessToken: "access-1", signature: "sig-1", clientId: "u_d_polaris" };

/** A unit that answers every command, with these ports. */
function unit(
    ports: Record<string, Record<string, unknown>>,
    status: (command: string) => number = () => 0
) {
    broker.answer = (client, topic, payload) => {
        if (topic.endsWith("/shadow/get")) {
            client.emit(
                "message",
                `$aws/things/${THING}/shadow/get/accepted`,
                Buffer.from(JSON.stringify({ state: { reported: { powerOn: true } } }))
            );
            return;
        }
        if (!topic.endsWith("/to_ncp")) return;
        const command = JSON.parse(payload) as {
            cid: string;
            cn: string;
            data: { portName: string; properties: Record<string, unknown> };
        };
        client.say(THING, {
            cid: command.cid,
            type: "response",
            cn: command.cn,
            status: status(command.cn),
            data: {
                portName: command.data.portName,
                properties: command.cn === "getPort" ? (ports[command.data.portName] ?? {}) : {}
            }
        });
    };
}

describe("the MQTT link", () => {
    it("connects over WebSockets with the custom authorizer's headers", async () => {
        unit({ Status: { D0310C: 1, D03221: 7 }, filtRd: {}, Config: { ctn: "AC0651/10" } });
        const reading = await link.cloudLink("owner", THING).read(AUTH);
        const client = broker.clients[0]!;
        expect(client.url).toBe("wss://ats.prod.eu-da.iot.versuni.com:443/mqtt");
        expect(client.options).toMatchObject({
            clientId: "u_d_polaris",
            reconnectPeriod: 0,
            wsOptions: {
                headers: {
                    "x-amz-customauthorizer-name": "CustomAuthorizer",
                    "x-amz-customauthorizer-signature": "sig-1",
                    tenant: "da",
                    "token-header": "Bearer access-1"
                }
            }
        });
        expect(client.subscribed).toContain(`da_ctrl/${THING}/from_ncp`);
        expect(reading.online).toBe(true);
        expect(reading.state).toMatchObject({
            properties: { D0310C: 1, D03221: 7 },
            powerOn: true,
            model: "AC0651/10"
        });
    }, 20_000);

    it("asks a busy unit again, then lands the write", async () => {
        let busy = 2;
        unit({ Status: { D0310C: 18 } }, (command) =>
            command === "setPort" && busy-- > 0 ? 1 : 0
        );
        const cloudLink = link.cloudLink("owner", THING);
        await cloudLink.write(AUTH, { D0310C: 18 });
        const writes = broker.clients[0]!.published.filter(
            (entry) => entry.topic.endsWith("/to_ncp") && entry.payload.includes("setPort")
        );
        expect(writes).toHaveLength(3);
        expect(writes.every((entry) => entry.qos === 1)).toBe(true);
        expect(cloudLink.state.properties.D0310C).toBe(18);
    }, 20_000);

    it("refuses a write the unit refuses", async () => {
        unit({}, (command) => (command === "setPort" ? 9 : 0));
        await expect(link.cloudLink("owner", THING).write(AUTH, { D0310C: 1 })).rejects.toThrow(
            "The air purifier refused that."
        );
    }, 20_000);

    it("switches power through the shadow, never retained", async () => {
        unit({ Status: {} });
        await link.cloudLink("owner", THING).power(AUTH, false);
        const update = broker.clients[0]!.published.find((entry) =>
            entry.topic.endsWith("/shadow/update")
        )!;
        expect(update.topic).toBe(`$aws/things/${THING}/shadow/update`);
        expect(JSON.parse(update.payload)).toEqual({ state: { desired: { powerOn: false } } });
    }, 20_000);

    it("reconnects after a drop with a backoff that doubles", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        try {
            const cloudLink = link.cloudLink("owner", THING);
            const opened = cloudLink.ensure(AUTH);
            await vi.advanceTimersByTimeAsync(0);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            await opened;
            expect(broker.clients).toHaveLength(1);

            broker.connect = new Error("connect ECONNREFUSED");
            broker.clients[0]!.emit("close");
            expect(cloudLink.retry.failures).toBe(1);
            await vi.advanceTimersByTimeAsync(1000);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            expect(broker.clients).toHaveLength(2);
            expect(cloudLink.retry.failures).toBe(2);
            const second = cloudLink.retry.at - Date.now();
            expect(second).toBeGreaterThan(1000);
            expect(second).toBeLessThanOrEqual(2000);
            // A sync inside the backoff does not hammer the broker.
            await expect(cloudLink.ensure(AUTH)).rejects.toMatchObject({ kind: "unreachable" });
            expect(broker.clients).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops trying once the broker refuses the credentials, until new ones arrive", async () => {
        broker.connect = new Error("Unexpected server response: 401");
        const cloudLink = link.cloudLink("owner", THING);
        await expect(cloudLink.ensure(AUTH)).rejects.toMatchObject({ kind: "unauthorized" });
        await expect(cloudLink.ensure(AUTH)).rejects.toMatchObject({ kind: "unauthorized" });
        expect(broker.clients).toHaveLength(1);
        broker.connect = "ok";
        await cloudLink.ensure({ ...AUTH, signature: "sig-2" });
        expect(broker.clients).toHaveLength(2);
    });

    it("gives up a connect that new credentials replace, and opens with them", async () => {
        const cloudLink = link.cloudLink("owner", THING);
        const first = cloudLink.ensure(AUTH);
        const second = cloudLink.ensure({ ...AUTH, signature: "sig-2" });
        await expect(first).rejects.toMatchObject({ kind: "unreachable" });
        await second;
        expect(broker.clients).toHaveLength(2);
        expect(cloudLink.connected).toBe(true);
    });

    it("gives up a connect when the link is closed", async () => {
        const cloudLink = link.cloudLink("owner", THING);
        const opening = cloudLink.ensure(AUTH);
        cloudLink.close();
        await expect(opening).rejects.toMatchObject({ kind: "unreachable" });
        await cloudLink.ensure(AUTH);
        expect(cloudLink.connected).toBe(true);
    });

    it("does not count a write lost to a drop as landed", async () => {
        broker.answer = (client, topic) => {
            if (topic.endsWith("/to_ncp")) client.emit("close");
        };
        const cloudLink = link.cloudLink("owner", THING);
        await expect(cloudLink.write(AUTH, { D0310C: 18 })).rejects.toMatchObject({
            kind: "unreachable"
        });
        expect(cloudLink.state.properties.D0310C).toBeUndefined();
    }, 20_000);

    it("does not keep a commanded power it cannot read back", async () => {
        broker.refuseShadow = true;
        unit({ Status: {} });
        const cloudLink = link.cloudLink("owner", THING);
        await cloudLink.power(AUTH, false);
        expect(cloudLink.state.powerOn).toBeNull();
    }, 20_000);
});

// --- the driver end to end --------------------------------------------------------

describe("the driver", () => {
    const credentials = {
        email: "owner@example.com",
        accessToken: "access-1",
        refreshToken: "refresh-good",
        expiresAt: String(Date.now() + 60 * 60 * 1000),
        client: "airplus",
        userId: "0123456789abcdef0123456789abcdef"
    };

    it("lists the account's purifiers with what they read", async () => {
        philips({ airplusDevices: [PURIFIER] });
        unit({
            Status: { D0310C: 0, D0310D: 2, D03221: 30, D03120: 3 },
            filtRd: { D05408: 4800, D0540E: 4000 },
            Config: { ctn: "AC0651/10" }
        });
        const [snapshot] = await driver.philipsCloudDriver.list({ ...credentials });
        expect(snapshot).toMatchObject({
            externalId: PURIFIER.uuid,
            kind: "air",
            name: "Bedroom",
            model: "AC0651/10",
            state: "on",
            online: true,
            value: "30",
            unit: "µg/m³"
        });
        expect(snapshot!.air?.mode).toBe("auto");
        expect(JSON.stringify(snapshot)).not.toContain("do-not-keep");
        expect(logged).toEqual([]);
    }, 20_000);

    it("draws a unit whose link fails as not answering, and keeps the rest", async () => {
        philips({ airplusDevices: [PURIFIER] });
        broker.connect = new Error("connect ETIMEDOUT");
        const [snapshot] = await driver.philipsCloudDriver.list({ ...credentials });
        expect(snapshot).toMatchObject({ externalId: PURIFIER.uuid, online: false });
    }, 20_000);

    it("sets a mode by the model's value", async () => {
        philips({ airplusDevices: [PURIFIER] });
        unit({ Status: {} });
        await driver.philipsCloudDriver.act(
            { ...credentials },
            { externalId: PURIFIER.uuid, kind: "air" },
            "set-mode",
            { action: "set-mode", mode: "turbo" }
        );
        const write = broker.clients[0]!.published.find((entry) =>
            entry.payload.includes("setPort")
        )!;
        expect(JSON.parse(write.payload).data).toEqual({
            portName: "Control",
            properties: { D0310C: 18 }
        });
    }, 20_000);

    it("acts on a listed unit without listing the account again", async () => {
        philips({ airplusDevices: [PURIFIER] });
        unit({ Status: {}, filtRd: {}, Config: { ctn: "AC0651/10" } });
        await driver.philipsCloudDriver.list({ ...credentials });
        const listings = () =>
            calls.filter((call) => call.url.pathname.endsWith("/user/self/device")).length;
        const before = listings();
        await driver.philipsCloudDriver.act(
            { ...credentials },
            { externalId: PURIFIER.uuid, kind: "air" },
            "set-mode",
            { action: "set-mode", mode: "turbo" }
        );
        expect(listings()).toBe(before);
    }, 20_000);

    it("refuses a device that is not on the account", async () => {
        philips({ airplusDevices: [PURIFIER] });
        await expect(
            driver.philipsCloudDriver.act(
                { ...credentials },
                { externalId: "someone-else", kind: "air" },
                "turn-on"
            )
        ).rejects.toThrow("That device is not on this Philips account.");
    });
});
// --- the account's region -----------------------------------------------------------

const regions = await import("@polaris-app/places/src/lib/integrations/philips-regions");

/** A region the configuration service could answer, named so it reads as the
 *  fixture it is. Only the EU one is real. */
const FIXTURE_REGION = {
    region: "us-east-1",
    api: "prod.fixture-da.iot.versuni.com",
    iot: "ats.prod.fixture-da.iot.versuni.com"
};

/** Versuni's configuration service, answering `answer` for every country. */
function configuration(answer: (country: string) => Response) {
    routes.unshift({
        match: (url) =>
            url.hostname === "prod.global-da.iot.versuni.com" && url.pathname === "/configuration",
        reply: (url) => answer(url.searchParams.get("countryCode") ?? "")
    });
}

/** The device list of one IoT host, ahead of the rest of the fake. */
function hostDevices(host: string, devices: unknown[]) {
    routes.unshift({
        match: (url) => url.hostname === host && url.pathname.endsWith("/user/self/device"),
        reply: () => jsonReply({ devices })
    });
}

const configCalls = () =>
    calls.filter((call) => call.url.hostname === "prod.global-da.iot.versuni.com");
const deviceHosts = () =>
    calls
        .filter((call) => call.url.pathname.endsWith("/user/self/device"))
        .map((call) => call.url.hostname);

describe("the account's region", () => {
    beforeEach(() => cloud.resetPhilipsRegions());

    const signIn = (country: string) =>
        driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com", country },
            { vToken: "vt-1", code: "123456" }
        );

    it("asks Versuni which region the country is in, and reads the devices there", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() => jsonReply(FIXTURE_REGION));
        const answer = await signIn("US");
        expect(configCalls().map((call) => call.url.searchParams.get("countryCode"))).toEqual([
            "US"
        ]);
        expect(deviceHosts()).toEqual(["prod.fixture-da.iot.versuni.com"]);
        expect(answer).toMatchObject({
            done: true,
            credentials: {
                iotRegion: "us-east-1",
                iotApi: "prod.fixture-da.iot.versuni.com",
                iotBroker: "ats.prod.fixture-da.iot.versuni.com"
            }
        });
        // Found where it was looked for: nothing to say about it.
        expect(answer.done && "foundIn" in answer).toBe(false);
    });

    it("signs in at Gigya's one data centre whatever the country", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() => jsonReply(FIXTURE_REGION));
        await signIn("US");
        const gigya = calls.filter((call) => call.url.pathname.includes("accounts."));
        expect(gigya.length).toBeGreaterThan(0);
        for (const call of gigya) expect(call.url.hostname).toBe("cdc.accounts.home.id");
    });

    it("uses EU when the configuration service is down, slow or unreadable", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() => jsonReply({ message: "Internal Server Error" }, 500));
        const answer = await signIn("ES");
        expect(deviceHosts()).toEqual(["prod.eu-da.iot.versuni.com"]);
        expect(answer).toMatchObject({
            done: true,
            credentials: { iotRegion: "eu-west-1", iotApi: "prod.eu-da.iot.versuni.com" }
        });
        expect(await cloud.philipsRegionFor("ES")).toMatchObject({ answered: false });
    });

    it("never sends a token to a host that is not one of Versuni's", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() =>
            jsonReply({
                region: "us-east-1",
                api: "api.elsewhere.example",
                iot: "mqtt.elsewhere.example"
            })
        );
        await signIn("US");
        expect(calls.some((call) => call.url.hostname.endsWith("elsewhere.example"))).toBe(false);
        expect(deviceHosts()).toEqual(["prod.eu-da.iot.versuni.com"]);
        expect(
            cloud.storedPhilipsRegion({
                iotRegion: "us-east-1",
                iotApi: "api.elsewhere.example",
                iotBroker: "ats.prod.eu-da.iot.versuni.com"
            })
        ).toEqual(cloud.PHILIPS_EU);
    });

    it("does not ask for a country nobody picked", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() => jsonReply(FIXTURE_REGION));
        await driver.philipsCloudDriver.pair!.poll(
            { email: "owner@example.com" },
            { vToken: "vt-1", code: "123456" }
        );
        expect(configCalls()).toEqual([]);
        expect(deviceHosts()).toEqual(["prod.eu-da.iot.versuni.com"]);
    });

    it("keeps a country's answer for hours, then asks again", async () => {
        configuration(() => jsonReply(FIXTURE_REGION));
        const start = 1_000_000;
        await cloud.philipsRegionFor("US", () => start);
        await cloud.philipsRegionFor("us", () => start + 60 * 60 * 1000);
        expect(configCalls()).toHaveLength(1);
        await cloud.philipsRegionFor("US", () => start + 7 * 60 * 60 * 1000);
        expect(configCalls()).toHaveLength(2);
    });

    it("tries every other region when the country's holds nothing, and says where it found them", async () => {
        philips({ airplusDevices: [PURIFIER] });
        configuration(() => jsonReply(FIXTURE_REGION));
        hostDevices("prod.fixture-da.iot.versuni.com", []);
        const answer = await signIn("US");
        expect(answer).toMatchObject({
            done: true,
            credentials: { iotRegion: "eu-west-1", iotApi: "prod.eu-da.iot.versuni.com" },
            foundIn: { country: "US", asked: "us-east-1", found: "eu-west-1" }
        });
        // The account's id is asked where the devices were found.
        const self = calls.find((call) => call.url.pathname.endsWith("/user/self"))!;
        expect(self.url.hostname).toBe("prod.eu-da.iot.versuni.com");
    });

    it("asks the other regions side by side, not one after another", async () => {
        philips({ airplusDevices: [] });
        configuration(() => jsonReply(FIXTURE_REGION));
        const asked: string[] = [];
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        routes.unshift({
            match: (url) =>
                url.hostname === "prod.eu-da.iot.versuni.com" &&
                url.pathname.endsWith("/user/self/device"),
            reply: async (_url, init) => {
                asked.push(new Headers(init.headers).get("authorization") ?? "");
                // Neither EU answer arrives until both have been asked.
                if (asked.length === 2) release();
                await held;
                return jsonReply({ devices: [] });
            }
        });
        await signIn("US").catch(() => undefined);
        expect(asked).toHaveLength(2);
    });

    it("names the region in what it saw, and asks for the app file only once every region was asked", async () => {
        philips({ homeIdApp: { appliances: [] } });
        configuration(() => jsonReply(FIXTURE_REGION));
        const answer = await signIn("US");
        expect(answer).toMatchObject({
            done: false,
            next: {
                summary:
                    "Air+ (us-east-1): 0; HomeID (us-east-1): 0; HomeID app: 0; Air+ (eu-west-1): 0; HomeID (eu-west-1): 0",
                asked: { country: "US", region: "us-east-1", homeIdBroken: false }
            }
        });
        expect(new Set(deviceHosts())).toEqual(
            new Set(["prod.fixture-da.iot.versuni.com", "prod.eu-da.iot.versuni.com"])
        );
    });

    it("says the HomeID backend failed, and what fixes that, when it answers a server error", async () => {
        philips({ homeIdApp: { appliances: [] } });
        routes.unshift({
            match: (url) => url.pathname === "/api/user/self/profile",
            reply: () => jsonReply({ message: "Internal Server Error" }, 500)
        });
        const answer = await signIn("ES");
        expect(answer).toMatchObject({
            done: false,
            next: {
                summary: "Air+ (eu-west-1): 0; HomeID (eu-west-1): 0; HomeID app: HTTP 500",
                asked: { country: "ES", region: "eu-west-1", homeIdBroken: true }
            }
        });
    });

    it("refuses with the country and region asked when there is no id for the third cloud", async () => {
        philips({ homeIdApp: { appliances: [] }, uid: null });
        await expect(signIn("ES")).rejects.toThrow(
            "Polaris found no device on this Philips account. It asked Philips' servers for Spain (Europe) and every other region it knows."
        );
    });

    it("asks at most a few other regions, never the one already asked", async () => {
        const answers: Record<string, typeof FIXTURE_REGION> = {};
        for (const [index, country] of ["US", "CA", "BR", "AU", "SG", "IN"].entries()) {
            answers[country] = {
                region: `us-east-${index + 1}`,
                api: `prod.fixture${index}-da.iot.versuni.com`,
                iot: `ats.prod.fixture${index}-da.iot.versuni.com`
            };
        }
        configuration((country) => jsonReply(answers[country]));
        for (const country of Object.keys(answers)) await cloud.philipsRegionFor(country);
        const asked = (await cloud.philipsRegionFor("US")).region;
        const others = cloud.otherPhilipsRegions([asked]);
        expect(others.length).toBeLessThanOrEqual(4);
        expect(others[0]).toEqual(cloud.PHILIPS_EU);
        expect(others.some((region) => region.api === asked.api)).toBe(false);
        expect(new Set(others.map((region) => region.api)).size).toBe(others.length);
    });

    it("reads a stored region's devices and broker on every sync, and EU for a connection made before", async () => {
        const stored = {
            email: "owner@example.com",
            accessToken: "access-1",
            refreshToken: "refresh-good",
            expiresAt: String(Date.now() + 60 * 60 * 1000),
            client: "airplus",
            userId: "0123456789abcdef0123456789abcdef"
        };
        philips({ airplusDevices: [PURIFIER] });
        unit({ Status: {}, filtRd: {}, Config: { ctn: "AC0651/10" } });
        await driver.philipsCloudDriver.list({
            ...stored,
            email: "region@example.com",
            iotRegion: FIXTURE_REGION.region,
            iotApi: FIXTURE_REGION.api,
            iotBroker: FIXTURE_REGION.iot
        });
        expect(deviceHosts()).toEqual(["prod.fixture-da.iot.versuni.com"]);
        expect(broker.clients[0]!.url).toBe("wss://ats.prod.fixture-da.iot.versuni.com:443/mqtt");

        calls = [];
        link.resetCloudLinks();
        broker.clients = [];
        await driver.philipsCloudDriver.list({ ...stored, email: "before@example.com" });
        expect(deviceHosts()).toEqual(["prod.eu-da.iot.versuni.com"]);
        expect(broker.clients[0]!.url).toBe(link.PHILIPS_MQTT_URL);
    }, 20_000);
});

describe("guessing the country", () => {
    it("trusts a time zone Philips gives a country first", () => {
        expect(
            regions.philipsCountryGuess({ timeZones: ["Europe/Madrid"], locales: ["en-US"] })
        ).toBe("ES");
        expect(
            regions.philipsCountryGuess({ timeZones: [null, "Europe/Berlin"], locales: [] })
        ).toBe("DE");
    });

    it("goes by the language's region where the zone names no country", () => {
        expect(
            regions.philipsCountryGuess({
                timeZones: ["America/Chicago", "UTC"],
                locales: ["en-US", "es-ES"]
            })
        ).toBe("US");
        expect(regions.philipsCountryGuess({ timeZones: [], locales: ["fr", "nl-NL"] })).toBe("NL");
    });

    it("guesses nothing rather than something wrong", () => {
        expect(
            regions.philipsCountryGuess({
                timeZones: ["Antarctica/Troll", ""],
                locales: ["fr", "not a tag", "ja-JP"]
            })
        ).toBe("");
    });

    it("offers only the countries Philips' own apps offer", () => {
        expect(regions.PHILIPS_COUNTRIES).toHaveLength(79);
        expect(regions.isPhilipsCountry("ES")).toBe(true);
        expect(regions.isPhilipsCountry("JP")).toBe(false);
        expect(regions.philipsArea("eu-west-1")).toBe("eu");
        expect(regions.philipsArea("xx-north-9")).toBe("other");
    });
});
