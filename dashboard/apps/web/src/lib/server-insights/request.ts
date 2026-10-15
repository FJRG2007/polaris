/**
 * The server list a compare or insights request names, checked before anything
 * is read: `local` or a host id, comma-separated, no repeats, at most `max`.
 */

import { z } from "zod";
import { LOCAL_SERVER_ID } from "@polaris/core";
import { RANGE_ORDER, type RangePreset } from "@/lib/metrics-shared";

/** The most servers one comparison draws on a shared axis. */
export const COMPARE_MAX = 4;

/** The most servers one insights read covers. */
export const INSIGHTS_MAX = 100;

const serverId = z.union([z.literal(LOCAL_SERVER_ID), z.string().uuid()]);

export function serverIdsSchema(max: number) {
    return z
        .string()
        .transform((raw) => [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))])
        .pipe(z.array(serverId).min(1).max(max));
}

export const rangeSchema = z
    .string()
    .nullable()
    .transform((value) => (value ?? "1d") as string)
    .pipe(z.enum(RANGE_ORDER as [RangePreset, ...RangePreset[]]));
