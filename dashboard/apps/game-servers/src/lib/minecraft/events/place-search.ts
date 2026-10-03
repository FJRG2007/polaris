/**
 * Where an event looked for its place, and what stopped it at each try - kept in
 * the run as it looks, and summed up in the history when nowhere would do, so
 * the operator reads where it looked and what was in the way instead of only
 * that nothing was found.
 *
 * Pure, and browser-safe: the screen words the summary.
 */

import { z } from "zod";

/** Why there was nowhere to hold an event, as the history says it (and
 *  `messages.ts` translates it). */
export const NO_GROUND = "No dry ground was found for it near the players";
export const NO_AIR = "No open air was found for it near the players";
export const NOBODY_IN_OVERWORLD = "Nobody is in the Overworld to hold it near";

/** What stopped one try, in the operator's terms. */
export const PLACE_REFUSALS = [
    /** No column far enough from every home. */
    "homes",
    /** The marker never came down: no ground there, or not loaded. */
    "noGround",
    /** Open water, where it needs land. */
    "water",
    /** Somebody's build. */
    "built",
    /** Too rough to stand on: too steep, or among trees. */
    "uneven",
    /** Something in the air the event needs - a tree, a hill, a build. */
    "occupied",
    /** Above the world's build limit. */
    "tooHigh",
    /** The server would not let blocks be placed there - a protected area. */
    "refused",
    /** Its chunks did not load in time. */
    "unloaded"
] as const;

export type PlaceRefusal = (typeof PLACE_REFUSALS)[number];

export const placeTrySchema = z.object({
    x: z.number(),
    z: z.number(),
    why: z.enum(PLACE_REFUSALS)
});

export type PlaceTry = z.infer<typeof placeTrySchema>;

/** Where it looked from: the fixed point, or the player it looked round. */
export const placeFromSchema = z.object({
    x: z.number(),
    z: z.number(),
    near: z.string().nullable()
});

export type PlaceFrom = z.infer<typeof placeFromSchema>;

/** The most tries a run keeps: every try of both of a king of the hill's searches. */
export const MOST_TRIES_KEPT = 40;

/** A try added to what a run keeps, the oldest let go of past the most kept. */
export function withTry(log: readonly PlaceTry[], one: PlaceTry): PlaceTry[] {
    return [...log, one].slice(-MOST_TRIES_KEPT);
}

/** The history's summary of a search that found nowhere. */
export const searchSummarySchema = z.object({
    from: placeFromSchema.nullable(),
    tries: z.number().int(),
    /** How far from where it looked from the furthest try was, in blocks. */
    reach: z.number().int(),
    /** Each reason, with how many tries it stopped, most first. */
    why: z.array(z.object({ why: z.enum(PLACE_REFUSALS), count: z.number().int() })),
    /** A king of the hill looked over the sea too, for a platform of its own. */
    overSea: z.boolean().default(false)
});

export type SearchSummary = z.infer<typeof searchSummarySchema>;

export function summarize(
    from: PlaceFrom | null,
    log: readonly PlaceTry[],
    overSea = false
): SearchSummary {
    const counts = new Map<PlaceRefusal, number>();
    for (const one of log) counts.set(one.why, (counts.get(one.why) ?? 0) + 1);
    const reach = from
        ? Math.round(Math.max(0, ...log.map((one) => Math.hypot(one.x - from.x, one.z - from.z))))
        : 0;
    return {
        from,
        tries: log.length,
        reach,
        why: [...counts]
            .map(([why, count]) => ({ why, count }))
            .sort((left, right) => right.count - left.count),
        overSea
    };
}
