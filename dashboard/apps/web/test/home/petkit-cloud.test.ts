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
import { deviceConnection } from "@polaris-app/places/src/lib/device-connections";

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

    it("signs in again once when the session has ended, then reads", async () => {
        const stored = (await driver.verify(typed))!;
        const cloud = defaultCloud();
        let ended = false;
        respond = (call) => {
            if (call.url.pathname.endsWith("/group/family/list") && !ended) {
                ended = true;
                return { error: { code: 5, msg: "fixture: session expired" } };
            }
            if (call.url.pathname.endsWith("/user/login"))
                return fixtureSession("fixture-session-renewed");
            return cloud(call);
        };
        const boxes = await driver.list(stored);
        expect(boxes).toHaveLength(1);
        expect(calls.filter((call) => call.url.pathname.endsWith("/user/login"))).toHaveLength(2);
        // The new session is written back on the next use.
        const renewed = await driver.renew!(stored);
        expect(renewed?.session).toBe("fixture-session-renewed");
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
