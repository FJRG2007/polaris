/**
 * What a UPS says, as Polaris shows it and reacts to it.
 *
 * Every transport ends in NUT's variable names (`battery.charge`,
 * `ups.status`, ...): a USB UPS through the machine daemon's `upsd`, a network
 * UPS through its own NUT server, an SNMP card through `snmp-ups`. So one
 * mapping covers all three, and the alerts and the shutdown are decided here,
 * as pure functions over two readings, where a test can hold them.
 */

import { z } from "zod";

/** The commands Polaris offers. The machine daemon refuses any other. */
export const UPS_COMMANDS = [
    "beeper.enable",
    "beeper.disable",
    "beeper.mute",
    "test.battery.start.quick",
    "test.battery.start.deep",
    "test.battery.stop"
] as const;
export type UpsCommand = (typeof UPS_COMMANDS)[number];

export interface UpsStatus {
    online: boolean;
    onBattery: boolean;
    lowBattery: boolean;
    charging: boolean;
    replaceBattery: boolean;
    overloaded: boolean;
}

export interface UpsReading {
    status: UpsStatus;
    /** Percent, 0-100. */
    charge: number | null;
    /** Seconds of battery left at the present load. */
    runtimeS: number | null;
    /** Percent of the UPS's rated load. */
    load: number | null;
    inputV: number | null;
    inputHz: number | null;
    outputV: number | null;
    outputHz: number | null;
    batteryV: number | null;
    temperatureC: number | null;
    manufacturer: string | null;
    model: string | null;
    serial: string | null;
    /** enabled | disabled | muted, as the UPS reports it. */
    beeper: string | null;
    /** The last self-test's result in the UPS's own words, or null. */
    testResult: string | null;
    /** The commands this UPS accepts, of the ones Polaris offers. */
    commands: UpsCommand[];
}

/** NUT variables out of `upsc` output (`name: value`), for tests and fixtures. */
export function parseUpsc(text: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
        const match = /^([a-z0-9_.]+): (.*)$/i.exec(line);
        if (match) vars[match[1]!] = match[2]!.trim();
    }
    return vars;
}

function num(vars: Record<string, string>, ...names: string[]): number | null {
    for (const name of names) {
        const raw = vars[name];
        if (raw === undefined) continue;
        const value = Number.parseFloat(raw);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

function text(vars: Record<string, string>, ...names: string[]): string | null {
    for (const name of names) {
        const raw = vars[name]?.trim();
        if (raw) return raw;
    }
    return null;
}

/** The `ups.status` flags (OL, OB, LB, CHRG, RB, OVER). */
export function parseStatus(raw: string | null | undefined): UpsStatus {
    const flags = new Set((raw ?? "").toUpperCase().split(/\s+/).filter(Boolean));
    const onBattery = flags.has("OB");
    return {
        online: flags.has("OL") && !onBattery,
        onBattery,
        lowBattery: flags.has("LB"),
        charging: flags.has("CHRG"),
        replaceBattery: flags.has("RB"),
        overloaded: flags.has("OVER")
    };
}

/** A UPS's reading out of its NUT variables. */
export function readingFromVars(
    vars: Record<string, string>,
    commands: readonly string[] = []
): UpsReading {
    const status = parseStatus(vars["ups.status"]);
    const testResult = text(vars, "ups.test.result");
    return {
        status: {
            ...status,
            // Some firmware says it in the test result instead of the flags.
            replaceBattery:
                status.replaceBattery || /replace/i.test(testResult ?? "")
        },
        charge: num(vars, "battery.charge"),
        runtimeS: num(vars, "battery.runtime"),
        load: num(vars, "ups.load"),
        inputV: num(vars, "input.voltage"),
        inputHz: num(vars, "input.frequency"),
        outputV: num(vars, "output.voltage"),
        outputHz: num(vars, "output.frequency"),
        batteryV: num(vars, "battery.voltage"),
        temperatureC: num(vars, "ups.temperature", "battery.temperature"),
        manufacturer: text(vars, "device.mfr", "ups.mfr"),
        model: text(vars, "device.model", "ups.model"),
        serial: text(vars, "device.serial", "ups.serial"),
        beeper: text(vars, "ups.beeper.status"),
        testResult: testResult && !/^no test/i.test(testResult) ? testResult : null,
        commands: UPS_COMMANDS.filter((command) => commands.includes(command))
    };
}

/** How a test result reads: passed, failed, or still running. */
export function testOutcome(result: string | null): "passed" | "failed" | "running" | null {
    if (!result) return null;
    if (/progress|running/i.test(result)) return "running";
    if (/fail|error|warning|replace|abort/i.test(result)) return "failed";
    if (/pass|done|ok|success/i.test(result)) return "passed";
    return null;
}

/** What the watcher keeps of a reading to compare the next one against. */
export interface UpsMemory {
    power: "online" | "battery" | "low";
    replaceBattery: boolean;
    testResult: string | null;
}

export function memoryOf(reading: UpsReading): UpsMemory {
    return {
        power: reading.status.onBattery
            ? reading.status.lowBattery
                ? "low"
                : "battery"
            : "online",
        replaceBattery: reading.status.replaceBattery,
        testResult: reading.testResult
    };
}

export function encodeMemory(memory: UpsMemory): { lastStatus: string; lastTestResult: string | null } {
    return {
        lastStatus: `${memory.power}${memory.replaceBattery ? "+rb" : ""}`,
        lastTestResult: memory.testResult
    };
}

export function decodeMemory(lastStatus: string | null, lastTestResult: string | null): UpsMemory | null {
    if (!lastStatus) return null;
    const [power, flag] = lastStatus.split("+");
    if (power !== "online" && power !== "battery" && power !== "low") return null;
    return { power, replaceBattery: flag === "rb", testResult: lastTestResult };
}

export type UpsEvent =
    | "ups.onBattery"
    | "ups.online"
    | "ups.lowBattery"
    | "ups.test"
    | "ups.replaceBattery";

/**
 * The events between what was last seen and now. A first reading raises only
 * what needs somebody now (on battery, low battery, a worn battery), never
 * "back online" or an old test result.
 */
export function upsTransitions(before: UpsMemory | null, now: UpsMemory): UpsEvent[] {
    const events: UpsEvent[] = [];
    const was = before?.power ?? "online";
    if (now.power !== "online" && was === "online") events.push("ups.onBattery");
    if (now.power === "low" && was !== "low") events.push("ups.lowBattery");
    if (now.power === "online" && before && was !== "online") events.push("ups.online");
    if (now.replaceBattery && !before?.replaceBattery) events.push("ups.replaceBattery");
    if (
        before &&
        now.testResult &&
        now.testResult !== before.testResult &&
        testOutcome(now.testResult) !== "running"
    ) {
        events.push("ups.test");
    }
    return events;
}

export interface ShutdownPolicy {
    enabled: boolean;
    belowCharge: number | null;
    belowRuntimeMin: number | null;
}

/**
 * Whether the protected machines must be shut down now: only on battery, and
 * when the charge or the runtime crossed what the operator set - or the UPS
 * itself says its battery is low, which is the last moment it will say so.
 */
export function shutdownDue(reading: UpsReading, policy: ShutdownPolicy): boolean {
    if (!policy.enabled || !reading.status.onBattery) return false;
    if (reading.status.lowBattery) return true;
    if (policy.belowCharge !== null && reading.charge !== null && reading.charge <= policy.belowCharge)
        return true;
    return (
        policy.belowRuntimeMin !== null &&
        reading.runtimeS !== null &&
        reading.runtimeS <= policy.belowRuntimeMin * 60
    );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One normalizer for the browser and the server: trims every string. */
export function normalizeUpsInput(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
            key,
            typeof value === "string" ? value.trim() : value
        ])
    );
}

