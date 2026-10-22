/**
 * Every input the app accepts, as a schema, and the one normalizer a folder
 * inside a volume goes through on both sides.
 */

import { z } from "zod";
import { QUARANTINE_DIR } from "./specs";

/**
 * A folder or file inside a volume, as one stored form: trimmed, no leading
 * `./` or `/`, single slashes, no trailing slash. Normalizing never makes a bad
 * path good: a `..` or a control character stays and is refused below.
 */
export function normalizeInnerPath(value: string): string {
    return value
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/{2,}/g, "/")
        .replace(/^(\.\/)+/, "")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
}

export const innerPathSchema = z
    .string()
    .max(512)
    .transform(normalizeInnerPath)
    .refine((path) => !/[\u0000-\u001f\u007f]/.test(path), "invalid")
    .refine((path) => path.split("/").every((part) => part !== ".." && part !== "."), "invalid")
    .refine((path) => path.split("/")[0] !== QUARANTINE_DIR, "invalid");

const id = z.string().uuid();

export const targetInput = z.object({ targetId: id });

export const malwareInput = z.object({
    targetId: id,
    volumes: z
        .array(z.object({ volumeId: id, subpath: innerPathSchema.default("") }))
        .min(1)
        .max(20)
});

export const filesInput = z.object({
    targetId: id,
    volumeId: id,
    subpath: innerPathSchema.default(""),
    mode: z.enum(["baseline", "check"])
});

export const imageInput = z.object({ targetId: id, applicationId: id });

/** One image a server runs, by its id. */
export const serverImageInput = z.object({
    targetId: id,
    imageId: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^sha256:[0-9a-f]{64}$/)
});

export const findingInput = z.object({ findingId: id });

export const quarantineInput = z.object({ quarantineId: id, op: z.enum(["restore", "delete"]) });

export const updatesInput = z.object({ targetId: id, enabled: z.boolean() });

/** How often a server is scanned by itself; 0 is never. */
export const SCHEDULE_HOURS = [0, 6, 12, 24, 168] as const;

export const scheduleInput = z.object({
    targetId: id,
    everyHours: z
        .number()
        .int()
        .refine((n) => (SCHEDULE_HOURS as readonly number[]).includes(n))
});

export const scanListInput = z.object({
    targetId: id,
    kind: z.enum(["malware", "files", "audit", "image", "deps"]).optional()
});

export const scanInput = z.object({ scanId: id });

/** The scan an alert opens; none means the newest one with a serious finding. */
export const focusInput = z.object({ scanId: id.nullable().default(null) }).strict();
