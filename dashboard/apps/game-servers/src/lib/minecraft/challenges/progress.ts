/**
 * How far a dealt challenge has got, from what the game counted - and what of
 * that is credited.
 *
 * The measure is always worked out from the statistics as they stand, never
 * added up from what rose: a pumpkin placed then broken leaves `mined - used`
 * where it was, so it cannot be counted twice by being seen in two halves.
 *
 * What rose is then credited only when it was earned:
 * - not while the player stood still (an AFK fish or mob farm): it is held back;
 * - not past the template's ceiling per minute of play;
 * - for a gated template, only in a look where the gate rose too (a treasure
 *   counts while fishing, not when it comes out of a chest);
 * and what is held back is never given later.
 *
 * Pure: the service feeds it the readings.
 */

import * as catalog from "./catalog";
import type { Instance } from "./state";

/** Each statistic's value now, by criterion; one the player has none of is 0. */
export type Values = Readonly<Record<string, number>>;

const value = (values: Values, criterion: string) => values[criterion] ?? 0;

/** A signed sum of parts, counted from where they stood when it was dealt. */
export function partsSince(parts: readonly catalog.Part[], values: Values, base: Values): number {
    return parts.reduce(
        (total, part) => total + part.sign * (value(values, part.criterion) - value(base, part.criterion)),
        0
    );
}

/**
 * The raw measure of a statistic-based check, or null for one Polaris measures
 * some other way (advancements, held items, positions).
 */
export function measure(check: catalog.Check, values: Values, base: Values): number | null {
    switch (check.kind) {
        case "sum": {
            const counted = partsSince(check.parts, values, base);
            return check.capBy ? Math.min(counted, partsSince(check.capBy, values, base)) : counted;
        }
        case "distinct":
            return check.groups.filter((group) => partsSince(group, values, base) >= 1).length;
        case "survive": {
            // Counts from the last death; one after it was dealt starts over.
            const now = check.parts.reduce((total, part) => total + value(values, part.criterion), 0);
            const then = check.parts.reduce((total, part) => total + value(base, part.criterion), 0);
            return now >= then ? now - then : now;
        }
        default:
            return null;
    }
}

/** Whether what a check requires on the side has been met. */
export function requirementMet(check: catalog.Check, values: Values, base: Values, target: number): boolean {
    if (check.kind === "survive") return partsSince(check.requires.parts, values, base) >= check.requires.atLeast;
    if (check.kind !== "sum" || !check.requires) return true;
    const reached = partsSince(check.requires.parts, values, base);
    if (check.requires.atLeast !== undefined && reached < check.requires.atLeast) return false;
    if (check.requires.share !== undefined && reached < Math.ceil(target * check.requires.share)) return false;
    return true;
}

/** Whether a gated check's gate rose since the last read. */
export function gateRose(check: catalog.Check, values: Values, last: Values): boolean | null {
    if (check.kind !== "sum" || !check.gate) return null;
    return partsSince(check.gate, values, last) > 0;
}

export interface Look {
    readonly now: number;
    /** Whether the player moved or turned lately. */
    readonly active: boolean;
    /** Nothing credited while standing still. */
    readonly afk: boolean;
    /** The per-minute ceilings apply. */
    readonly caps: boolean;
    /** The gate rose since the last read; null for a template without one. */
    readonly gate: boolean | null;
    /** A requirement on the side is met (`requirementMet`). */
    readonly requirement: boolean;
    /** Values at this read, kept as the next read's `last`. */
    readonly values?: Values;
}

/**
 * A challenge brought up to a new raw measure: what rose credited or held back,
 * what fell taken off, and done when the credited progress reaches the target.
 * A finished or voided one never moves again.
 */
export function credit(instance: Instance, template: catalog.Template, raw: number, look: Look): Instance {
    if (instance.doneAt !== null || instance.voided) return instance;
    const survive = template.check?.kind === "survive";
    let offset = instance.offset;
    // A death starts a deathless run over, and whatever was held back of the
    // last one with it.
    if (survive && raw < instance.raw) offset = 0;
    const rose = raw - instance.raw;
    if (rose > 0) {
        let allowed = rose;
        if (look.afk && !look.active) allowed = 0;
        if (look.gate === false) allowed = 0;
        if (look.caps && template.perMinute !== undefined) {
            const since = instance.readAt ?? instance.dealtAt;
            const minutes = Math.max(0.5, (look.now - since) / 60_000);
            allowed = Math.min(allowed, Math.floor(template.perMinute * minutes));
        }
        offset += rose - allowed;
    }
    const counted = Math.max(0, raw - offset) + instance.carry;
    const done = counted >= instance.target && look.requirement;
    return {
        ...instance,
        raw,
        offset,
        last: look.values ? { ...look.values } : instance.last,
        progress: done ? instance.target : Math.min(counted, instance.target),
        readAt: look.now,
        doneAt: done ? look.now : null
    };
}

/** A mining challenge lost to an Anti X-Ray catch: nothing, and never again. */
export function voided(instance: Instance): Instance {
    if (instance.doneAt !== null) return instance;
    return { ...instance, voided: true, progress: 0 };
}

