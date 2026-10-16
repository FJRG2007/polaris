/**
 * The pieces every automation's definition is built from, whatever it automates:
 * what any block may carry besides its own fields (a name of its own, a note, a
 * switch), how long something lasts, how a number is compared, which things a
 * block is about, and whether one of many is enough.
 *
 * Shapes only, plus the pure operations an editor needs on a list of blocks -
 * copy one with fresh ids, put it after another, move it. Nothing here knows a
 * kind: a device for Places, a header for Mail. Every surface spreads
 * `blockBaseShape` into its own node schemas, so a block's name and note are
 * kept through a save on all of them.
 */

import { z } from "zod";
import { automationNodeId } from "./automation-nodes.js";

export const BLOCK_LIMITS = {
    /** A block's own name, shown in place of its sentence. */
    alias: 80,
    /** A note on a block, shown behind an icon on its row. */
    note: 250
} as const;

/** What any block may carry besides its own fields. All optional, so every
 *  definition saved before these existed still reads. */
export const blockBaseShape = {
    alias: z.string().trim().max(BLOCK_LIMITS.alias).optional(),
    note: z.string().trim().max(BLOCK_LIMITS.note).optional(),
    /** `false` keeps the block in the definition but skips it. Absent is on. */
    enabled: z.boolean().optional()
};

export type BlockBase = {
    alias?: string;
    note?: string;
    enabled?: boolean;
};

/** Whether a block takes part when the automation runs. */
export function blockEnabled(block: BlockBase): boolean {
    return block.enabled !== false;
}

/** A length of time, in whole units. */
export const DURATION_UNITS = ["seconds", "minutes", "hours", "days"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

const UNIT_SECONDS: Record<DurationUnit, number> = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400
};

export const durationSchema = z.object({
    amount: z.number().int().min(0).max(100_000),
    unit: z.enum(DURATION_UNITS)
});
export type Duration = z.infer<typeof durationSchema>;

/** A duration before or after a moment ("15 minutes before sunset"). */
export const offsetSchema = durationSchema.extend({ direction: z.enum(["before", "after"]) });
export type Offset = z.infer<typeof offsetSchema>;

export function durationSeconds(duration: Duration): number {
    return duration.amount * UNIT_SECONDS[duration.unit];
}

/** The largest whole unit a number of seconds can be said in: 7200 -> 2 hours. */
export function durationOf(seconds: number): Duration {
    const whole = Math.max(0, Math.round(seconds));
    for (const unit of ["days", "hours", "minutes"] as const)
        if (whole > 0 && whole % UNIT_SECONDS[unit] === 0)
            return { amount: whole / UNIT_SECONDS[unit], unit };
    return { amount: whole, unit: "seconds" };
}

/** A number to compare against: a fixed one, or what another thing reads. */
export const thresholdValueSchema = z.union([
    z.object({ value: z.number() }),
    z.object({ ref: z.string().min(1).max(200) })
]);
export type ThresholdValue = z.infer<typeof thresholdValueSchema>;

/** How a reading is compared: past one value, or inside or outside two. */
export const thresholdSchema = z
    .discriminatedUnion("op", [
        z.object({ op: z.literal("above"), than: thresholdValueSchema }),
        z.object({ op: z.literal("below"), than: thresholdValueSchema }),
        z.object({
            op: z.literal("between"),
            low: thresholdValueSchema,
            high: thresholdValueSchema
        }),
        z.object({
            op: z.literal("outside"),
            low: thresholdValueSchema,
            high: thresholdValueSchema
        })
    ])
    .and(z.object({ unit: z.string().max(16).optional() }));
export type Threshold = z.infer<typeof thresholdSchema>;

/** Whether a number passes a threshold. A reference has no number of its own,
 *  so the caller resolves it first; an unresolved one never passes. */
export function passesThreshold(
    reading: number,
    threshold: Threshold,
    resolve: (value: ThresholdValue) => number | undefined = (value) =>
        "value" in value ? value.value : undefined
): boolean {
    const read = (value: ThresholdValue) => resolve(value);
    switch (threshold.op) {
        case "above": {
            const than = read(threshold.than);
            return than !== undefined && reading > than;
        }
        case "below": {
            const than = read(threshold.than);
            return than !== undefined && reading < than;
        }
        case "between":
        case "outside": {
            const low = read(threshold.low);
            const high = read(threshold.high);
            if (low === undefined || high === undefined) return false;
            const inside = reading > low && reading < high;
            return threshold.op === "between" ? inside : !inside;
        }
    }
}

/** Which things a block is about: one of them by id, or a set of them. */
export const targetRefSchema = z.object({
    kind: z.string().min(1).max(32),
    id: z.string().min(1).max(200)
});
export type TargetRef = z.infer<typeof targetRefSchema>;

/** When a block is about several things: does each one count, the first, or
 *  only all of them together. */
export const behaviourSchema = z.enum(["each", "first", "all"]);
export type Behaviour = z.infer<typeof behaviourSchema>;

/** For a condition about several things: any one of them, or all of them. */
export const quantifierSchema = z.enum(["any", "all"]);
export type Quantifier = z.infer<typeof quantifierSchema>;

/** A step that fails stops the run, unless it says to carry on. */
export const continueOnErrorShape = { continueOnError: z.boolean().optional() };

// --- the operations an editor makes on a list of blocks -----------------------

/**
 * A deep copy of a block with a fresh id on it and on everything inside it, so a
 * copy pasted beside the original - or into another automation - never shares
 * an id with anything. Only fields named `id` holding a string are renewed.
 */
export function withFreshIds<T>(block: T, nextId: () => string = automationNodeId): T {
    const visit = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== "object") return value;
        const copy: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>))
            copy[key] = key === "id" && typeof entry === "string" ? nextId() : visit(entry);
        return copy;
    };
    return visit(block) as T;
}

/** `items` with `added` put right after `index`; at the end when `index` is past
 *  it or negative means "at the start". */
export function insertAfter<T>(items: readonly T[], index: number, ...added: T[]): T[] {
    const at = Math.min(items.length, Math.max(0, index + 1));
    return [...items.slice(0, at), ...added, ...items.slice(at)];
}

/** `items` with the one at `from` moved by `by` places, kept inside the list. */
export function moveBy<T>(items: readonly T[], from: number, by: number): T[] {
    const to = Math.min(items.length - 1, Math.max(0, from + by));
    if (from < 0 || from >= items.length || to === from) return [...items];
    const next = [...items];
    const [moving] = next.splice(from, 1);
    next.splice(to, 0, moving as T);
    return next;
}

/** The text a block is shown as: its own name when it has one, else its
 *  sentence. */
export function blockTitle(block: BlockBase, sentence: string): string {
    const alias = block.alias?.trim();
    return alias ? alias : sentence;
}
