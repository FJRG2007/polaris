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

export const serverOptionsInput = z
    .object({
        query: z.string().trim().max(120).default(""),
        cursor: z.string().max(2048).nullable().default(null),
        limit: z.number().int().min(1).max(50).default(50),
        /** Read these back by id - how the page names, or misses, a chosen server. */
        ids: z.array(id).min(1).max(50).optional()
    })
    .strict();

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

/** A sidecar on the image list, and the feature the screen says started it. */
export const sidecarInput = z.object({
    feature: z.enum([
        "tunnel-ngrok",
        "tunnel-cloudflare",
        "share-tunnel",
        "backup-tunnel",
        "app-tunnel-named",
        "app-tunnel-quick",
        "app-tunnel-ngrok"
    ]),
    project: z
        .string()
        .trim()
        .max(64)
        .regex(/^polaris-[a-z0-9-]{1,48}$/)
});

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
export const restartInput = z.object({
    targetId: id,
    schedule: z.boolean(),
    /** A minute from now instead of 04:30; only with `schedule`. */
    now: z.boolean().optional()
});

/** A package name as dpkg and rpm write them; the host daemon checks the same. */
export const packageName = z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9+._-]*$/);
/** A package version as dpkg and rpm write them (epoch, `~` and `:` included). */
export const packageVersion = z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.+~:_-]*$/);

export const packageInput = z.object({ targetId: id, package: packageName }).strict();
export const holdInput = packageInput.extend({ hold: z.boolean() }).strict();
export const rollbackInput = packageInput.extend({ version: packageVersion }).strict();

/** One port as the daemon takes it, `tcp:22`. */
export const portWord = z
    .string()
    .trim()
    .regex(/^(tcp|udp):[1-9][0-9]{0,4}$/)
    .refine((word) => Number(word.split(":")[1]) <= 65535);
export const firewallInput = z.object({ targetId: id }).strict();
export const firewallApplyInput = z
    .object({ targetId: id, keep: z.array(portWord).max(256) })
    .strict();

export const sshInput = z.object({ targetId: id }).strict();

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
