/**
 * The draws: which challenges a server offers in a period, which of them each
 * player is dealt, and what a reroll lands on.
 *
 * The pool is drawn once per period for the whole server - every statistic a
 * challenge reads is one objective on the server, so the pool keeps them few -
 * and each player is dealt from it by a seed of their name and the period, so
 * the same player always gets the same three and nobody can redraw by
 * reconnecting.
 *
 * The rules (Hypixel Bingo's, ODailyQuests'):
 * - a day's nine span at least five categories: never more than two of one;
 * - at most one template of a group (templates that measure the same thing);
 * - nothing drawn in the last three days (weeks: two) while there is anything else;
 * - only what this server's version has;
 * - targets are a range around the template's, scaled by pace and the
 *   operator's multiplier, and rounded to a figure people remember.
 *
 * Pure, with the dice seeded.
 */

import * as catalog from "./catalog";
import { allowed } from "./settings";
import type { Instance, PoolEntry } from "./state";
import type { ChallengeSettings } from "./settings";

// ------------------------------------------------------------------ dice

/** A number for a string, FNV-1a. */
export function hash(text: string): number {
    let value = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.charCodeAt(index);
        value = Math.imul(value, 0x01000193) >>> 0;
    }
    return value >>> 0;
}

/** Dice that always roll the same for the same seed (mulberry32). */
export function dice(seed: string): () => number {
    let state = hash(seed);
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

/** One of the choices, by weight; null when there is none. */
export function pick<T>(choices: readonly T[], weight: (one: T) => number, roll: () => number): T | null {
    const total = choices.reduce((sum, one) => sum + Math.max(0, weight(one)), 0);
    if (choices.length === 0) return null;
    if (total <= 0) return choices[Math.floor(roll() * choices.length)] ?? null;
    let left = roll() * total;
    for (const one of choices) {
        left -= Math.max(0, weight(one));
        if (left < 0) return one;
    }
    return choices[choices.length - 1] ?? null;
}

// ------------------------------------------------------------------ targets

/** A figure rounded the way people round: 96 to 95, 256 to 250, 7 stays 7. */
export function roundNice(value: number): number {
    if (value < 10) return Math.max(1, Math.round(value));
    const exponent = Math.floor(Math.log10(value));
    const lead = value / 10 ** exponent;
    // Fives under a hundred; above, quarters of the power below when the
    // figure starts low (1,250, not 1,000) and halves when it starts high.
    const step = exponent === 1 ? 5 : 10 ** (exponent - 1) * (lead < 5 ? 2.5 : 5);
    return Math.max(step, Math.round(value / step) * step);
}

/** A target: the base, moved up to a fifth either way, times pace and the
 *  multiplier, rounded in the unit it is read in. Small ones stay exact. */
export function targetFor(
    template: catalog.Template,
    base: number,
    scale: number,
    roll: () => number
): number {
    const divisor = catalog.UNIT_DIVISOR[template.unit];
    const shown = base / divisor;
    if (shown <= 3) return Math.max(1, Math.round(shown * Math.min(scale, 1.5))) * divisor;
    const spread = 0.8 + roll() * 0.4;
    return roundNice(shown * spread * scale) * divisor;
}

// ------------------------------------------------------------------ the pool

export interface DrawInput {
    readonly settings: ChallengeSettings;
    /** The server's version, or null when unread (taken as recent). */
    readonly version: string | null;
    /** Templates drawn in recent periods of this layer. */
    readonly recent: readonly string[];
    readonly pace: Readonly<Record<string, number>>;
    readonly seed: string;
    /** The most statistics the pool may read. */
    readonly budget: number;
    /** Whether a community goal runs, which S1 needs. */
    readonly goalRunning: boolean;
}

/** How many each layer draws of each tier. */
export const POOL_SHAPE: Readonly<Record<"daily" | "weekly" | "card", Readonly<Record<catalog.Difficulty, number>>>> = {
    daily: { easy: 3, medium: 3, hard: 3 },
    weekly: { easy: 2, medium: 2, hard: 2 },
    card: { easy: 3, medium: 3, hard: 3 }
};

/** At most this many statistics per layer; the server pays a little per objective. */
export const BUDGET: Readonly<Record<catalog.Layer, number>> = {
    daily: 90,
    weekly: 70,
    card: 70,
    community: 20
};

/** The variant a template is drawn with: one this version has, by weight. */
export function variantFor(
    template: catalog.Template,
    version: string | null,
    roll: () => number
): string | null {
    if (!template.variants) return null;
    const fit = template.variants.filter((one) => catalog.atLeast(version, one.minVersion));
    return pick(fit, (one) => one.weight ?? 1, roll)?.key ?? null;
}

/** Whether a template can be offered on this server in this layer. */
export function eligible(
    template: catalog.Template,
    layer: "daily" | "weekly" | "card",
    tier: catalog.Difficulty,
    input: Pick<DrawInput, "settings" | "version" | "goalRunning">
): boolean {
    if (!allowed(input.settings, template)) return false;
    if (!catalog.atLeast(input.version, template.minVersion)) return false;
    if (catalog.baseTarget(template, layer, tier) === null) return false;
    if (template.check?.kind === "polaris" && template.check.measure === "community-share") {
        return input.goalRunning;
    }
    return true;
}

/** The statistics a pool entry reads, its fallback's included. */
export function criteriaOfEntry(template: catalog.Template, variant: string | null): string[] {
    const own = catalog.criteriaOf(catalog.checkOf(template, variant));
    const fallback = template.fallback ? catalog.templateOf(template.fallback) : null;
    const theirs = fallback ? catalog.criteriaOf(catalog.checkOf(fallback, fallback.variants?.[0]?.key ?? null)) : [];
    return [...new Set([...own, ...theirs])];
}

/**
 * A period's pool. Hardest first, where fewest templates qualify; within each,
 * a weighted draw that keeps to the rules above, relaxing the freshness rule and
 * then the spread only when there is nothing else to draw.
 */
export function drawPool(layer: "daily" | "weekly" | "card", input: DrawInput): PoolEntry[] {
    const roll = dice(`${input.seed}:${layer}`);
    const shape = POOL_SHAPE[layer];
    const chosen: PoolEntry[] = [];
    const criteria = new Set<string>();
    const groups = new Set<string>();
    const perCategory = new Map<catalog.Category, number>();
    const recent = new Set(input.recent);
    const tiers: catalog.Difficulty[] = ["hard", "medium", "easy"];

    for (const tier of tiers) {
        for (let count = 0; count < shape[tier]; count += 1) {
            const base = catalog.TEMPLATES.filter(
                (template) =>
                    eligible(template, layer, tier, input) &&
                    !chosen.some((entry) => entry.template === template.id) &&
                    !groups.has(template.group)
            );
            const fits = (template: catalog.Template, variant: string | null) => {
                const needed = criteriaOfEntry(template, variant).filter((one) => !criteria.has(one));
                return criteria.size + needed.length <= input.budget;
            };
            const rounds: ((template: catalog.Template) => boolean)[] = [
                (template) => !recent.has(template.id) && (perCategory.get(template.category) ?? 0) < 2,
                (template) => (perCategory.get(template.category) ?? 0) < 2,
                () => true
            ];
            let entry: PoolEntry | null = null;
            for (const rule of rounds) {
                const candidates = base.filter(rule);
                const weight = (template: catalog.Template) =>
                    (template.weight ?? 1) * input.settings.categories[template.category].weight;
                const remaining = [...candidates];
                while (remaining.length > 0 && !entry) {
                    const template = pick(remaining, weight, roll);
                    if (!template) break;
                    remaining.splice(remaining.indexOf(template), 1);
                    const variant = variantFor(template, input.version, roll);
                    if (template.variants && variant === null) continue;
                    if (!fits(template, variant)) continue;
                    const baseTarget = catalog.baseTarget(template, layer, tier) as number;
                    const scale = (input.settings.pace ? (input.pace[template.id] ?? 1) : 1) * input.settings.multiplier;
                    entry = {
                        template: template.id,
                        variant,
                        tier,
                        target: targetFor(template, baseTarget, scale, roll)
                    };
                }
                if (entry) break;
            }
            if (!entry) continue;
            const template = catalog.templateOf(entry.template)!;
            chosen.push(entry);
            groups.add(template.group);
            perCategory.set(template.category, (perCategory.get(template.category) ?? 0) + 1);
            for (const one of criteriaOfEntry(template, entry.variant)) criteria.add(one);
        }
    }
    return chosen;
}

/** Every statistic a pool reads, fallbacks included, in a stable order. */
export function poolCriteria(pool: readonly PoolEntry[]): string[] {
    const found = new Set<string>();
    for (const entry of pool) {
        const template = catalog.templateOf(entry.template);
        if (template) for (const one of criteriaOfEntry(template, entry.variant)) found.add(one);
    }
    return [...found];
}

/** Objective names for a layer's statistics: `pc_d0`, `pc_d1`... at most 16 characters. */
export const LAYER_LETTER: Readonly<Record<catalog.Layer, string>> = {
    daily: "d",
    weekly: "w",
    card: "s",
    community: "c"
};

export function objectivesFor(layer: catalog.Layer, criteria: readonly string[]): Record<string, string> {
    return Object.fromEntries(criteria.map((criterion, index) => [criterion, `pc_${LAYER_LETTER[layer]}${index}`]));
}

// ------------------------------------------------------------------ dealing

/**
 * What a player is dealt from a pool: one of each tier (the whole card for the
 * card), the same every time for the same player and period.
 */
export function deal(
    layer: "daily" | "weekly" | "card",
    pool: readonly PoolEntry[],
    player: string,
    key: string
): PoolEntry[] {
    if (layer === "card") return [...pool];
    const roll = dice(`${player.toLowerCase()}:${key}:${layer}`);
    const dealt: PoolEntry[] = [];
    for (const tier of catalog.DIFFICULTIES) {
        const choices = pool.filter((entry) => entry.tier === tier);
        const chosen = pick(choices, () => 1, roll);
        if (chosen) dealt.push(chosen);
    }
    return dealt;
}

/**
 * What a reroll lands on: another of the same tier from the pool, never the
 * same template, one of its group, or one the player already holds. Null when
 * there is none left.
 */
export function reroll(
    pool: readonly PoolEntry[],
    replacing: Pick<Instance, "template" | "tier">,
    held: readonly Pick<Instance, "template">[],
    seed: string
): PoolEntry | null {
    const group = catalog.templateOf(replacing.template)?.group;
    const choices = pool.filter((entry) => {
        if (entry.tier !== replacing.tier || entry.template === replacing.template) return false;
        if (held.some((one) => one.template === entry.template)) return false;
        return catalog.templateOf(entry.template)?.group !== group;
    });
    return pick(choices, () => 1, dice(seed));
}

// ------------------------------------------------------------------ bingo

/** The eight lines of a 3x3 card, by square index. */
export const LINES: readonly (readonly [number, number, number])[] = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
];

