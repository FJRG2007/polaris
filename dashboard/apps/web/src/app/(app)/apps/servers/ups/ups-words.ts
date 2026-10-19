/**
 * What the UPS screens share: the shapes the two routes answer with, and how
 * a reading turns into a status chip. Client-safe - types only from the service.
 */

import type { UpsReading } from "@/lib/ups/ups-reading";
import type { UsbDiscovery, UpsReadResult, UpsView } from "@/lib/ups/ups-service";

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
