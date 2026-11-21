/**
 * What an administrator may save as the satellite imagery choice. Shared by the
 * Integrations dialog (checked as it is typed) and the server action (checked
 * again before anything is kept). Pure; safe on both sides.
 */

import { z } from "zod";

/** A provider key: printable URL-safe ASCII, no spaces. Blank means "keep the stored one". */
export const imageryKeySchema = z
    .string()
    .trim()
    .min(16)
    .max(2048)
    .regex(/^[A-Za-z0-9._~+/=-]+$/);

export const imageryChoiceSchema = z.discriminatedUnion("provider", [
    z.object({ provider: z.literal("default") }),
    z.object({
        provider: z.enum(["maptiler", "esri"]),
        apiKey: z.string().trim().pipe(z.union([z.literal(""), imageryKeySchema])).optional()
    })
]);
export type ImageryChoice = z.infer<typeof imageryChoiceSchema>;
