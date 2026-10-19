/**
 * The rules behind a UPS's energy, battery health, reports, settings,
 * variable mappings and writable variables. Pure and client-safe: the screens
 * validate with the same schemas the actions parse with.
 */

import { z } from "zod";
import { UPS_EVENT_KINDS } from "./ups-events";

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

/**
 * The real power a UPS delivers, in watts: what it measures when it does,
 * otherwise its load times its real power rating - its own, or the one the
 * operator typed for a UPS that does not report it. Null when neither is known.
 */
export function powerWatts(input: {
    realPowerW: number | null;
    load: number | null;
    nominalPowerW: number | null;
    overrideW: number | null;
}): number | null {
    if (input.realPowerW !== null && input.realPowerW >= 0) return input.realPowerW;
    const rating = input.nominalPowerW ?? input.overrideW;
    if (input.load === null || rating === null || rating <= 0) return null;
    return Math.max(0, (input.load / 100) * rating);
}

/** A gap longer than this between two readings is not counted as energy. */
export const MAX_ENERGY_GAP_MS = 5 * 60_000;

/** Watt-hours delivered between two readings, or 0 over a gap or a restart. */
export function energyWh(powerW: number | null, elapsedMs: number): number {
    if (powerW === null || elapsedMs <= 0 || elapsedMs > MAX_ENERGY_GAP_MS) return 0;
    return (powerW * elapsedMs) / 3_600_000;
}

/** The UTC hour a reading's energy is added to. */
export function hourOf(at: number): Date {
    return new Date(Math.floor(at / 3_600_000) * 3_600_000);
}

export function costOf(wh: number, pricePerKwh: number | null): number {
    return pricePerKwh === null ? 0 : (wh / 1000) * pricePerKwh;
}

export const ENERGY_UNITS = ["hour", "day", "month"] as const;
export type EnergyUnit = (typeof ENERGY_UNITS)[number];

/** The longest span each rollup may cover, so one query stays bounded. */
const MAX_SPAN_DAYS: Record<EnergyUnit, number> = { hour: 31, day: 400, month: 1830 };

/** An IANA time zone this runtime knows, or UTC. */
export function safeTimeZone(raw: string | null | undefined): string {
    if (!raw || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return "UTC";
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: raw });
        return raw;
    } catch {
        return "UTC";
    }
}

export const energyQuerySchema = z
    .object({
        unit: z.enum(ENERGY_UNITS).catch("day"),
        from: z.coerce.date(),
        to: z.coerce.date(),
        tz: z.string().optional().transform(safeTimeZone)
    })
    .refine((value) => value.from < value.to, { message: "invalidRange", path: ["to"] })
    .refine(
        (value) =>
            value.to.getTime() - value.from.getTime() <= MAX_SPAN_DAYS[value.unit] * 86_400_000,
        { message: "rangeTooLong", path: ["from"] }
    );
export type EnergyQuery = z.infer<typeof energyQuerySchema>;

// ---------------------------------------------------------------------------
// Battery health
// ---------------------------------------------------------------------------

export type BatteryHealthState = "good" | "fair" | "replace" | "unknown";
export type BatteryHealthReason = "replaceFlag" | "testFailed" | "lowVoltage" | "old";

/** A battery's install or make date out of NUT's `battery.date` forms. */
export function parseBatteryDate(raw: string | null): Date | null {
    if (!raw) return null;
    const iso = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(raw.trim());
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
    let year: number, month: number, day: number;
    if (iso) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (us) [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
    else return null;
    if (year < 100) year += 2000;
    if (year < 1990 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month - 1, day));
}

/** Years after which a lead-acid UPS battery is usually due. */
export const BATTERY_LIFE_YEARS = 3;

/**
 * How the battery is doing, and why: the UPS's own replace flag or a failed
 * self-test say replace; a full battery below its nominal voltage, or one
 * older than its usual life, say fair. Nothing to judge from says unknown.
 */
