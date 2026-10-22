/**
 * PETKIT litter boxes over their cloud, against a stubbed cloud.
 *
 * No network and no real account: every answer below is a FIXTURE, shaped
 * after the fields `pypetkitapi` reads (`containers.py` `SessionInfo`,
 * `AccountData`, `Device`; `litter_container.py` `Litter`, `StateLitter`,
 * `SettingsLitter`, `LitterRecord`). Ids, names and values are made up.
 */

import { placesCatalogs } from "@polaris-app/places/messages";
import * as kinds from "@polaris-app/places/src/lib/device-kinds";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as petkit from "@polaris-app/places/src/lib/integrations/petkit-api";
import {
    petkitCloudDriver as driver,
    usePetkitFetch,
    wireFor,
    litterOf
} from "@polaris-app/places/src/lib/drivers/petkit-cloud";
import { DriverError } from "@polaris-app/places/src/lib/drivers/contract";
import { placesRefusalText } from "@polaris-app/places/src/lib/refusal-text";
import { deviceConnection, optionOn } from "@polaris-app/places/src/lib/device-connections";

const GATEWAY = "https://api.example-petkit.test/latest/";

const FIXTURE_REGIONS = {
    result: {
        list: [
            { accountType: "email", gateway: GATEWAY, id: "DE", name: "Germany" },
            {
                accountType: "email",
                gateway: "https://other.example-petkit.test/latest/",
                id: "US",
                name: "United States"
            }
        ]
    }
};
const fixtureSession = (id: string) => ({
    result: {
        session: {
            id,
            userId: "fixture-user",
            expiresIn: 604800,
            createdAt: "2026-10-21T10:00:00.000+0000"
        }
    }
});
const FIXTURE_FAMILY = {
    result: [
        {
            groupId: 1,
            name: "Fixture home",
            deviceList: [
                {
                    deviceId: 100001,
                    deviceType: "t4",
                    deviceName: "Fixture Pura Max",
                    typeCode: 0,
                    groupId: 1,
                    createdAt: 0,
                    type: 7,
                    uniqueId: "fx-1"
                },
                {
                    deviceId: 200002,
                    deviceType: "d4",
                    deviceName: "Fixture feeder",
                    typeCode: 0,
                    groupId: 1,
                    createdAt: 0,
                    type: 11,
                    uniqueId: "fx-2"
                }
            ]
        }
    ]
};
const fixtureDetail = (overrides: Record<string, unknown> = {}) => ({
    result: {
        id: 100001,
        sn: "FIXTURE-SN",
        hardware: 1,
        firmware: "1.592",
        firmwareDetails: [],
        name: "Fixture Pura Max",
        inTimes: 3,
        lastOutTime: 1792573200,
        settings: {
            autoWork: 1,
            avoidRepeat: 1,
            kitten: 0,
            deepClean: 0,
            lightMode: 1,
            manualLock: 0
        },
        state: {
            pim: 1,
            sandPercent: 64,
            sandLack: false,
            boxFull: false,
            deodorantLeftDays: 21,
            errorMsg: null,
            ...overrides
        }
    }
});
const FIXTURE_RECORDS = {
    result: [
        {
            eventType: 10,
            petId: 7,
            petName: "Fixture cat",
            timestamp: 1792569600,
            content: { petWeight: 4350, timeIn: 1792569600, timeOut: 1792569690 }
        },
        { eventType: 5, timestamp: 1792569800, content: { startReason: 0, result: 2 } }
    ]
};

interface Call {
    url: URL;
    method: string;
    headers: Record<string, string>;
    form: URLSearchParams;
}

let calls: Call[] = [];
let respond: (call: Call) => unknown;

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
    });
}

