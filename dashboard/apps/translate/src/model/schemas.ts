/**
 * What the Translate route and actions accept. One schema per input, shared by
 * the screen and the server so both refuse the same things.
 */

import { z } from "zod";
import { AUTO, LANGUAGE_CODES } from "./languages";

/** The longest single text, in characters. */
export const TEXT_MAX = 5000;
/** The most texts in one request (later phases send a page's paragraphs). */
export const TEXTS_MAX = 50;
/** The most characters in one request, across its texts. */
export const TOTAL_MAX = 20_000;

/** How many translations one person keeps. The oldest go on every write. */
export const HISTORY_MAX = 100;

export const ENGINE_IDS = ["browser", "polar", "deepl", "google"] as const;
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
        sourceText: z.string().trim().min(1).max(TEXT_MAX),
        targetText: z.string().trim().min(1).max(TEXT_MAX * 2),
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
                polar: z.boolean(),
                deepl: z.boolean(),
                google: z.boolean()
            })
            .strict(),
        defaultTarget: languageCode
    })
    .strict();

export type TranslateSettings = z.infer<typeof settingsInput>;

/** What a Polaris that never opened the settings runs with: everything on. */
export const DEFAULT_SETTINGS: TranslateSettings = {
    engines: { browser: true, polar: true, deepl: true, google: true },
    defaultTarget: "en"
};

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
            polar: flag("polar"),
            deepl: flag("deepl"),
            google: flag("google")
        },
        defaultTarget: target.success ? target.data : DEFAULT_SETTINGS.defaultTarget
    };
}
