/**
 * What an operator sets for a server's challenges, as a schema the screen and
 * the actions both validate with.
 *
 * Every field has a default, so a server that never opened the screen, or saved
 * it with an older version, reads as a whole setup - switched off until the
 * operator switches it on.
 */

import { z } from "zod";
import * as catalog from "./catalog";
import { rewardItemSchema } from "../events/catalog";

/** Where the settings live in the install's config. Written by the screen. */
export const CHALLENGES_KEY = "challenges";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A time zone the runtime can compute in, `Europe/Madrid` or `UTC`. */
function knownZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const items = z.array(rewardItemSchema).max(6, "errors.itemsMax").default([]);
const levels = z.number().int().min(0).max(100, "errors.levelsMax");
const points = z.number().int().min(0).max(10_000, "errors.pointsMax");

export const payoutSchema = z.object({
    points: points.default(0),
    levels: levels.default(0),
    items
});
export type Payout = z.infer<typeof payoutSchema>;

const payout = (value: { points?: number; levels?: number; items?: z.input<typeof items> }) =>
    payoutSchema.default(value);

export const milestoneSchema = z.object({
    tier: z.number().int().min(1).max(100),
    levels: levels.default(0),
    items
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const goalSchema = z.object({
    id: z.string().min(1).max(64),
    template: z.string().min(1).max(8),
    /** The whole server's target, in the template's own unit figures. */
    target: z.number().int().min(1).max(1_000_000_000),
    /** The first day it runs, in the server's time zone. */
    start: z.string().regex(DAY, "errors.dateFormat"),
    days: z.number().int().min(1, "errors.daysMin").max(31, "errors.daysMax").default(7),
    /** The least share of the goal, in percent, that earns a tier's reward. */
    minShare: z.number().min(0).max(50).default(2),
    /** What each of the five tiers gives every contributor. */
    rewards: z.array(payoutSchema).length(5)
});
export type Goal = z.infer<typeof goalSchema>;

const categorySchema = z.object({
    enabled: z.boolean().default(true),
    weight: z.number().min(0).max(5).default(1)
});

const baseSchema = z.object({
        enabled: z.boolean().default(false),
        /** What the players read. */
        language: z.enum(["en", "es"]).default("en"),
        timezone: z.string().trim().min(1).max(64).refine(knownZone, "errors.timezone").default("UTC"),
        /** When a day's challenges change, in the time zone. */
        resetAt: z.string().regex(TIME, "errors.timeFormat").default("00:00"),
        /** The day a week's challenges change. 0 is Sunday. */
        weekDay: z.number().int().min(0).max(6).default(1),
        layers: z
            .object({
                daily: z.boolean().default(true),
                weekly: z.boolean().default(true),
                season: z.boolean().default(true),
                card: z.boolean().default(true),
                community: z.boolean().default(true)
            })
            .default({}),
        categories: z
            .record(z.enum(catalog.CATEGORIES), categorySchema)
            .default({})
            .transform((value) =>
                Object.fromEntries(
                    catalog.CATEGORIES.map((category) => [category, categorySchema.parse(value[category] ?? {})])
                ) as Record<catalog.Category, z.infer<typeof categorySchema>>
            ),
        /** Templates switched off one by one. */
        disabled: z.array(z.string().max(8)).max(100).default([]),
        /** Every target times this. */
        multiplier: z.number().min(0.25).max(4).default(1),
        /** Targets move up or down with how many finish them. */
        pace: z.boolean().default(true),
        rerolls: z
            .object({
                daily: z.number().int().min(0).max(5).default(1),
                weekly: z.number().int().min(0).max(5).default(1)
            })
            .default({}),
        rewards: z
            .object({
                daily: z
                    .object({
                        easy: payout({ points: 10, levels: 1 }),
                        medium: payout({ points: 20, levels: 2 }),
                        hard: payout({ points: 40, levels: 3 })
                    })
                    .default({}),
                weekly: z
                    .object({
                        easy: payout({ points: 60, levels: 3 }),
                        medium: payout({ points: 100, levels: 5 }),
                        hard: payout({ points: 150, levels: 8 })
                    })
                    .default({}),
                dailySweep: payout({ points: 15 }),
                weeklySweep: payout({
                    points: 50,
                    items: [{ id: "minecraft:experience_bottle", count: 8 }]
                }),
                square: payout({ points: 30, levels: 2 }),
                line: payout({ points: 50 }),
                card: payout({ points: 200, items: [{ id: "minecraft:diamond", count: 2 }] }),
                /** Bonus points at the streak milestones of 3, 7, 14 and 30 days. */
                streak: z
                    .array(points)
                    .length(catalog.STREAK_MILESTONES.length)
                    .default([20, 50, 100, 200]),
                /** Points for coming back after a week away, on the first challenge done. */
                comeback: points.default(25)
            })
            .default({}),
        season: z
            .object({
                /** How long a season runs. */
                weeks: z.number().int().min(4, "errors.weeksMin").max(8, "errors.weeksMax").default(6),
                /** The day the first season began; empty for the day they were switched on. */
                start: z.string().regex(DAY, "errors.dateFormat").or(z.literal("")).default(""),
                tiers: z.number().int().min(10).max(100).default(40),
                pointsPerTier: z.number().int().min(10).max(10_000).default(100),
                /** Levels at every tier. Items come only at the milestones below. */
                levelsPerTier: levels.default(2),
                milestones: z
                    .array(milestoneSchema)
                    .max(20)
                    .default([
                        { tier: 10, levels: 0, items: [{ id: "minecraft:diamond", count: 3 }] },
                        { tier: 20, levels: 0, items: [{ id: "minecraft:emerald", count: 16 }] },
                        { tier: 30, levels: 0, items: [{ id: "minecraft:diamond", count: 5 }] },
                        { tier: 40, levels: 0, items: [{ id: "minecraft:diamond_block", count: 1 }] }
                    ]),
                /** The most points one player can earn in a day. */
                dailyCap: z.number().int().min(10).max(10_000).default(200),
                /** The last two weeks pay x1.5 to players below the middle tier. */
                catchUp: z.boolean().default(true)
            })
            .default({}),
        eligibility: z
            .object({
                /** Minutes played on this server before challenges are dealt. */
                minMinutes: z.number().int().min(0).max(600).default(10),
                /** Only players linked to a Polaris account. */
                linkedOnly: z.boolean().default(false)
            })
            .default({}),
        display: z
            .object({
                joinMessage: z.boolean().default(true),
                actionBar: z.boolean().default(true),
                bossBar: z.boolean().default(true)
            })
            .default({}),
        antiExploit: z
            .object({
                /** Nothing credited while a player stands still. */
                afk: z.boolean().default(true),
                /** How long without moving or turning is standing still. */
                afkMinutes: z.number().int().min(1).max(15).default(2),
                /** A player caught by Anti X-Ray loses the day's mining. */
                xray: z.boolean().default(true),
                /** The per-minute ceilings on farmable statistics. */
                caps: z.boolean().default(true)
            })
            .default({}),
        community: z
            .object({
                /** A weekly goal drawn by Polaris whenever none is running. */
                auto: z.boolean().default(true),
                goals: z.array(goalSchema).max(20, "errors.goalsMax").default([])
            })
            .default({}),
        /** One season across several servers, for players linked to a Polaris account. */
        shared: z
            .object({
                enabled: z.boolean().default(false),
                group: z
                    .string()
                    .trim()
                    .max(40, "errors.groupMax")
                    .regex(/^[A-Za-z0-9 _-]*$/, "errors.groupChars")
                    .default("")
            })
            .default({})
    });

export const settingsSchema = baseSchema.superRefine((value, context) => {
        if (value.shared.enabled && value.shared.group.length === 0) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["shared", "group"],
                message: "errors.groupRequired"
            });
        }
        value.community.goals.forEach((goal, index) => {
            const template = catalog.templateOf(goal.template);
            if (!template || !template.layers.includes("community")) {
                context.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["community", "goals", index, "template"],
                    message: "errors.goalTemplate"
                });
            }
        });
        const tiers = value.season.milestones.map((one) => one.tier);
        if (new Set(tiers).size !== tiers.length) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["season", "milestones"],
                message: "errors.milestoneTwice"
            });
        }
    });

export type ChallengeSettings = z.infer<typeof settingsSchema>;

/** The stored settings, whole: a server without any reads as switched off,
 *  in the time zone and language its events already use. */
export function readSettings(
    config: Record<string, unknown>,
    defaults: { timezone?: string; language?: "en" | "es" } = {}
): ChallengeSettings {
    const raw = config[CHALLENGES_KEY];
    // Without the cross-field checks: a goal whose challenge a later version
    // dropped must not switch the whole thing off.
    const parsed = baseSchema.safeParse(raw ?? {});
    if (parsed.success && raw !== undefined) return parsed.data;
    return settingsSchema.parse({
        timezone: defaults.timezone && knownZone(defaults.timezone) ? defaults.timezone : "UTC",
        language: defaults.language ?? "en"
    });
}

/** The templates this server may deal, before version and budget. */
export function allowed(settings: ChallengeSettings, template: catalog.Template): boolean {
    const category = settings.categories[template.category];
    return category.enabled && category.weight > 0 && !settings.disabled.includes(template.id);
}
