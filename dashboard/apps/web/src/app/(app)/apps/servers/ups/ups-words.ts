/**
 * What the UPS screens share: the shapes the two routes answer with, and how
 * a reading turns into a status chip. Client-safe - types only from the service.
 */

import type { UpsReading } from "@/lib/ups/ups-reading";
import type { UsbDiscovery, UpsReadResult, UpsView } from "@/lib/ups/ups-service";
import type { EnergyBucket, UpsActionView, UpsAnalyticsRow, UpsEventView } from "@/lib/ups/ups-data";

export interface UpsListAnswer {
    ups: { ups: UpsView; result: UpsReadResult }[];
    usb: UsbDiscovery;
}

export interface UpsHistoryPoint {
    ts: string;
    charge: number | null;
    load: number | null;
    runtimeS: number | null;
    inputV: number | null;
    inputHz: number | null;
    outputV: number | null;
    batteryV: number | null;
    powerW: number | null;
}

export interface UpsDetailAnswer {
    ups: UpsView;
    result: UpsReadResult;
    history: UpsHistoryPoint[];
}

/** A machine a UPS can be reached through or protect, by its metric subject id. */
export interface UpsMachine {
    id: string;
    name: string;
}

export type UpsStatusKey =
    | "online"
    | "onBattery"
    | "lowBattery"
    | "replaceBattery"
    | "overloaded"
    | "unknown";

export type UpsTone = "success" | "warning" | "danger" | "neutral";

/** The one chip a reading earns, the most urgent first. */
export function upsStatus(reading: UpsReading | null): { key: UpsStatusKey; tone: UpsTone } {
    if (!reading) return { key: "unknown", tone: "neutral" };
    const status = reading.status;
    if (status.lowBattery && status.onBattery) return { key: "lowBattery", tone: "danger" };
    if (status.onBattery) return { key: "onBattery", tone: "warning" };
    if (status.overloaded) return { key: "overloaded", tone: "danger" };
    if (status.replaceBattery) return { key: "replaceBattery", tone: "warning" };
    if (status.online) return { key: "online", tone: "success" };
    return { key: "unknown", tone: "neutral" };
}

/** Whole numbers for percentages and minutes; one decimal for volts and hertz. */
export function rounded(value: number | null, decimals = 0): string | null {
    if (value === null || !Number.isFinite(value)) return null;
    return decimals === 0 ? String(Math.round(value)) : value.toFixed(decimals);
}

export function minutesLeft(runtimeS: number | null): number | null {
    return runtimeS === null ? null : Math.max(0, Math.round(runtimeS / 60));
}

export interface UpsEnergyAnswer {
    buckets: EnergyBucket[];
    totals: { kwh: number; costs: { currency: string; cost: number }[] };
}

export interface UpsEventsAnswer {
    events: UpsEventView[];
    more: boolean;
    open: number;
}

export interface UpsActionsAnswer {
    actions: UpsActionView[];
}

export interface UpsAnalyticsAnswer {
    rows: UpsAnalyticsRow[];
    daily: (EnergyBucket & { upsId: string })[];
}

/** An amount in a currency, in the reader's own number format. */
export function formatMoney(amount: number, currency: string): string {
    try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
        return `${amount.toFixed(2)} ${currency}`;
    }
}

/** Commands that cut the power, stop protecting or drain the battery. */
export function isDangerousCommand(name: string): boolean {
    return /^(load\.off|shutdown\.|bypass\.start|calibrate\.start)/.test(name);
}

const COMMAND_LABELS = {
    "beeper.enable": "ups.commands.names.beeperEnable",
    "beeper.disable": "ups.commands.names.beeperDisable",
    "beeper.mute": "ups.commands.names.beeperMute",
    "beeper.toggle": "ups.commands.names.beeperToggle",
    "test.battery.start.quick": "ups.commands.names.testQuick",
    "test.battery.start.deep": "ups.commands.names.testDeep",
    "test.battery.stop": "ups.commands.names.testStop",
    "test.panel.start": "ups.commands.names.panelStart",
    "test.panel.stop": "ups.commands.names.panelStop",
    "calibrate.start": "ups.commands.names.calibrateStart",
    "calibrate.stop": "ups.commands.names.calibrateStop",
    "load.on": "ups.commands.names.loadOn",
    "load.off": "ups.commands.names.loadOff",
    "shutdown.return": "ups.commands.names.shutdownReturn",
    "shutdown.stayoff": "ups.commands.names.shutdownStayoff",
    "shutdown.stop": "ups.commands.names.shutdownStop",
    "shutdown.reboot": "ups.commands.names.shutdownReboot",
    "bypass.start": "ups.commands.names.bypassStart",
    "bypass.stop": "ups.commands.names.bypassStop"
} as const;

/** The words for a command NUT documents, or null to show its own name. */
export function commandLabelKey(name: string): (typeof COMMAND_LABELS)[keyof typeof COMMAND_LABELS] | null {
    return (COMMAND_LABELS as Record<string, (typeof COMMAND_LABELS)[keyof typeof COMMAND_LABELS]>)[name] ?? null;
}
