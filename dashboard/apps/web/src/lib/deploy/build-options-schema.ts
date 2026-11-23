/**
 * A Dockerfile build's target stage and ARG values, as the settings form and its
 * action both take them. One normalizer for both sides: names and values are
 * trimmed, and an empty row is dropped rather than refused.
 */

import { z } from "zod";

export const MAX_BUILD_ARGS = 64;
export const MAX_BUILD_ARG_VALUE = 4096;

/** What `FROM ... AS <stage>` can name, and the host daemon accepts. */
const STAGE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface BuildArgRow {
    readonly key: string;
    readonly value: string;
}

export interface BuildOptionsInput {
    readonly targetStage: string;
    readonly args: readonly BuildArgRow[];
}

export function normalizeBuildOptions(input: BuildOptionsInput): BuildOptionsInput {
    return {
        targetStage: input.targetStage.trim(),
        args: input.args
            .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
            .filter((row) => row.key !== "" || row.value !== "")
    };
}

/** The bare shape a client sends, before normalizing: bounded strings and rows,
 *  so an oversized body is refused before anything else reads it. */
export const buildOptionsShape = z.object({
    targetStage: z.string().max(256),
    args: z
        .array(z.object({ key: z.string().max(256), value: z.string().max(MAX_BUILD_ARG_VALUE * 2) }))
        .max(MAX_BUILD_ARGS * 2)
});

export const buildOptionsSchema = z
    .object({
        targetStage: z.string().refine((value) => value === "" || STAGE.test(value), "stage"),
        args: z
            .array(
                z.object({
                    key: z.string().regex(ARG_NAME, "name"),
                    value: z
                        .string()
                        .max(MAX_BUILD_ARG_VALUE, "value")
                        .refine((value) => !CONTROL.test(value), "value")
                })
            )
            .max(MAX_BUILD_ARGS, "count")
    })
    .superRefine((value, ctx) => {
        const seen = new Set<string>();
        value.args.forEach((row, index) => {
            if (seen.has(row.key)) ctx.addIssue({ code: "custom", path: ["args", index, "key"], message: "duplicate" });
            seen.add(row.key);
        });
    });

/** Why a form value does not validate, as one of the reasons the card names. */
export function buildOptionsProblem(input: BuildOptionsInput): "stage" | "name" | "value" | "count" | "duplicate" | null {
    const parsed = buildOptionsSchema.safeParse(normalizeBuildOptions(input));
    if (parsed.success) return null;
    const message = parsed.error.issues[0]?.message;
    return message === "stage" || message === "name" || message === "value" || message === "count" || message === "duplicate"
        ? message
        : "value";
}

/**
 * The options a deploy runs with, from the stored build config. A row older
 * than this code, or edited by hand, that no longer validates is no option: a
 * build is never handed something the form would have refused.
 */
export function storedBuildOptions(build: Record<string, unknown>): {
    targetStage?: string;
    buildArgs?: Record<string, string>;
} {
    const view = buildOptionsView(build);
    return {
        ...(view.targetStage ? { targetStage: view.targetStage } : {}),
        ...(view.args.length > 0 ? { buildArgs: Object.fromEntries(view.args.map((row) => [row.key, row.value])) } : {})
    };
}

/** The stored options as the form shows them. */
export function buildOptionsView(build: Record<string, unknown>): BuildOptionsInput {
    const rawArgs = build.buildArgs;
    const args =
        rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? Object.entries(rawArgs as Record<string, unknown>).map(([key, value]) => ({
                  key,
                  value: typeof value === "string" ? value : ""
              }))
            : [];
    const candidate = normalizeBuildOptions({
        targetStage: typeof build.targetStage === "string" ? build.targetStage : "",
        args
    });
    const parsed = buildOptionsSchema.safeParse(candidate);
    return parsed.success ? parsed.data : { targetStage: "", args: [] };
}