beforeEach(() => {
    calls = [];
    respond = defaultCloud();
    usePetkitFetch(async (input, init) => {
        const call: Call = {
            url: new URL(String(input)),
            method: init?.method ?? "GET",
            headers: (init?.headers ?? {}) as Record<string, string>,
            form: new URLSearchParams(typeof init?.body === "string" ? init.body : "")
        };
        calls.push(call);
        const answer = respond(call);
        return answer instanceof Response ? answer : json(answer);
    });
});

afterEach(() => usePetkitFetch(null));

function defaultCloud(detail = fixtureDetail()) {
    let sessions = 0;
    return (call: Call): unknown => {
        const path = call.url.pathname;
        if (path.endsWith("/v1/regionservers")) return FIXTURE_REGIONS;
        if (path.endsWith("/user/login")) return fixtureSession(`fixture-session-${++sessions}`);
        if (path.endsWith("/group/family/list")) return FIXTURE_FAMILY;
        if (path.endsWith("/t4/device_detail")) return detail;
        if (path.endsWith("/t4/getDeviceRecord")) return FIXTURE_RECORDS;
        if (
            path.endsWith("/t4/controlDevice") ||
            path.endsWith("/t4/updateSettings") ||
            path.endsWith("/t4/deodorantReset")
        )
            return { result: "success" };
        return json({ error: { code: 404, msg: "fixture: unexpected path" } });
    };
}

const typed = { country: "DE", email: " Owner@Example.com ", password: "fixture-password" };

describe("PETKIT sign-in", () => {
    it("finds the gateway by country and signs in with the MD5 of the password", async () => {
        const stored = await driver.verify(typed);
        const login = calls.find((call) => call.url.pathname.endsWith("/user/login"))!;
        expect(`${login.url.origin}/latest/`).toBe(GATEWAY);
        expect(login.method).toBe("POST");
        expect(login.form.get("username")).toBe("owner@example.com");
        expect(login.form.get("password")).toBe(petkit.md5("fixture-password"));
        expect(login.form.get("encrypt")).toBe("1");
        expect(login.form.get("region")).toBe("de");
        expect(login.form.get("oldVersion")).toBe("13.2.1");
        expect(login.form.get("client")).toMatch(
            /^\{'locale': 'en-US', .*'timezoneId': '.+', 'timezone': '-?\d+\.\d+'\}$/
        );
        // Stored without the typed password, with the session it got.
        expect(stored).toMatchObject({
            email: "owner@example.com",
            country: "DE",
            session: "fixture-session-1"
        });
        expect(stored && "password" in stored).toBe(false);
        expect(stored?.passwordMd5).toBe(petkit.md5("fixture-password"));
        // Every later call carries the session.
        const family = calls.find((call) => call.url.pathname.endsWith("/group/family/list"))!;
        expect(family.headers["F-Session"]).toBe("fixture-session-1");
        expect(family.headers["X-Session"]).toBe("fixture-session-1");
    });

    it("refuses a wrong password as unauthorized", async () => {
        respond = (call) =>
            call.url.pathname.endsWith("/v1/regionservers")
                ? FIXTURE_REGIONS
                : { error: { code: 122, msg: "fixture: wrong password" } };
        const failure = await driver.verify(typed).catch((caught) => caught);
        expect(failure).toBeInstanceOf(DriverError);
        expect((failure as DriverError).kind).toBe("unauthorized");
    });

    it("sends China straight to its own server", async () => {
        expect(await petkit.gatewayFor(async () => json({}), "CN", "UTC")).toBe(
            petkit.PETKIT_CHINA
        );
    });

    it("prints a time zone offset as Python prints a float", () => {
        expect(petkit.timezoneOffset("UTC")).toBe("0.0");
        expect(petkit.timezoneOffset("Asia/Kolkata")).toBe("5.5");
        expect(petkit.timezoneOffset("Europe/Madrid", new Date("2026-01-15T12:00:00Z"))).toBe(
            "1.0"
        );
    });
});

