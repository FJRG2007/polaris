/**
 * The UPS features past the live reading: the event log's rules, energy and
 * cost, battery health, reports, CSV, settings, variable mappings, writable
 * variables, the command words, and the NUT protocol client against a fake
 * NUT server on loopback.
 */

import * as nut from "@/lib/ups/nut-client";
import * as events from "@/lib/ups/ups-events";
import * as settings from "@/lib/ups/ups-settings";
import * as words from "@/app/(app)/places/ups/ups-words";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server } from "node:net";

describe("the event log", () => {
    it("normalizes ups.status into sorted known-looking flags", () => {
        expect(events.normalizeFlags("ol chrg  OL")).toBe("CHRG OL");
        expect(events.normalizeFlags('OB "x" LB;')).toBe("OB");
        expect(events.normalizeFlags(null)).toBe("");
    });

    it("raises one event per status flag that rises", () => {
        expect(events.flagEvents("OL", "OB")).toEqual(["ONBATT"]);
        expect(events.flagEvents("OB", "LB OB")).toEqual(["LOWBATT"]);
        expect(events.flagEvents("OL", "BOOST OL")).toEqual(["BOOST"]);
        expect(events.flagEvents("OL", "OL TRIM")).toEqual(["TRIM"]);
        expect(events.flagEvents("OL", "OL OVER")).toEqual(["OVERLOAD"]);
        expect(events.flagEvents("OL", "BYPASS OL")).toEqual(["BYPASS"]);
        expect(events.flagEvents("OL", "CAL OL")).toEqual(["CAL"]);
        expect(events.flagEvents("OL", "OFF")).toEqual(["OFF"]);
        expect(events.flagEvents("OB", "FSD OB")).toEqual(["FSD"]);
        expect(events.flagEvents("OL", "OL RB")).toEqual(["REPLBATT"]);
        expect(events.flagEvents("OL", "OL")).toEqual([]);
    });

    it("says back online when OB falls with OL up", () => {
        expect(events.flagEvents("LB OB", "CHRG OL")).toEqual(["ONLINE"]);
    });

    it("raises only the urgent kinds on a first reading", () => {
        expect(events.flagEvents(null, "OL")).toEqual([]);
        expect(events.flagEvents(null, "BOOST OL")).toEqual([]);
        expect(events.flagEvents(null, "LB OB")).toEqual(["ONBATT", "LOWBATT"]);
    });

    it("logs a lost link once, then NOCOMM once after five minutes, then COMMOK", () => {
        const start = 1_000_000;
        const lost = events.commEvents(null, false, start, false);
        expect(lost.events).toEqual(["COMMBAD"]);
        expect(events.commEvents(lost.commLostAt, false, start + 60_000, false).events).toEqual([]);
        expect(
            events.commEvents(lost.commLostAt, false, start + events.NOCOMM_AFTER_MS, false).events
        ).toEqual(["NOCOMM"]);
        expect(
            events.commEvents(lost.commLostAt, false, start + 2 * events.NOCOMM_AFTER_MS, true)
                .events
        ).toEqual([]);
        expect(
            events.commEvents(lost.commLostAt, true, start + 3 * events.NOCOMM_AFTER_MS, true)
        ).toEqual({
            events: ["COMMOK"],
            commLostAt: null
        });
        expect(events.commEvents(null, true, start, false).events).toEqual([]);
    });

    it("maps every kind to a notification and automation event", () => {
        for (const kind of events.UPS_EVENT_KINDS)
            expect(events.KIND_NOTICE[kind]).toMatch(/^ups\./);
    });

    it("parses the log's filters and refuses an unknown kind", () => {
        expect(
            events.upsEventQuerySchema.parse({ kinds: "ONBATT,TEST", state: "open", days: "7" })
        ).toMatchObject({
            kinds: ["ONBATT", "TEST"],
            state: "open",
            days: 7
        });
        expect(events.upsEventQuerySchema.parse({ state: "x", days: "9999" })).toMatchObject({
            state: "all",
            days: 30
        });
        expect(events.upsEventQuerySchema.safeParse({ kinds: "ONBATT,DROP TABLE" }).success).toBe(
            false
        );
    });
});

