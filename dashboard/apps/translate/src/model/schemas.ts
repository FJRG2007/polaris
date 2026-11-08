/**
 * What the Translate route and actions accept. One schema per input, shared by
 * the screen and the server so both refuse the same things.
 */

import { z } from "zod";
import { AUTO, LANGUAGE_CODES } from "./languages";

/**
 * The longest single text in one request, in characters. A technical cap on a
 * request, never a limit the reader meets: the screen cuts a longer text into
 * pieces (`model/chunk.ts`) and sends them a request at a time.
 */
export const TEXT_MAX = 50_000;
/** The most texts in one request. */
export const TEXTS_MAX = 50;
/** The most characters in one request, across its texts. */
export const TOTAL_MAX = 50_000;

/** How much of a translation the history keeps of each side. */
export const HISTORY_TEXT_MAX = 5000;

/** The smallest and largest limit an administrator may set on one translation. */
export const CHAR_LIMIT_MIN = 100;
export const CHAR_LIMIT_MAX = 10_000_000;

/** How many translations one person keeps. The oldest go on every write. */
export const HISTORY_MAX = 100;

export const ENGINE_IDS = ["browser", "local", "polar", "deepl", "google"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const SERVER_ENGINE_IDS = ["deepl", "google", "polar"] as const;
export type ServerEngineId = (typeof SERVER_ENGINE_IDS)[number];

export const languageCode = z.enum(LANGUAGE_CODES);
export const sourceLanguage = z.union([z.literal(AUTO), languageCode]);
export const serverEngineId = z.enum(SERVER_ENGINE_IDS);
export const engineId = z.enum(ENGINE_IDS);

/** Text has to say something; whitespace alone is nothing to translate. */
const someText = (texts: readonly string[]) => texts.some((text) => text.trim().length > 0);

export const translateInput = z
    .object({
        // Not trimmed: the spacing around a text is part of what comes back.
        texts: z.array(z.string().max(TEXT_MAX)).min(1).max(TEXTS_MAX),
        from: sourceLanguage.default(AUTO),
        to: languageCode,
        engine: serverEngineId.optional()
    })
    .strict()
    .refine((input) => someText(input.texts), { message: "empty", path: ["texts"] })
    .refine((input) => input.texts.reduce((sum, text) => sum + text.length, 0) <= TOTAL_MAX, {
        // i18n-ignore a code for the caller; the route answers in the reader's words
        message: "too long",
        path: ["texts"]
    })
    // i18n-ignore a code for the caller; the route answers in the reader's words
    .refine((input) => input.from !== input.to, { message: "same language", path: ["to"] });

export type TranslateInput = z.infer<typeof translateInput>;

export const detectInput = z
    .object({
        text: z.string().trim().min(1).max(TEXT_MAX),
        engine: serverEngineId.optional()
    })
    .strict();

export type DetectInput = z.infer<typeof detectInput>;

/** One translation to keep. The target may run longer than its source. */
export const rememberInput = z
    .object({
        sourceText: z.string().trim().min(1).max(HISTORY_TEXT_MAX),
        targetText: z
            .string()
            .trim()
            .min(1)
            .max(HISTORY_TEXT_MAX * 2),
        from: languageCode,
        to: languageCode,
        engine: engineId
    })
    .strict();

export type RememberInput = z.infer<typeof rememberInput>;

export const idInput = z.object({ id: z.string().uuid() }).strict();

export const settingsInput = z
    .object({
        engines: z
            .object({
                browser: z.boolean(),
                /** Absent from a client older than the local engine: on, like its default. */
                local: z.boolean().default(true),
                polar: z.boolean(),
                deepl: z.boolean(),
                google: z.boolean()
            })
            .strict(),
        /**
         * Every engine once, the one tried first at the front. A client older
         * than an engine leaves it out; it goes back where the default puts it.
         */
        order: z
            .array(engineId)
            .max(ENGINE_IDS.length)
            .refine((ids) => new Set(ids).size === ids.length, { message: "errors.invalid" })
            .transform((ids) => readOrder(ids)),
        defaultTarget: languageCode,
        /**
         * The most characters one translation may have, or null for no limit
         * (the default). Absent from a client older than the setting: no limit.
         */
        charLimit: z.number().int().min(CHAR_LIMIT_MIN).max(CHAR_LIMIT_MAX).nullable().default(null)
    })
    .strict();

export type TranslateSettings = z.infer<typeof settingsInput>;

/**
 * The order a Polaris that never set one tries the engines in: the browser's
 * own translator first, then the local one (both free, and the text stays on
 * the device), the paid providers next, Polar's model last (slowest, and it
 * spends from Polar's allowance).
 */
export const DEFAULT_ORDER: readonly EngineId[] = ["browser", "local", "deepl", "google", "polar"];

/**
 * A stored order, read leniently: known engines once each in the order kept.
 * An engine it does not name (one added later) goes right after the engine the
 * default order puts before it - the local engine after the browser's - or
 * first when that one is not there either. Nothing kept is ever dropped.
 */
export function readOrder(raw: unknown): EngineId[] {
    const kept: EngineId[] = [];
    for (const value of Array.isArray(raw) ? raw : []) {
        const id = engineId.safeParse(value);
        if (id.success && !kept.includes(id.data)) kept.push(id.data);
    }
    DEFAULT_ORDER.forEach((id, index) => {
        if (kept.includes(id)) return;
        const before = DEFAULT_ORDER.slice(0, index)
            .reverse()
            .find((earlier) => kept.includes(earlier));
        kept.splice(before ? kept.indexOf(before) + 1 : 0, 0, id);
    });
    return kept;
}

/** What a Polaris that never opened the settings runs with: everything on. */
export const DEFAULT_SETTINGS: TranslateSettings = {
    engines: { browser: true, local: true, polar: true, deepl: true, google: true },
    order: [...DEFAULT_ORDER],
    defaultTarget: "en",
    charLimit: null
};

/** A stored limit, read leniently: anything but a whole number in range is no limit. */
export function readCharLimit(raw: unknown): number | null {
    return typeof raw === "number" &&
        Number.isInteger(raw) &&
        raw >= CHAR_LIMIT_MIN &&
        raw <= CHAR_LIMIT_MAX
        ? raw
        : null;
}

/**
 * Stored settings, read field by field: a value saved by an older version, or
 * one that no longer parses, falls back to its default instead of switching
 * the whole app off.
 */
export function readSettings(raw: unknown): TranslateSettings {
    const stored = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const engines = (
        stored.engines && typeof stored.engines === "object" ? stored.engines : {}
    ) as Record<string, unknown>;
    const flag = (key: keyof TranslateSettings["engines"]): boolean => {
        const value = engines[key];
        return typeof value === "boolean" ? value : DEFAULT_SETTINGS.engines[key];
    };
    const target = languageCode.safeParse(stored.defaultTarget);
    return {
        engines: {
            browser: flag("browser"),
            local: flag("local"),
            polar: flag("polar"),
            deepl: flag("deepl"),
            google: flag("google")
        },
        order: readOrder(stored.order),
        defaultTarget: target.success ? target.data : DEFAULT_SETTINGS.defaultTarget,
        charLimit: readCharLimit(stored.charLimit)
    };
}