describe("PETKIT litter boxes", () => {
    it("lists the litter box and leaves the feeder out", async () => {
        const stored = (await driver.verify(typed))!;
        const [box, ...rest] = await driver.list(stored);
        expect(rest).toEqual([]);
        expect(box).toMatchObject({
            externalId: "100001",
            kind: "litter",
            name: "Fixture Pura Max",
            model: "PETKIT T4",
            firmware: "1.592",
            online: true,
            state: "off"
        });
        expect(box!.litter).toMatchObject({
            type: "t4",
            status: "idle",
            litterPercent: 64,
            litterLow: false,
            binFull: false,
            deodorizerDays: 21,
            usesToday: 3,
            fault: null,
            deodorizerResettable: true,
            options: {
                "auto-clean": true,
                "avoid-repeat": true,
                kitten: false,
                "deep-clean": false,
                display: true,
                "child-lock": false
            }
        });
        expect(box!.litter!.uses).toEqual([
            {
                at: new Date(1792569600 * 1000).toISOString(),
                pet: "Fixture cat",
                grams: 4350,
                seconds: 90
            }
        ]);
        expect(kinds.litterView(box!.litter)).not.toBeNull();
        const records = calls.find((call) => call.url.pathname.endsWith("/t4/getDeviceRecord"))!;
        expect(records.url.searchParams.get("deviceId")).toBe("100001");
        expect(records.url.searchParams.get("date")).toMatch(/^\d{8}$/);
    });

    it("holds a reading briefly instead of calling again", async () => {
        const stored = (await driver.verify(typed))!;
        await driver.list(stored);
        const before = calls.length;
        await driver.list(stored);
        expect(calls.length).toBe(before);
    });

    it("signs in again when the stored session has run its time, then reads", async () => {
        const stored = (await driver.verify(typed))!;
        usePetkitFetch(null);
        calls = [];
        const cloud = defaultCloud();
        respond = (call) =>
            call.url.pathname.endsWith("/user/login")
                ? fixtureSession("fixture-session-renewed")
                : cloud(call);
        usePetkitFetch(async (input, init) => {
            const call: Call = {
                url: new URL(String(input)),
                method: init?.method ?? "GET",
                headers: (init?.headers ?? {}) as Record<string, string>,
                form: new URLSearchParams(typeof init?.body === "string" ? init.body : "")
            };
            calls.push(call);
            const answer = respond(call);
            return answer instanceof Response ? answer : json(answer);
        });
        const lapsed = { ...stored, sessionUntil: String(Date.now() - 1_000) };
        const boxes = await driver.list(lapsed);
        expect(boxes).toHaveLength(1);
        expect(calls.filter((call) => call.url.pathname.endsWith("/user/login"))).toHaveLength(1);
        // The new session is written back on the next use.
        const renewed = await driver.renew!(lapsed);
        expect(renewed?.session).toBe("fixture-session-renewed");
    });

    it("takes the session back by default when the phone app took it", async () => {
        const stored = (await driver.verify(typed))!;
        const cloud = defaultCloud();
        let ended = false;
        respond = (call) => {
            if (call.url.pathname.endsWith("/group/family/list") && !ended) {
                ended = true;
                return { error: { code: 5, msg: "fixture: session expired" } };
            }
            if (call.url.pathname.endsWith("/user/login"))
                return fixtureSession("fixture-session-taken-back");
            return cloud(call);
        };
        expect(await driver.list(stored)).toHaveLength(1);
        expect(calls.filter((call) => call.url.pathname.endsWith("/user/login"))).toHaveLength(2);
        const renewed = await driver.renew!(stored);
        expect(renewed?.session).toBe("fixture-session-taken-back");
    });

    it("gives the session up to the phone app when taking it back is switched off", async () => {
        const stored = { ...(await driver.verify(typed))!, takeBack: "0" };
        const cloud = defaultCloud();
        // The PETKIT app signed in with the same account: Polaris's session,
        // still well inside its time, is refused from here on.
        respond = (call) =>
            call.url.pathname.endsWith("/group/family/list") ||
            call.url.pathname.endsWith("/t4/device_detail")
                ? { error: { code: 5, msg: "fixture: session expired" } }
                : cloud(call);
        const logins = () =>
            calls.filter((call) => call.url.pathname.endsWith("/user/login")).length;
        const before = logins();

        const failure = await driver.list(stored).catch((caught) => caught);
        expect(failure).toBeInstanceOf(DriverError);
        expect((failure as DriverError).kind).toBe("unauthorized");
        expect((failure as DriverError).message).toBe(
            "PETKIT signed Polaris out because this account signed in somewhere else"
        );
        // Every later read and renewal waits, rather than signing the app out again.
        await driver.probe!(stored);
        await expect(driver.list(stored)).rejects.toBeInstanceOf(DriverError);
        await expect(driver.renew!(stored)).rejects.toBeInstanceOf(DriverError);
        expect(logins()).toBe(before);

        // Switching it back on takes the session back on the next read: the old
        // one is still refused, so it signs in again.
        const fresh = defaultCloud();
        respond = (call) =>
            call.url.pathname.endsWith("/user/login")
                ? fixtureSession("fixture-session-back")
                : call.headers["F-Session"] === stored.session
                  ? { error: { code: 5, msg: "fixture: session expired" } }
                  : fresh(call);
        await driver.probe!(stored);
        expect(await driver.list({ ...stored, takeBack: "1" })).toHaveLength(1);
        expect(logins()).toBe(before + 1);

        // So does connecting it again.
        respond = defaultCloud();
        const again = (await driver.verify(typed))!;
        await driver.probe!(again);
        expect(await driver.list(again)).toHaveLength(1);
    });

    it("says to check the region when PETKIT does not know the email", async () => {
        respond = (call) =>
            call.url.pathname.endsWith("/v1/regionservers")
                ? FIXTURE_REGIONS
                : { error: { code: 125, msg: "fixture: no such account" } };
        const failure = await driver.verify(typed).catch((caught) => caught);
        expect(failure).toBeInstanceOf(DriverError);
        expect((failure as DriverError).message).toBe(
            "PETKIT has no account with that email in that country"
        );
        // Both sentences reach the screen in the reader's language, with the
        // way to fix it.
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = placesCatalogs.translator(locale, "places");
            expect(placesRefusalText(t, (failure as DriverError).message)).toContain(
                "Change the region"
            );
            expect(
                placesRefusalText(
                    t,
                    "PETKIT signed Polaris out because this account signed in somewhere else"
                )
            ).toContain(locale === "en-US" ? "Take the session back" : "Recuperar la sesión");
        }
    });

    it("reads a running cycle, a full bin and a fault", () => {
        const view = litterOf(
            { id: 1, type: "t4", typeCode: 0, name: "x" },
            fixtureDetail({
                workState: { workMode: 0, workProcess: 10 },
                boxFull: true,
                errorMsg: "fixture fault"
            }).result,
            []
        );
        expect(view).toMatchObject({
            status: "cleaning",
            workMode: 0,
            binFull: true,
            fault: "fixture fault"
        });
    });
});