describe("energy and cost", () => {
    it("uses the measured real power first, then load times the rating", () => {
        expect(
            settings.powerWatts({ realPowerW: 140, load: 50, nominalPowerW: 1200, overrideW: null })
        ).toBe(140);
        expect(
            settings.powerWatts({
                realPowerW: null,
                load: 23,
                nominalPowerW: 1200,
                overrideW: null
            })
        ).toBe(276);
        expect(
            settings.powerWatts({ realPowerW: null, load: 50, nominalPowerW: null, overrideW: 600 })
        ).toBe(300);
        expect(
            settings.powerWatts({
                realPowerW: null,
                load: 50,
                nominalPowerW: null,
                overrideW: null
            })
        ).toBeNull();
        expect(
            settings.powerWatts({
                realPowerW: null,
                load: null,
                nominalPowerW: 1200,
                overrideW: null
            })
        ).toBeNull();
    });

    it("counts watt-hours between readings, never over a gap", () => {
        expect(settings.energyWh(600, 60_000)).toBeCloseTo(10);
        expect(settings.energyWh(600, settings.MAX_ENERGY_GAP_MS + 1)).toBe(0);
        expect(settings.energyWh(null, 60_000)).toBe(0);
        expect(settings.energyWh(600, -5)).toBe(0);
    });

    it("prices a kWh and buckets by the UTC hour", () => {
        expect(settings.costOf(2000, 0.15)).toBeCloseTo(0.3);
        expect(settings.costOf(2000, null)).toBe(0);
        expect(settings.hourOf(Date.parse("2026-10-19T13:47:12Z")).toISOString()).toBe(
            "2026-10-19T13:00:00.000Z"
        );
    });

    it("bounds a rollup range and refuses a backwards one", () => {
        const from = "2026-10-01T00:00:00Z";
        expect(
            settings.energyQuerySchema.safeParse({
                unit: "day",
                from,
                to: "2026-10-19T00:00:00Z",
                tz: "Europe/Madrid"
            }).success
        ).toBe(true);
        expect(
            settings.energyQuerySchema.safeParse({ unit: "hour", from, to: "2026-12-30T00:00:00Z" })
                .success
        ).toBe(false);
        expect(
            settings.energyQuerySchema.safeParse({
                unit: "day",
                from: "2026-10-19T00:00:00Z",
                to: from
            }).success
        ).toBe(false);
        expect(settings.safeTimeZone("Europe/Madrid")).toBe("Europe/Madrid");
        expect(settings.safeTimeZone("'; DROP")).toBe("UTC");
        expect(settings.safeTimeZone("Mars/Olympus")).toBe("UTC");
    });
});

describe("battery health", () => {
    const base = {
        replaceFlag: false,
        lastTestFailed: false,
        charge: 100,
        batteryV: 27.1,
        batteryVNominal: 24,
        batteryDate: null,
        now: Date.parse("2026-10-19T00:00:00Z")
    };

    it("reads NUT's battery dates", () => {
        expect(settings.parseBatteryDate("2023/05/01")?.toISOString().slice(0, 10)).toBe(
            "2023-05-01"
        );
        expect(settings.parseBatteryDate("05/01/23")?.toISOString().slice(0, 10)).toBe(
            "2023-05-01"
        );
        expect(settings.parseBatteryDate("not a date")).toBeNull();
    });

    it("is good, fair or replace, with its reasons", () => {
        expect(settings.batteryHealth(base).state).toBe("good");
        expect(settings.batteryHealth({ ...base, batteryV: 23.1 })).toMatchObject({
            state: "fair",
            reasons: ["lowVoltage"]
        });
        expect(settings.batteryHealth({ ...base, batteryDate: "2022/01/01" })).toMatchObject({
            state: "fair",
            reasons: ["old"]
        });
        expect(settings.batteryHealth({ ...base, lastTestFailed: true }).state).toBe("replace");
        expect(settings.batteryHealth({ ...base, replaceFlag: true }).reasons).toContain(
            "replaceFlag"
        );
        expect(settings.batteryHealth({ ...base, charge: null, batteryV: null }).state).toBe(
            "unknown"
        );
    });
});

describe("scheduled reports", () => {
    const monday = Date.parse("2026-10-19T08:00:00Z");

    it("covers the full period before now", () => {
        expect(settings.previousPeriod("daily", monday)).toEqual({
            from: new Date("2026-10-18T00:00:00Z"),
            to: new Date("2026-10-19T00:00:00Z")
        });
        expect(settings.previousPeriod("weekly", monday)).toEqual({
            from: new Date("2026-10-12T00:00:00Z"),
            to: new Date("2026-10-19T00:00:00Z")
        });
        expect(settings.previousPeriod("monthly", monday)).toEqual({
            from: new Date("2026-09-01T00:00:00Z"),
            to: new Date("2026-10-01T00:00:00Z")
        });
    });

    it("is due once per period", () => {
        expect(settings.reportDue("off", null, monday)).toBe(false);
        expect(settings.reportDue("daily", null, monday)).toBe(true);
        expect(settings.reportDue("daily", new Date("2026-10-19T00:01:00Z"), monday)).toBe(false);
        expect(settings.reportDue("weekly", new Date("2026-10-18T23:00:00Z"), monday)).toBe(true);
        expect(settings.reportDue("monthly", new Date("2026-10-02T00:00:00Z"), monday)).toBe(false);
    });
});