export function batteryHealth(input: {
    replaceFlag: boolean;
    lastTestFailed: boolean;
    charge: number | null;
    batteryV: number | null;
    batteryVNominal: number | null;
    batteryDate: string | null;
    now: number;
}): { state: BatteryHealthState; reasons: BatteryHealthReason[]; ageYears: number | null } {
    const reasons: BatteryHealthReason[] = [];
    if (input.replaceFlag) reasons.push("replaceFlag");
    if (input.lastTestFailed) reasons.push("testFailed");
    if (
        input.charge !== null &&
        input.charge >= 95 &&
        input.batteryV !== null &&
        input.batteryVNominal !== null &&
        input.batteryVNominal > 0 &&
        input.batteryV < input.batteryVNominal
    ) {
        reasons.push("lowVoltage");
    }
    const made = parseBatteryDate(input.batteryDate);
    const ageYears = made
        ? Math.max(0, (input.now - made.getTime()) / (365.25 * 86_400_000))
        : null;
    if (ageYears !== null && ageYears >= BATTERY_LIFE_YEARS) reasons.push("old");
    const judged =
        input.charge !== null || input.batteryV !== null || made !== null || reasons.length > 0;
    const state: BatteryHealthState = reasons.some(
        (one) => one === "replaceFlag" || one === "testFailed"
    )
        ? "replace"
        : reasons.length > 0
          ? "fair"
          : judged
            ? "good"
            : "unknown";
    return { state, reasons, ageYears: ageYears === null ? null : Math.round(ageYears * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const REPORT_SCHEDULES = ["off", "daily", "weekly", "monthly"] as const;
export type ReportSchedule = (typeof REPORT_SCHEDULES)[number];

/** The start of the period `at` falls in (UTC; weeks start on Monday). */
export function periodStart(schedule: Exclude<ReportSchedule, "off">, at: number): Date {
    const d = new Date(at);
    if (schedule === "monthly") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (schedule === "daily") return day;
    const back = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - back * 86_400_000);
}

/** The full period before the one `at` falls in: what a report covers. */
export function previousPeriod(
    schedule: Exclude<ReportSchedule, "off">,
    at: number
): { from: Date; to: Date } {
    const to = periodStart(schedule, at);
    return { from: periodStart(schedule, to.getTime() - 1), to };
}

/** Whether a report is due: once per period, the first pass after it starts. */
export function reportDue(schedule: ReportSchedule, lastAt: Date | null, now: number): boolean {
    if (schedule === "off") return false;
    return lastAt === null || lastAt.getTime() < periodStart(schedule, now).getTime();
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** One CSV cell: quoted when it must be, and never a formula a sheet runs. */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
    return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export const EXPORT_KINDS = ["samples", "events", "energy", "actions"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const exportQuerySchema = z
    .object({
        what: z.enum(EXPORT_KINDS),
        days: z.coerce.number().int().min(1).max(365).catch(30)
    })
    .strict();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** One normalizer for browser and server: trims, upper-cases the currency. */
export function normalizeUpsSettings(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    const value = raw as Record<string, unknown>;
    return {
        ...value,
        currency:
            typeof value.currency === "string"
                ? value.currency.trim().toUpperCase()
                : value.currency
    };
}

export const upsSettingsSchema = z
    .object({
        currency: z.string().regex(/^[A-Z]{3}$/, "invalidCurrency"),
        pricePerKwh: z.number().min(0, "invalidPrice").max(100, "invalidPrice").nullable(),
        nominalPowerW: z
            .number()
            .int("invalidPower")
            .min(1, "invalidPower")
            .max(100_000, "invalidPower")
            .nullable(),
        retentionDays: z
            .number()
            .int("invalidRetention")
            .min(7, "invalidRetention")
            .max(365, "invalidRetention"),
        notifyKinds: z.array(z.enum(UPS_EVENT_KINDS)).max(UPS_EVENT_KINDS.length),
        reportSchedule: z.enum(REPORT_SCHEDULES),
        netserverEnabled: z.boolean()
    })
    .strict();
export type UpsSettingsInput = z.infer<typeof upsSettingsSchema>;

// ---------------------------------------------------------------------------
// Variable mappings
// ---------------------------------------------------------------------------

/** The standard names Polaris reads, which a mapping may point elsewhere. */
export const MAPPABLE_VARS = [
    "ups.status",
    "battery.charge",
    "battery.runtime",
    "battery.voltage",
    "battery.voltage.nominal",
    "battery.date",
    "ups.load",
    "ups.realpower",
    "ups.realpower.nominal",
    "ups.power",
    "ups.power.nominal",
    "input.voltage",
    "input.frequency",
    "output.voltage",
    "output.frequency",
    "ups.temperature",
    "ups.test.result",
    "ups.beeper.status"
] as const;

/** A NUT variable or command name: lowercase words joined by dots. */
export const nutName = z
    .string()
    .max(64, "tooLong")
    .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, "invalidName");

export const variableMapSchema = z
    .record(z.enum(MAPPABLE_VARS), nutName)
    .refine((map) => Object.entries(map).every(([from, to]) => from !== to), {
        message: "mapsToItself"
    });
export type VariableMap = z.infer<typeof variableMapSchema>;

/** A stored mapping read back total: anything that no longer parses is none. */
export function readVariableMap(stored: unknown): VariableMap {
    const parsed = variableMapSchema.safeParse(stored);
    return parsed.success ? parsed.data : {};
}

/** The variables with each mapped standard name filled from the UPS's own. */
export function applyVariableMap(
    vars: Record<string, string>,
    map: VariableMap
): Record<string, string> {
    const out = { ...vars };
    for (const [standard, own] of Object.entries(map)) {
        const value = vars[own];
        if (value !== undefined) out[standard] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Writable variables
// ---------------------------------------------------------------------------

export interface UpsRwVar {
    name: string;
    value: string;
    kind: "string" | "number" | "enum" | "range";
    maxLen?: number;
    options?: string[];
    ranges?: [string, string][];
}

/** A value NUT can carry inside quotes: printable, no quote or backslash. */
const SAFE_VALUE = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

/** Why `value` cannot be set on `rw`, or null when it can. Shared by both sides. */
export function rwValueError(rw: UpsRwVar, value: string): string | null {
    if (value.length === 0) return "required";
    if (value.length > 64 || (rw.maxLen !== undefined && value.length > rw.maxLen))
        return "tooLong";
    if (!SAFE_VALUE.test(value)) return "invalidValue";
    if (rw.kind === "enum") return (rw.options ?? []).includes(value) ? null : "notAnOption";
    if (rw.kind === "number" || rw.kind === "range") {
        if (!/^-?\d+(\.\d+)?$/.test(value)) return "notANumber";
        const number = Number(value);
        if (rw.kind === "range" && (rw.ranges ?? []).length > 0) {
            const inside = (rw.ranges ?? []).some(
                ([min, max]) => number >= Number(min) && number <= Number(max)
            );
            if (!inside) return "outOfRange";
        }
    }
    return null;
}

export const setVarSchema = z
    .object({ name: nutName, value: z.string().max(64, "tooLong") })
    .strict();

/** The name a machine daemon runs an SNMP UPS under: `snmp-` and the 64-bit
 *  FNV-1a hash of its address, exactly as `SnmpSource::name` in hostd. */
export function snmpUpsName(address: string): string {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(address)) {
        hash ^= BigInt(byte);
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return `snmp-${hash.toString(16).padStart(16, "0")}`;
}