/** The lines a card has complete. */
export function completeLines(done: readonly boolean[]): number[] {
    return LINES.flatMap((line, index) => (line.every((square) => done[square]) ? [index] : []));
}

/**
 * The card laid out so that every line mixes difficulties: no row, column or
 * diagonal of three hard squares.
 */
export function layCard(pool: readonly PoolEntry[]): PoolEntry[] {
    const by = (tier: catalog.Difficulty) => pool.filter((entry) => entry.tier === tier);
    const [easy, medium, hard] = [by("easy"), by("medium"), by("hard")];
    // A Latin square: each row and column has one of each, and no diagonal is all hard.
    const order: catalog.Difficulty[] = ["easy", "medium", "hard", "hard", "easy", "medium", "medium", "hard", "easy"];
    const queues: Record<catalog.Difficulty, PoolEntry[]> = { easy: [...easy], medium: [...medium], hard: [...hard] };
    const laid: PoolEntry[] = [];
    for (const tier of order) {
        const next = queues[tier].shift() ?? queues.medium.shift() ?? queues.easy.shift() ?? queues.hard.shift();
        if (next) laid.push(next);
    }
    return laid;
}

// ------------------------------------------------------------------ pace

/** How far a template's targets may drift either way. */
const PACE_MIN = 0.5;
const PACE_MAX = 2;