describe("CSV", () => {
    it("quotes what must be quoted and never writes a formula", () => {
        expect(settings.csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
        expect(settings.csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
        expect(settings.csvCell("-12.5")).toBe("-12.5");
        expect(settings.csvCell(null)).toBe("");
        expect(settings.toCsv(["a", "b"], [[1, "x"]])).toBe("a,b\r\n1,x\r\n");
    });
});

describe("settings", () => {
    const valid = {
        currency: " eur ",
        pricePerKwh: 0.15,
        nominalPowerW: 600,
        retentionDays: 30,
        notifyKinds: ["ONBATT"],
        reportSchedule: "weekly",
        netserverEnabled: false
    };

    it("normalizes the currency and accepts a whole form", () => {
        expect(
            settings.upsSettingsSchema.parse(settings.normalizeUpsSettings(valid)).currency
        ).toBe("EUR");
    });

    it("refuses out-of-range values and unknown keys", () => {
        const parse = (patch: object) =>
            settings.upsSettingsSchema.safeParse(
                settings.normalizeUpsSettings({ ...valid, ...patch })
            );
        expect(parse({ currency: "EURO" }).success).toBe(false);
        expect(parse({ pricePerKwh: -1 }).success).toBe(false);
        expect(parse({ retentionDays: 3 }).success).toBe(false);
        expect(parse({ nominalPowerW: 1.5 }).success).toBe(false);
        expect(parse({ notifyKinds: ["NOPE"] }).success).toBe(false);
        expect(parse({ extra: 1 }).success).toBe(false);
    });
});

describe("variable mappings", () => {
    it("fills a standard name from the UPS's own and ignores a missing one", () => {
        const vars = { "battery.charge.pct": "88", "ups.load": "12" };
        expect(
            settings.applyVariableMap(vars, {
                "battery.charge": "battery.charge.pct",
                "ups.temperature": "x.temp"
            })
        ).toEqual({
            ...vars,
            "battery.charge": "88"
        });
    });

    it("refuses a non-standard key, a bad name or a self-mapping, and reads stored junk as none", () => {
        expect(
            settings.variableMapSchema.safeParse({ "battery.charge": "my.charge" }).success
        ).toBe(true);
        expect(settings.variableMapSchema.safeParse({ "not.standard": "x" }).success).toBe(false);
        expect(settings.variableMapSchema.safeParse({ "battery.charge": "Bad Name" }).success).toBe(
            false
        );
        expect(
            settings.variableMapSchema.safeParse({ "battery.charge": "battery.charge" }).success
        ).toBe(false);
        expect(settings.readVariableMap("junk")).toEqual({});
    });
});

describe("writable variables", () => {
    it("checks a value against the kind the UPS declares", () => {
        const enumVar: settings.UpsRwVar = {
            name: "input.transfer.low",
            value: "170",
            kind: "enum",
            options: ["160", "170"]
        };
        const range: settings.UpsRwVar = {
            name: "battery.charge.low",
            value: "10",
            kind: "range",
            ranges: [["5", "50"]]
        };
        const text: settings.UpsRwVar = { name: "ups.id", value: "a", kind: "string", maxLen: 8 };
        expect(settings.rwValueError(enumVar, "160")).toBeNull();
        expect(settings.rwValueError(enumVar, "150")).toBe("notAnOption");
        expect(settings.rwValueError(range, "20")).toBeNull();
        expect(settings.rwValueError(range, "60")).toBe("outOfRange");
        expect(settings.rwValueError(range, "abc")).toBe("notANumber");
        expect(settings.rwValueError(text, "123456789")).toBe("tooLong");
        expect(settings.rwValueError(text, 'a"b')).toBe("invalidValue");
        expect(settings.rwValueError(text, "a\nb")).toBe("invalidValue");
        expect(settings.rwValueError(text, "")).toBe("required");
    });

    it("names an SNMP UPS exactly as the daemon does", () => {
        // The same literal is asserted in hostd's ups.rs tests.
        expect(settings.snmpUpsName("10.0.0.5")).toBe("snmp-87f7eb5de06ff0c1");
    });
});

describe("command words", () => {
    it("flags the commands that cut power and labels the known ones", () => {
        expect(words.isDangerousCommand("load.off")).toBe(true);
        expect(words.isDangerousCommand("load.off.delay")).toBe(true);
        expect(words.isDangerousCommand("shutdown.return")).toBe(true);
        expect(words.isDangerousCommand("beeper.mute")).toBe(false);
        expect(words.commandLabelKey("test.battery.start.quick")).toBe(
            "ups.commands.names.testQuick"
        );
        expect(words.commandLabelKey("vendor.thing")).toBeNull();
        expect(words.formatMoney(1.5, "EUR")).toMatch(/1[.,]50/);
        expect(words.formatMoney(1.5, "zz")).toBe("1.50 zz");
    });
});

describe("the NUT protocol client", () => {
    it("parses RW, TYPE, ENUM and RANGE answers", () => {
        expect(
            nut.parseListRw('BEGIN LIST RW ups\nRW ups ups.id "my \\"ups\\""\nEND LIST RW ups')
        ).toEqual([["ups.id", 'my "ups"']]);
        expect(nut.parseType("TYPE ups ups.id RW STRING:16")).toEqual({
            kind: "string",
            maxLen: 16
        });
        expect(nut.parseType("TYPE ups input.transfer.low RW ENUM")).toEqual({ kind: "enum" });
        expect(nut.parseQuoted('RANGE ups x "5" "50"\nRANGE ups x "60" "70"', "RANGE")).toEqual([
            ["5", "50"],
            ["60", "70"]
        ]);
    });

    let server: Server;
    let port = 0;
    const seen: string[] = [];
    const ANSWERS: Record<string, string> = {
        "LIST VAR ups":
            'BEGIN LIST VAR ups\nVAR ups battery.charge "88"\nVAR ups ups.status "OL"\nEND LIST VAR ups\n',
        "LIST CMD ups": "BEGIN LIST CMD ups\nCMD ups beeper.mute\nEND LIST CMD ups\n",
        "LIST RW ups":
            'BEGIN LIST RW ups\nRW ups input.transfer.low "170"\nRW ups ups.id "rack"\nEND LIST RW ups\n',
        "GET TYPE ups input.transfer.low": "TYPE ups input.transfer.low RW ENUM\n",
        "GET TYPE ups ups.id": "TYPE ups ups.id RW STRING:8\n",
        "LIST ENUM ups input.transfer.low":
            'BEGIN LIST ENUM ups input.transfer.low\nENUM ups input.transfer.low "160"\nENUM ups input.transfer.low "170"\nEND LIST ENUM ups input.transfer.low\n',
        "USERNAME admin": "OK\n",
        "PASSWORD secret": "OK\n",
        'SET VAR ups ups.id "new id"': "OK\n",
        'SET VAR ups ups.id "bad"': "ERR INVALID-VALUE\n"
    };

    beforeAll(async () => {
        server = createServer((socket) => {
            socket.on("error", () => undefined);
            let buffer = "";
            socket.on("data", (chunk) => {
                buffer += chunk.toString();
                let at = buffer.indexOf("\n");
                while (at >= 0) {
                    const line = buffer.slice(0, at);
                    buffer = buffer.slice(at + 1);
                    seen.push(line);
                    if (line === "LOGOUT") socket.end("OK Goodbye\n");
                    else socket.write(ANSWERS[line] ?? "ERR UNKNOWN-COMMAND\n");
                    at = buffer.indexOf("\n");
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = (server.address() as AddressInfo).port;
    });

    afterAll(() => {
        server.close();
    });

    it("reads variables, commands and writable variables with their kinds", async () => {
        const answer = await nut.nutRead(
            { host: "127.0.0.1", port, upsName: "ups" },
            { writable: true }
        );
        expect(answer.vars).toEqual({ "battery.charge": "88", "ups.status": "OL" });
        expect(answer.commands).toEqual(["beeper.mute"]);
        expect(answer.rw).toEqual([
            { name: "input.transfer.low", value: "170", kind: "enum", options: ["160", "170"] },
            { name: "ups.id", value: "rack", kind: "string", maxLen: 8 }
        ]);
    });

    it("skips the writable variables unless asked for them", async () => {
        seen.length = 0;
        const answer = await nut.nutRead({ host: "127.0.0.1", port, upsName: "ups" });
        expect(answer.commands).toEqual(["beeper.mute"]);
        expect(answer.rw).toEqual([]);
        expect(seen.some((line) => line.startsWith("LIST RW") || line.startsWith("GET TYPE"))).toBe(
            false
        );
    });

    it("sets a variable logged in, quoting the value, and reports a refusal", async () => {
        const target = { host: "127.0.0.1", port, upsName: "ups" };
        await nut.nutSetVar(target, "admin", "secret", "ups.id", "new id");
        expect(seen).toContain('SET VAR ups ups.id "new id"');
        await expect(nut.nutSetVar(target, "admin", "secret", "ups.id", "bad")).rejects.toThrow(
            "INVALID-VALUE"
        );
        await expect(nut.nutSetVar(target, "admin", "wrong", "ups.id", "x")).rejects.toThrow(
            "UNKNOWN-COMMAND"
        );
    });

    it("fails fast on a closed port", async () => {
        await expect(nut.nutRead({ host: "127.0.0.1", port: 1, upsName: "ups" })).rejects.toThrow();
    });
});
