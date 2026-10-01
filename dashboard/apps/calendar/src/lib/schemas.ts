/**
 * What the Calendar's screens send, validated the same way on both sides: the
 * form checks it as it is typed, the action checks it again before anything
 * runs. Events have their own schema in the engine (`eventInputSchema`); these
 * are the calendars, shares, sources and pages around them.
 *
 * Pure: shared by screens and server.
 */

import { z } from "zod";

/** Trim, collapse inner runs of spaces, drop control characters. */
export function cleanText(value: string): string {
    return value
        .normalize("NFC")
        .replace(/[\u0000-\u001f\u007f​-‍﻿]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** A one-line name: cleaned, then required and bounded. */
export const nameSchema = z.string().transform(cleanText).pipe(z.string().min(1).max(120));

/** A CSS hex colour. */
export const colorSchema = z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.string().regex(/^#[0-9a-f]{6}$/));

/** The colours offered for a calendar: the blue a new calendar gets, d3's ten
 *  categorical colours, and a lighter blue. */
export const CALENDAR_COLORS = [
    "#2563eb",
    "#1f77b4",
    "#2ca02c",
    "#17becf",
    "#9467bd",
    "#e377c2",
    "#d62728",
    "#ff7f0e",
    "#bcbd22",
    "#8c564b",
    "#7f7f7f",
    "#3b82f6"
] as const;

/** A zone Intl knows, or empty for "the reader's". */
export const zoneSchema = z
    .string()
    .trim()
    .max(64)
    .refine((zone) => zone === "" || isKnownZone(zone));

/** Whether Intl can read times in this zone. */
export function isKnownZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

const alarmMinutes = z.array(z.number().int().min(-40320).max(40320)).max(5);

export const calendarInputSchema = z.object({
    name: nameSchema,
    color: colorSchema,
    description: z
        .string()
        .max(2000)
        .transform((value) => value.trim()),
    timezone: zoneSchema,
    components: z.enum(["VEVENT", "VTODO", "VEVENT,VTODO"])
});

export type CalendarInput = z.infer<typeof calendarInputSchema>;

export const calendarPatchSchema = z
    .object({
        name: nameSchema,
        color: colorSchema,
        description: z
            .string()
            .max(2000)
            .transform((value) => value.trim()),
        timezone: zoneSchema,
        transparent: z.boolean(),
        alarmsMuted: z.boolean(),
        defaultAlarms: z.object({ timed: alarmMinutes, allDay: alarmMinutes })
    })
    .partial()
    .strict();

export type CalendarPatch = z.infer<typeof calendarPatchSchema>;

export const displayPatchSchema = z
    .object({
        hidden: z.boolean(),
        color: colorSchema.nullable()
    })
    .partial()
    .strict();

export const uuidSchema = z.string().uuid();

export const shareInputSchema = z.object({
    calendarId: uuidSchema,
    target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("user"), id: uuidSchema }),
        z.object({ kind: z.literal("team"), id: uuidSchema })
    ]),
    access: z.enum(["freebusy", "read", "write", "manage"])
});

export const publishInputSchema = z.object({
    calendarId: uuidSchema,
    mode: z.enum(["", "busy", "full"])
});

/**
 * An address typed for a feed or a server. `webcal://` and `webcals://` are
 * read as https, as a bare host is. The result must still be a real http(s)
 * URL whose host has a dot or is an IP - `https://asdf` is not an address.
 */
export const addressSchema = z
    .string()
    .trim()
    .max(2000)
    .transform((value) => {
        const swapped = value.replace(/^webcals?:\/\//i, "https://");
        return /^[a-z][a-z0-9+.-]*:\/\//i.test(swapped) ? swapped : `https://${swapped}`;
    })
    .pipe(
        z
            .string()
            .url()
            // Runs even when `.url()` above failed (zod 3 keeps refining a
            // value that already has an issue), so it must not throw.
            .refine((value) => {
                let url: URL;
                try {
                    url = new URL(value);
                } catch {
                    return false;
                }
                if (url.protocol !== "https:" && url.protocol !== "http:") return false;
                if (url.username || url.password) return false;
                const host = url.hostname;
                return host.includes(".") || host.includes(":") || host === "localhost";
            })
    );

export const icsSourceSchema = z.object({
    url: addressSchema,
    name: nameSchema,
    color: colorSchema,
    refreshMinutes: z
        .number()
        .int()
        .min(15)
        .max(7 * 24 * 60)
});

export const caldavSourceSchema = z.object({
    url: addressSchema,
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(512)
});

export const importInputSchema = z.object({
    /** An existing calendar, or a new one with this name. */
    target: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("existing"), calendarId: uuidSchema }),
        z.object({ kind: z.literal("new"), name: nameSchema, color: colorSchema })
    ]),
    /** The file's text. 10 MiB is far more than any real calendar export. */
    text: z
        .string()
        .min(1)
        .max(10 * 1024 * 1024)
});