/**
 * Targets that most people finish get bigger, ones almost nobody finishes get
 * smaller: over 80% done moves the range up 15%, under 20% down 15%. Judged only
 * once a template was dealt to at least three players.
 */
export function nextPace(pace: number, dealt: number, done: number): number {
    if (dealt < 3) return pace;
    const rate = done / dealt;
    const moved = rate > 0.8 ? pace * 1.15 : rate < 0.2 ? pace * 0.85 : pace;
    return Math.min(PACE_MAX, Math.max(PACE_MIN, Math.round(moved * 1000) / 1000));
}

// ------------------------------------------------------------------ community

/** A weekly goal Polaris draws itself, scaled by how many play. */
export function autoGoal(
    settings: ChallengeSettings,
    version: string | null,
    players: number,
    seed: string
): { template: string; variant: string | null; target: number } | null {
    const roll = dice(`${seed}:goal`);
    const choices = catalog.TEMPLATES.filter(
        (template) =>
            template.layers.includes("community") &&
            allowed(settings, template) &&
            catalog.atLeast(version, template.minVersion)
    );
    const template = pick(choices, (one) => settings.categories[one.category].weight, roll);
    if (!template || template.community === undefined) return null;
    const base = template.community * Math.max(2, players) * settings.multiplier;
    const divisor = catalog.UNIT_DIVISOR[template.unit];
    return { template: template.id, variant: null, target: roundNice(base / divisor) * divisor };
}