describe("PETKIT commands", () => {
    it("builds each action's wire form", () => {
        const idle = kinds.litterView({
            type: "t4",
            status: "idle",
            workMode: null,
            litterPercent: 50,
            litterLow: false,
            binFull: false,
            deodorizerDays: null,
            usesToday: null,
            lastUseAt: null,
            uses: [],
            fault: null,
            options: {},
            deodorizerResettable: true
        })!;
        const running = { ...idle, status: "cleaning" as const, workMode: 0 };
        expect(wireFor("t4", "clean", idle)).toEqual({
            kind: "control",
            key: "start_action",
            value: 0
        });
        expect(wireFor("t4", "dump", idle)).toEqual({
            kind: "control",
            key: "start_action",
            value: 1
        });
        expect(wireFor("t4", "pause", running)).toEqual({
            kind: "control",
            key: "stop_action",
            value: 0
        });
        expect(wireFor("t4", "resume", running)).toEqual({
            kind: "control",
            key: "continue_action",
            value: 0
        });
        expect(() => wireFor("t4", "pause", idle)).toThrow(DriverError);
        expect(wireFor("t4", "reset-deodorizer", idle)).toEqual({ kind: "deodorant" });
        expect(() => wireFor("t3", "reset-deodorizer", idle)).toThrow(DriverError);
        expect(
            wireFor("t4", "set-option", idle, {
                action: "set-option",
                option: "child-lock",
                on: true
            })
        ).toEqual({
            kind: "settings",
            kv: { manualLock: 1 }
        });
        expect(petkit.controlForm(100001, "start_action", 0)).toEqual({
            id: 100001,
            kv: '{"start_action":0}',
            type: "start"
        });
    });

    it("sends clean, a setting and a deodorizer reset to the box", async () => {
        const stored = (await driver.verify(typed))!;
        const box = { externalId: "100001", kind: "litter" };
        await driver.act(stored, box, "clean");
        await driver.act(stored, box, "set-option", {
            action: "set-option",
            option: "auto-clean",
            on: false
        });
        await driver.act(stored, box, "reset-deodorizer");
        const control = calls.find((call) => call.url.pathname.endsWith("/t4/controlDevice"))!;
        expect(Object.fromEntries(control.form)).toEqual({
            id: "100001",
            kv: '{"start_action":0}',
            type: "start"
        });
        const settings = calls.find((call) => call.url.pathname.endsWith("/t4/updateSettings"))!;
        expect(Object.fromEntries(settings.form)).toEqual({ id: "100001", kv: '{"autoWork":0}' });
        const reset = calls.find((call) => call.url.pathname.endsWith("/t4/deodorantReset"))!;
        expect(Object.fromEntries(reset.form)).toEqual({ deviceId: "100001" });
    });

    it("refuses a device that is not a litter box on the account", async () => {
        const stored = (await driver.verify(typed))!;
        await expect(
            driver.act(stored, { externalId: "200002", kind: "litter" }, "clean")
        ).rejects.toBeInstanceOf(DriverError);
    });

    it("limits commands per account per minute", async () => {
        const stored = (await driver.verify(typed))!;
        const box = { externalId: "100001", kind: "litter" };
        for (let i = 0; i < 8; i++) await driver.act(stored, box, "clean");
        await expect(driver.act(stored, box, "clean")).rejects.toThrow(/Too many commands/);
    });
});