/** A host name, IPv4 or bracket-free IPv6 address. */
const address = z
    .string()
    .min(1, "required")
    .max(253, "tooLong")
    .regex(/^[A-Za-z0-9.:-]+$/, "invalidAddress");
/** What may sit inside a quoted NUT config value. */
const secret = z
    .string()
    .max(128, "tooLong")
    .regex(/^[\x21-\x7e]*$/, "invalidSecret")
    .refine((value) => !/["\\]/.test(value), "invalidSecret");
const name = z.string().min(1, "required").max(80, "tooLong");
const uuid = z.string().uuid();

export const upsConnectionSchema = z.discriminatedUnion("connection", [
    z.object({
        connection: z.literal("usb"),
        name,
        machineId: uuid,
        deviceId: z.string().regex(/^usb-[a-z0-9._-]{1,200}$/, "invalidDevice")
    }),
    z.object({
        connection: z.literal("nut"),
        name,
        host: address,
        port: z.coerce.number().int().min(1).max(65535).default(3493),
        upsName: z.string().min(1, "required").max(64).regex(/^[A-Za-z0-9._-]+$/, "invalidUpsName"),
        username: z.string().max(64).regex(/^[A-Za-z0-9._-]*$/, "invalidUser").default(""),
        /** Empty keeps the stored password; write-only, never read back. */
        password: secret.default("")
    }),
    z.object({
        connection: z.literal("snmp"),
        name,
        machineId: uuid,
        host: address,
        port: z.coerce.number().int().min(1).max(65535).default(161),
        snmpVersion: z.enum(["v1", "v2c", "v3"]),
        username: z.string().max(64).regex(/^[A-Za-z0-9._-]*$/, "invalidUser").default(""),
        /** v1/v2c: the community. Empty keeps the stored one. */
        community: secret.default(""),
        authPassword: secret.default(""),
        privPassword: secret.default("")
    })
]);
export type UpsConnectionInput = z.infer<typeof upsConnectionSchema>;

export const upsShutdownSchema = z
    .object({
        enabled: z.boolean(),
        belowCharge: z.number().int().min(5).max(95).nullable(),
        belowRuntimeMin: z.number().int().min(1).max(120).nullable(),
        protectedMachineIds: z.array(uuid).max(200)
    })
    .refine(
        (value) =>
            !value.enabled ||
            ((value.belowCharge !== null || value.belowRuntimeMin !== null) &&
                value.protectedMachineIds.length > 0),
        { message: "shutdownIncomplete" }
    );
export type UpsShutdownInput = z.infer<typeof upsShutdownSchema>;
