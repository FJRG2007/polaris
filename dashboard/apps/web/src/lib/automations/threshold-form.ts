/**
 * The threshold trigger's form, judged by the same schema save and publish use
 * (`core.thresholdConfigSchema`), field by field: a field not filled in yet is
 * incomplete (marked required, never "not valid"), one filled in wrongly is
 * invalid. Pure, so the screen and its test read one rule.
 */

import * as core from "@polaris/core";

export const THRESHOLD_FIELDS = ["source", "subjectId", "comparator", "value", "streak"] as const;
export type ThresholdField = (typeof THRESHOLD_FIELDS)[number];
export type FieldState = "ok" | "required" | "invalid";

/** Nothing filled in. A number box with letters in it holds NaN: filled in, wrongly. */
function empty(value: unknown): boolean {
    return (
        value === undefined || value === null || (typeof value === "string" && value.trim() === "")
    );
}

/** Each field's state for a config as the form holds it. */
export function thresholdFieldStates(config: unknown): Record<ThresholdField, FieldState> {
    const states = Object.fromEntries(THRESHOLD_FIELDS.map((field) => [field, "ok"])) as Record<
        ThresholdField,
        FieldState
    >;
    const parsed = core.thresholdConfigSchema.safeParse(config);
    if (parsed.success) return states;
    const values = (config ?? {}) as Record<string, unknown>;
    for (const issue of parsed.error.issues) {
        const field = issue.path[0] as ThresholdField;
        if (!THRESHOLD_FIELDS.includes(field)) continue;
        states[field] = empty(values[field]) ? "required" : "invalid";
    }
    return states;
}

/** What a number box holds, as the config stores it: nothing typed is no value, not zero. */
export function numberFromInput(text: string): number | undefined {
    const trimmed = text.trim().replace(",", ".");
    if (trimmed === "") return undefined;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : Number.NaN;
}

/** "> 90", ">= 90", "< 20", "<= 20": how a comparator reads on a node and in the history. */
export function comparatorSymbol(comparator: string): string {
    return comparator === "gte"
        ? ">="
        : comparator === "lt"
          ? "<"
          : comparator === "lte"
            ? "<="
            : ">";
}

/** A source id's catalog key under `automations.threshold.sources`. */
export function sourceKey(source: string): string {
    return `threshold.sources.${source.replace(/\./g, "_")}`;
}