describe("litter box events", () => {
    const base = kinds.litterView({
        type: "t4",
        status: "idle",
        workMode: null,
        litterPercent: 50,
        litterLow: false,
        binFull: false,
        deodorizerDays: null,
        usesToday: null,
        lastUseAt: null,
        uses: [],
        fault: null,
        options: {},
        deodorizerResettable: true
    })!;

    it("says what has just started, once", () => {
        expect(kinds.litterAttention(base, { ...base, binFull: true })).toEqual(["bin-full"]);
        expect(
            kinds.litterAttention({ ...base, binFull: true }, { ...base, binFull: true })
        ).toEqual([]);
        expect(kinds.litterAttention(base, { ...base, litterLow: true, fault: "jam" })).toEqual([
            "litter-low",
            "fault"
        ]);
        expect(kinds.litterAttention({ ...base, fault: "jam" }, { ...base, fault: "jam" })).toEqual(
            []
        );
        // A first reading is not news.
        expect(kinds.litterAttention(null, { ...base, binFull: true })).toEqual([]);
    });

    it("checks a setting against what the box reports", () => {
        const view = { ...base, options: { kitten: false } };
        expect(
            kinds.commandIssue(
                { kind: "litter", climate: null, air: null, litter: view },
                { action: "set-option", option: "kitten", on: true }
            )
        ).toBeNull();
        expect(
            kinds.commandIssue(
                { kind: "litter", climate: null, air: null, litter: view },
                { action: "set-option", option: "child-lock", on: true }
            )
        ).not.toBeNull();
        expect(kinds.actionsFor("litter")).toEqual([
            "clean",
            "pause",
            "resume",
            "dump",
            "reset-deodorizer",
            "set-option"
        ]);
        expect(kinds.grantActionFor("dump")).toBe("operate");
    });

    it("keeps the box's own words on a fault in the history", () => {
        const event = {
            id: "e1",
            deviceId: "d1",
            deviceName: "Box",
            action: "fault",
            actor: "",
            via: "device",
            outcome: "ok",
            note: "jam",
            at: new Date(0).toISOString()
        };
        expect(kinds.describeEvent(event)).toContain("jam");
        expect(kinds.describeEvent({ ...event, note: "" })).not.toContain(" - ");
    });
});

