/**
 * The settings a service builds from, as the screen and the server both check
 * them, and the fixes a failed deploy's "Likely cause" sends back.
 */

import { z } from "zod";
import { envValueMessage, hasControlCharacter } from "../env-values.js";

/** The runtime version a service builds on: "22", "3.12", "1.23.4". */
export const runtimeVersionSchema = z
    .string()
    .trim()
    .max(16)
    .regex(/^\d{1,3}(?:\.\d{1,3}){0,2}$/, "Use a version like 22, 3.12 or 1.23");

/** One line of shell, as a service's build or start command is stored. */
export const serviceCommandSchema = z
    .string()
    .trim()
    .max(1000)
    .refine((value) => !/[\r\n\0]/.test(value), "Keep the command on one line");

/** A variable name the service can hold. */
export const variableNameSchema = z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Letters, digits and underscores, not starting with a digit");

/**
 * A fix from a failed deploy's "Likely cause": the setting to change and the value
 * the reader confirmed or typed.
 */
export const deployFixInputSchema = z.union([
    z.object({ kind: z.literal("set-port"), port: z.number().int().min(1).max(65535) }),
    z.object({
        kind: z.literal("set-start-command"),
        value: serviceCommandSchema.refine((value) => value.length > 0, "Name the command that starts it")
    }),
    // Empty clears it, which is the fix when the command names a script that does not exist.
    z.object({ kind: z.literal("set-build-command"), value: serviceCommandSchema }),
    z.object({ kind: z.literal("set-root-directory"), value: z.string().trim().max(200) }),
    z.object({ kind: z.literal("set-runtime-version"), version: runtimeVersionSchema }),
    z
        .object({
            kind: z.literal("add-variable"),
            name: variableNameSchema,
            // Null with `generate` is a random secret made on the server.
            value: z.string().max(10_000).nullable(),
            generate: z.boolean()
        })
        .refine((fix) => fix.generate || (fix.value !== null && fix.value.length > 0), {
            message: "Give the variable a value",
            path: ["value"]
        })
        .superRefine((fix, ctx) => {
            if (!fix.generate && fix.value !== null && hasControlCharacter(fix.value)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: envValueMessage(fix.name), path: ["value"] });
            }
        }),
    z.object({ kind: z.literal("use-detected-build") })
]);
export type DeployFixInput = z.infer<typeof deployFixInputSchema>;
