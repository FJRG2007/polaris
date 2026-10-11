/**
 * Halloween's extra touches on a Minecraft server, beside the decorations and
 * night spawns in `seasonal.ts`: witches, bats at dusk, treats, the headless
 * horseman, trap pumpkins, one blood night, a trick-or-treat villager, phantoms
 * and graveyards. Each has its own switch or amount, kept together under one
 * key of the server's config.
 *
 * The jar does the work and keeps every one of them capped; this only decides
 * what it is told, on a line of its own (`polaris season halloween ...`) sent
 * after the season line to a jar that lists {@link HALLOWEEN_CAP}. The line is
 * `key=value` pairs, so a jar skips a key it does not know instead of refusing
 * the whole line.
 *
 * Pure, so the decision can be asserted in a test.
 */

import { z } from "zod";
import * as core from "@polaris/core";

/** Where a server keeps its Halloween settings: one object. */
export const HALLOWEEN_KEY = "seasonalHalloween";

/** The jar capability that takes the Halloween line. */
export const HALLOWEEN_CAP = "season-halloween";

/** Amounts, as a multiple of the jar's usual: the first choice brings none. */
export const WITCH_CHOICES = [0, 1, 2, 3] as const;
export const BAT_CHOICES = [0, 1, 2, 3] as const;
export const TRAP_CHOICES = [0, 1, 2] as const;
export const GRAVE_CHOICES = [0, 1, 2] as const;

export interface HalloweenSettings {
    /** More witches at night. */
    readonly witches: number;
    /** Bat swarms at dusk. */
    readonly bats: number;
    /** Pumpkin-wearing monsters sometimes drop a treat. */
    readonly treats: boolean;
    /** A rare headless horseman, never more than one a night. */
    readonly horseman: boolean;
    /** Some decorative pumpkins let out bats or a baby zombie when broken. */
    readonly traps: number;
    /** One blood night in the season, on Halloween itself. */
    readonly bloodNight: boolean;
    /** A costumed villager that takes pumpkins. */
    readonly trickOrTreat: boolean;
    /** Phantoms at night even for players who slept, hitting softer. */
    readonly phantoms: boolean;
    /** Small graveyards on wild ground, taken down after the season. */
    readonly graves: number;
}

/**
 * The defaults: everything that stays on players' screens or among the mobs is
 * on; phantoms (which hit) and graves (real blocks, on wild ground only) wait
 * for somebody to choose them.
 */
export const DEFAULT_HALLOWEEN: HalloweenSettings = {
    witches: 1,
    bats: 1,
    treats: true,
    horseman: true,
    traps: 1,
    bloodNight: true,
    trickOrTreat: true,
    phantoms: false,
    graves: 0
};

/** The settings that are amounts, with their choices. */
export const HALLOWEEN_AMOUNTS = {
    witches: WITCH_CHOICES,
    bats: BAT_CHOICES,
    traps: TRAP_CHOICES,
    graves: GRAVE_CHOICES
} as const;

export type HalloweenAmount = keyof typeof HALLOWEEN_AMOUNTS;

/** The settings that are switches. */
export const HALLOWEEN_SWITCHES = [
    "treats",
    "horseman",
    "bloodNight",
    "trickOrTreat",
    "phantoms"
] as const;

export type HalloweenSwitch = (typeof HALLOWEEN_SWITCHES)[number];

const amount = (choices: readonly number[]) =>
    z.number().refine((value) => choices.includes(value));

/** A change to some of the settings, as a save sends it: at least one, each one of its choices. */
export const halloweenPatchSchema = z
    .object({
        witches: amount(WITCH_CHOICES).optional(),
        bats: amount(BAT_CHOICES).optional(),
        treats: z.boolean().optional(),
        horseman: z.boolean().optional(),
        traps: amount(TRAP_CHOICES).optional(),
        bloodNight: z.boolean().optional(),
        trickOrTreat: z.boolean().optional(),
        phantoms: z.boolean().optional(),
        graves: amount(GRAVE_CHOICES).optional()
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** This server's Halloween settings; anything absent or not one of the choices is the default. */
export function halloweenSettings(config: Readonly<Record<string, unknown>>): HalloweenSettings {
    const stored = isRecord(config[HALLOWEEN_KEY]) ? config[HALLOWEEN_KEY] : {};
    const settings: Record<string, number | boolean> = { ...DEFAULT_HALLOWEEN };
    for (const [key, choices] of Object.entries(HALLOWEEN_AMOUNTS)) {
        const value = stored[key];
        if (typeof value === "number" && (choices as readonly number[]).includes(value))
            settings[key] = value;
    }
    for (const key of HALLOWEEN_SWITCHES) {
        const value = stored[key];
        if (typeof value === "boolean") settings[key] = value;
    }
    return settings as unknown as HalloweenSettings;
}

/** The stored object after a change: every field written, so a default moving later
 *  never changes what an operator already chose. */
export function patchHalloween(
    config: Readonly<Record<string, unknown>>,
    patch: Partial<HalloweenSettings>
): HalloweenSettings {
    return halloweenSettings({ [HALLOWEEN_KEY]: { ...halloweenSettings(config), ...patch } });
}

/** The day of the season's one blood night, as month and day. */
export const BLOOD_NIGHT = { month: 10, day: 31 } as const;

/**
 * The blood night's key when today, on the server's clock, is the day of it -
 * `yyyymmdd`, so the jar runs one per key and never twice - else 0.
 */
export function bloodNightKey(now: Date, timeZone: string): number {
    const zone =
        timeZone !== core.AUTOMATIC_TIME_ZONE && core.isTimeZone(timeZone) ? timeZone : "UTC";
    const wall = core.wallClock(now, zone);
    if (wall.month !== BLOOD_NIGHT.month || wall.day !== BLOOD_NIGHT.day) return 0;
    return wall.year * 10_000 + wall.month * 100 + wall.day;
}

/** The console line that tells the jar this server's Halloween settings. */
export function halloweenCommand(
    settings: HalloweenSettings,
    bloodKey: number,
    language: "en" | "es"
): string {
    const flag = (on: boolean) => (on ? 1 : 0);
    const percent = (multiple: number) => Math.round(multiple * 100);
    return [
        "polaris season halloween",
        `witches=${percent(settings.witches)}`,
        `bats=${percent(settings.bats)}`,
        `treats=${flag(settings.treats)}`,
        `horseman=${flag(settings.horseman)}`,
        `traps=${percent(settings.traps)}`,
        `blood=${settings.bloodNight ? bloodKey : 0}`,
        `trick=${flag(settings.trickOrTreat)}`,
        `phantoms=${flag(settings.phantoms)}`,
        `graves=${percent(settings.graves)}`,
        `lang=${language}`
    ].join(" ");
}