describe("PETKIT day boundary", () => {
    it("reads today in the zone the box reports, not the server's", () => {
        const at = new Date("2026-03-10T23:30:00Z");
        const zone = petkit.deviceZone({ locale: "Europe/Madrid" }, "UTC");
        expect(zone).toBe("Europe/Madrid");
        expect(petkit.dayStamp(zone, at)).toBe("20260311");
        expect(petkit.dayStamp("UTC", at)).toBe("20260310");
    });

    it("falls back when the box names no zone it knows", () => {
        expect(petkit.deviceZone({}, "UTC")).toBe("UTC");
        expect(petkit.deviceZone({ locale: "en_US" }, "UTC")).toBe("UTC");
        expect(petkit.deviceZone({ locale: "Nowhere/Atlantis" }, "UTC")).toBe("UTC");
    });
});

describe("PETKIT connection and words", () => {
    it("offers taking the session back as a switch, on unless turned off", () => {
        const connection = deviceConnection("petkit-cloud")!;
        const option = connection.options?.find((entry) => entry.key === "takeBack");
        expect(option?.defaultOn).toBe(true);
        expect(optionOn(option!, {})).toBe(true);
        expect(optionOn(option!, null)).toBe(true);
        expect(optionOn(option!, { takeBack: "0" })).toBe(false);
        expect(optionOn(option!, { takeBack: "1" })).toBe(true);
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = placesCatalogs.translator(locale, "places");
            expect(t.has("connections.petkit-cloud.options.takeBack.label")).toBe(true);
            expect(t.has("connections.petkit-cloud.options.takeBack.hint")).toBe(true);
            expect(t.has("devicesView.accountSettings")).toBe(true);
        }
    });

    it("is registered with a country, an email and a secret password", () => {
        const connection = deviceConnection("petkit-cloud")!;
        expect(connection.kinds).toEqual(["litter"]);
        expect(connection.fields.map((field) => field.key)).toEqual([
            "country",
            "email",
            "password"
        ]);
        expect(connection.fields.find((field) => field.key === "password")?.secret).toBe(true);
        expect(connection.fields[0]!.choices?.some((choice) => choice.value === "CN")).toBe(true);
    });

    it("has every litter word in both catalogs", () => {
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = placesCatalogs.translator(locale, "places");
            const keys = [
                ...kinds.LITTER_STATUSES.map((status) => `devices.litter.statuses.${status}`),
                ...kinds.LITTER_OPTIONS.map((option) => `devices.litter.options.${option}`),
                ...["clean", "pause", "resume", "dump", "reset-deodorizer"].map(
                    (action) => `devices.actions.${action}`
                ),
                ...kinds.LITTER_ATTENTION.map((which) => `litterAlerts.${which}.title`)
            ];
            for (const key of keys) expect(t.has(key), `${locale} ${key}`).toBe(true);
        }
    });
});