/** A fresh challenge from a pool entry, counting from the values now. */
export function dealt(
    entry: { template: string; variant: string | null; tier: catalog.Difficulty; target: number },
    values: Values,
    now: number,
    extra: Partial<Instance> = {}
): Instance {
    return {
        template: entry.template,
        variant: entry.variant,
        tier: entry.tier,
        target: entry.target,
        base: { ...values },
        last: { ...values },
        raw: 0,
        offset: 0,
        carry: 0,
        progress: 0,
        dealtAt: now,
        readAt: null,
        doneAt: null,
        paid: false,
        voided: false,
        had: null,
        cells: [],
        at: null,
        day: null,
        ...extra
    };
}

// ------------------------------------------------------------------ reading the game's answers

/**
 * Every `pc_` score out of `scoreboard players list <name>`.
 *
 * The game answers `Alba has 3 scores:` and then each as `[pc_d0]: 5` - with no
 * line breaks between them over RCON on vanilla, so each is matched on its own.
 * The bracket holds the objective's display name, which for every objective
 * Polaris makes is its own name.
 */
export function readList(output: string): Record<string, number> {
    const found: Record<string, number> = {};
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\u001b\[[0-9;]*m/g, "").replace(/§[0-9a-fk-or]/gi, "");
    for (const match of clean.matchAll(/\[(pc_[a-z0-9_]{1,13})\]: (-?\d+)/g)) {
        found[match[1] as string] = Number(match[2]);
    }
    return found;
}

/** The objective names out of `scoreboard objectives list`, glued or not. */
export function readObjectives(output: string): Set<string> {
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
    return new Set([...clean.matchAll(/\[(pc_[a-z0-9_]{1,13})\]/g)].map((match) => match[1] as string));
}

/** Values by criterion from a player's scores, through a period's objectives. */
export function valuesOf(scores: Readonly<Record<string, number>>, objectives: Readonly<Record<string, string>>): Record<string, number> {
    const values: Record<string, number> = {};
    for (const [criterion, objective] of Object.entries(objectives)) {
        if (scores[objective] !== undefined) values[criterion] = scores[objective] as number;
    }
    return values;
}

/**
 * Who pressed a menu button: `Alba has 11 [pc_menu]`, once per player, glued
 * together on vanilla. Whatever the bracket says, the read was of one objective.
 * The service hands this the answer already rewritten one line per player
 * (`pressesRead`), so a team's prefix or suffix never reaches it.
 */
export function readPresses(output: string): Map<string, number> {
    const found = new Map<string, number>();
    // eslint-disable-next-line no-control-regex
    const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
    for (const match of clean.matchAll(/(\.?[A-Za-z0-9_]{1,16}) has (-?\d+) \[[^\]\n]*\]/g)) {
        found.set(match[1] as string, Number(match[2]));
    }
    return found;
}

/** How many of an item a player holds: `Found 3 matching item(s) on player Alba`. */
export function readHeld(output: string): number {
    const match = /Found (\d+) matching item/i.exec(output);
    return match ? Number(match[1]) : 0;
}

/** Whether an `execute if entity` test passed. An empty answer is a failure. */
export function passed(output: string): boolean {
    return /test passed/i.test(output);
}

// ------------------------------------------------------------------ advancements file

/**
 * What a player's advancements file says was earned after an instant: the
 * criteria of the given advancements, or - with none given - every advancement
 * completed then (recipes left out, which are not achievements).
 *
 * The file is `{"minecraft:story/mine_stone": {"criteria": {"get_stone":
 * "2024-01-01 12:00:00 +0000"}, "done": true}, ...}`.
 */
export function earnedSince(file: string, since: number, ids: readonly string[] | null): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(file);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const earned: string[] = [];
    const entries = Object.entries(parsed as Record<string, unknown>);
    for (const [id, entry] of entries) {
        if (typeof entry !== "object" || entry === null) continue;
        const short = id.replace(/^minecraft:/, "");
        const criteria = (entry as { criteria?: Record<string, string> }).criteria ?? {};
        const times = Object.entries(criteria).map(([name, when]) => [name, stamp(when)] as const);
        if (ids === null) {
            if (short.startsWith("recipes/") || (entry as { done?: boolean }).done !== true) continue;
            const last = Math.max(...times.map(([, when]) => when));
            if (last >= since) earned.push(short);
            continue;
        }
        if (!ids.includes(short)) continue;
        for (const [name, when] of times) if (when >= since) earned.push(`${short}:${name}`);
    }
    return earned;
}

/** `2024-01-01 12:00:00 +0000` as an instant; 0 when unreadable. */
export function stamp(text: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(text.trim());
    if (!match) return 0;
    const [, y, mo, d, h, mi, s, sign, oh, om] = match;
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const offset = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === "-" ? -1 : 1);
    return utc - offset;
}

// ------------------------------------------------------------------ positions

/** Two looks at a player farther apart than this per second jumped: a portal or a pearl. */
export const WALK_SPEED_CAP = 12;

/** Ground covered between two looks in the Nether, or 0 when it was a jump. */
export function netherStep(
    before: { x: number; z: number; dimension: string } | null,
    after: { x: number; z: number; dimension: string },
    seconds: number
): number {
    if (!before || before.dimension !== after.dimension || after.dimension !== "minecraft:the_nether") return 0;
    const distance = Math.hypot(after.x - before.x, after.z - before.z);
    return distance > WALK_SPEED_CAP * Math.max(1, seconds) ? 0 : distance;
}

/** The 200-block area a point is in, for counting each village once. */
export function cellOf(x: number, z: number, dimension: string): string {
    return `${dimension}:${Math.floor(x / 200)}:${Math.floor(z / 200)}`;
}
