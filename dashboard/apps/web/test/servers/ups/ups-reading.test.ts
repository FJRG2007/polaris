/**
 * What a UPS says, as Polaris reads it: the Atlantis A03-OP2002-RC's `upsc`
 * output, the NUT protocol answers, the alerts between two readings, the
 * shutdown decision, and the input a form sends.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as nut from "@/lib/ups/nut-client";
import * as ups from "@/lib/ups/ups-reading";
import { describe, expect, it } from "vitest";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "upsc-usbhid-0764-0601.txt"), "utf8");
const MACHINE = "6f1c1f0e-8d3a-4c1e-9f7e-2a7b5f0c1d11";

describe("reading the Atlantis A03-OP2002-RC", () => {
    const reading = ups.readingFromVars(ups.parseUpsc(FIXTURE), [
        "beeper.enable",
        "test.battery.start.quick",
        "load.off"
    ]);

    it("maps the NUT variables", () => {
        expect(reading.charge).toBe(87);
        expect(reading.runtimeS).toBe(1260);
        expect(reading.load).toBe(23);
        expect(reading.inputV).toBe(231);
        expect(reading.outputHz).toBe(50);
        expect(reading.model).toBe("OP2002-RC");
        expect(reading.beeper).toBe("enabled");
        expect(reading.status).toMatchObject({ online: true, onBattery: false, charging: true });
    });

    it("keeps only the commands Polaris offers", () => {
        expect(reading.commands).toEqual(["beeper.enable", "test.battery.start.quick"]);
    });

    it("reads a passed test as passed", () => {
        expect(ups.testOutcome(reading.testResult)).toBe("passed");
    });

    it("treats 'No test initiated' as no result", () => {
        expect(
            ups.readingFromVars({ "ups.test.result": "No test initiated" }).testResult
        ).toBeNull();
    });
});

describe("the NUT protocol answers", () => {
    it("unescapes LIST VAR values", () => {
        const vars = nut.parseListVar(
            'BEGIN LIST VAR ups\nVAR ups device.model "OP \\"2002\\""\nEND LIST VAR ups'
        );
        expect(vars).toEqual({ "device.model": 'OP "2002"' });
    });

    it("lists the commands", () => {
        expect(
            nut.parseListCmd("BEGIN LIST CMD ups\nCMD ups beeper.mute\nEND LIST CMD ups")
        ).toEqual(["beeper.mute"]);
    });
});

describe("alerts between two readings", () => {
    const online: ups.UpsMemory = { power: "online", replaceBattery: false, testResult: null };

    it("raises on battery and low battery, then back online", () => {
        expect(ups.upsTransitions(online, { ...online, power: "battery" })).toEqual([
            "ups.onBattery"
        ]);
        expect(
            ups.upsTransitions({ ...online, power: "battery" }, { ...online, power: "low" })
        ).toEqual(["ups.lowBattery"]);
        expect(ups.upsTransitions({ ...online, power: "low" }, online)).toEqual(["ups.online"]);
    });

    it("never says back online or an old test on a first reading", () => {
        expect(ups.upsTransitions(null, { ...online, testResult: "Done and passed" })).toEqual([]);
    });

    it("reports a finished test once, not a running one", () => {
        expect(ups.upsTransitions(online, { ...online, testResult: "In progress" })).toEqual([]);
        expect(ups.upsTransitions(online, { ...online, testResult: "Done and passed" })).toEqual([
            "ups.test"
        ]);
    });

    it("survives the round trip through the row", () => {
        const memory: ups.UpsMemory = {
            power: "low",
            replaceBattery: true,
            testResult: "Done and warning"
        };
        const stored = ups.encodeMemory(memory);
        expect(ups.decodeMemory(stored.lastStatus, stored.lastTestResult)).toEqual(memory);
        expect(ups.decodeMemory("nonsense", null)).toBeNull();
    });
});

describe("the shutdown decision", () => {
    const base = ups.readingFromVars({
        "ups.status": "OB DISCHRG",
        "battery.charge": "50",
        "battery.runtime": "900"
    });
    const policy: ups.ShutdownPolicy = { enabled: true, belowCharge: 40, belowRuntimeMin: 10 };

    it("is off by default and never while on the mains", () => {
        expect(ups.shutdownDue({ ...base, charge: 5 }, { ...policy, enabled: false })).toBe(false);
        expect(
            ups.shutdownDue(
                ups.readingFromVars({ "ups.status": "OL", "battery.charge": "5" }),
                policy
            )
        ).toBe(false);
    });

    it("fires below the charge, the runtime, or on low battery", () => {
        expect(ups.shutdownDue(base, policy)).toBe(false);
        expect(ups.shutdownDue({ ...base, charge: 40 }, policy)).toBe(true);
        expect(ups.shutdownDue({ ...base, runtimeS: 600 }, policy)).toBe(true);
        expect(
            ups.shutdownDue({ ...base, status: { ...base.status, lowBattery: true } }, policy)
        ).toBe(true);
    });
});

describe("the form input", () => {
    it("trims and fills the NUT defaults", () => {
        const input = ups.upsConnectionSchema.parse(
            ups.normalizeUpsInput({
                connection: "nut",
                name: "  Rack  ",
                host: " 10.0.0.5 ",
                upsName: "ups"
            })
        );
        expect(input).toMatchObject({ name: "Rack", host: "10.0.0.5", port: 3493, password: "" });
    });

    it("refuses a password that would break out of the NUT config", () => {
        const result = ups.upsConnectionSchema.safeParse({
            connection: "nut",
            name: "Rack",
            host: "nas",
            upsName: "ups",
            password: 'a"b'
        });
        expect(result.success).toBe(false);
    });

    it("asks for the SNMP field the UPS cannot be read without, unless it is stored", () => {
        const none = { community: false, authPassword: false, privPassword: false };
        const snmp = (fields: Record<string, string>) =>
            ups.upsConnectionSchema.parse({
                connection: "snmp",
                name: "Rack",
                machineId: MACHINE,
                host: "10.0.0.9",
                snmpVersion: "v2c",
                ...fields
            });
        expect(ups.missingSnmpField(snmp({}), none)).toBe("community");
        expect(ups.missingSnmpField(snmp({}), { ...none, community: true })).toBeNull();
        expect(ups.missingSnmpField(snmp({ community: "public" }), none)).toBeNull();
        expect(ups.missingSnmpField(snmp({ snmpVersion: "v3" }), none)).toBe("username");
        expect(ups.missingSnmpField(snmp({ snmpVersion: "v3", username: "ops" }), none)).toBeNull();
        expect(
            ups.missingSnmpField(
                snmp({ snmpVersion: "v3", username: "ops", privPassword: "secret" }),
                none
            )
        ).toBe("authPassword");
        expect(
            ups.missingSnmpField(
                snmp({ snmpVersion: "v3", username: "ops", privPassword: "secret" }),
                {
                    ...none,
                    authPassword: true
                }
            )
        ).toBeNull();
    });

    it("refuses an enabled shutdown with no threshold or no machine", () => {
        const draft = {
            enabled: true,
            belowCharge: 30,
            belowRuntimeMin: null,
            protectedMachineIds: []
        };
        expect(ups.upsShutdownSchema.safeParse(draft).success).toBe(false);
        expect(
            ups.upsShutdownSchema.safeParse({ ...draft, protectedMachineIds: [MACHINE] }).success
        ).toBe(true);
        expect(ups.upsShutdownSchema.safeParse({ ...draft, enabled: false }).success).toBe(true);
    });
});
