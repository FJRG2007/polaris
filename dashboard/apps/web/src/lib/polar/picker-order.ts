/**
 * The model picker's two per-person touches, shared by Chat and Code: the
 * order its providers and sources are listed in (dragged, or moved with the
 * up and down buttons), and the "Recent" group read from what the person
 * actually used. Pure and client-safe; the server stores the order on
 * `PolarPreference.sourceOrder` and reads the usage (`picker-prefs.ts`).
 *
 * Keys are the Code source keys (`code-sources.ts`): a chat provider is
 * `polar:<provider>`, so one order serves both pickers.
 */

import { z } from "zod";

/** The key a chat provider (a Polar source) is ordered by. */
export const polarSourceKey = (provider: string) => `polar:${provider}`;

/** More entries than anybody has providers; bounds what is stored. */
export const SOURCE_ORDER_MAX = 200;
/** How many models "Recent" offers. */
export const RECENT_MOST = 5;
/** How fast an old use stops counting, in days (half-life-like decay). */
const RECENT_DECAY_DAYS = 14;

export const sourceOrderSchema = z
    .array(z.string().trim().min(1).max(120))
    .max(SOURCE_ORDER_MAX)
    .transform((list) => [...new Set(list)]);

export const pickerOrderBodySchema = z.object({ order: sourceOrderSchema });

/** A model somebody used, with the source it came from. */
export interface RecentPick {
    readonly source: string;
    readonly provider: string;
    readonly model: string | null;
}

export interface PickerPrefs {
    readonly order: readonly string[];
    readonly recent: readonly RecentPick[];
}

/** `items` in the stored order: listed ones first by position, the rest after
 *  in their own order. Stable, so a search keeps its ranking within a group. */
export function applyOrder<T>(items: readonly T[], keyOf: (item: T) => string, order: readonly string[]): T[] {
    if (order.length === 0) return [...items];
    const position = new Map(order.map((key, index) => [key, index]));
    return items
        .map((item, index) => ({ item, index, at: position.get(keyOf(item)) }))
        .sort((left, right) => {
            if (left.at !== undefined && right.at !== undefined) return left.at - right.at;
            if (left.at !== undefined) return -1;
            if (right.at !== undefined) return 1;
            return left.index - right.index;
        })
        .map((entry) => entry.item);
}

/** The order after moving `key` to `to` among `visible` (what the picker
 *  shows now). Keys stored but not shown keep their place after them. */
export function moveTo(order: readonly string[], visible: readonly string[], key: string, to: number): string[] {
    const shown = applyOrder(visible, (entry) => entry, order).filter((entry) => entry !== key);
    if (!visible.includes(key)) return [...order];
    const index = Math.max(0, Math.min(to, shown.length));
    shown.splice(index, 0, key);
    return [...shown, ...order.filter((entry) => !visible.includes(entry))];
}

/** Moving one step up (-1) or down (+1). */
export function moveBy(order: readonly string[], visible: readonly string[], key: string, delta: number): string[] {
    const current = applyOrder(visible, (entry) => entry, order).indexOf(key);
    return current < 0 ? [...order] : moveTo(order, visible, key, current + delta);
}

/**
 * The models used most and most recently: each use counts less the older it
 * is, so a model used daily last week outranks one used twice this morning
 * only if it was used much more. One entry per source and model.
 */
export function rankRecent(
    uses: readonly (RecentPick & { at: Date })[],
    now: Date = new Date(),
    most: number = RECENT_MOST
): RecentPick[] {
    const scores = new Map<string, { pick: RecentPick; score: number; last: number }>();
    for (const use of uses) {
        const key = `${use.source}\u0000${use.model ?? ""}`;
        const age = Math.max(0, now.getTime() - use.at.getTime()) / 86_400_000;
        const weight = Math.pow(0.5, age / RECENT_DECAY_DAYS);
        const entry = scores.get(key);
        if (entry) {
            entry.score += weight;
            entry.last = Math.max(entry.last, use.at.getTime());
        } else {
            scores.set(key, {
                pick: { source: use.source, provider: use.provider, model: use.model },
                score: weight,
                last: use.at.getTime()
            });
        }
    }
    return [...scores.values()]
        .sort((left, right) => right.score - left.score || right.last - left.last)
        .slice(0, most)
        .map((entry) => entry.pick);
}
