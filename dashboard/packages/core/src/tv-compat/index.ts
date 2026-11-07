/**
 * "Does it work on my TV?": the models, quirks and privacy switches, read from
 * the JSON beside this file (validated by the tests against `schema.ts`), and
 * the search and tier rules every screen answers with.
 */

import models from "./models.json";
import quirks from "./quirks.json";
import privacy from "./privacy.json";
import debugging from "./debugging.json";
import type {
    TvDebugging,
    TvDebuggingSteps,
    TvModel,
    TvPlatform,
    TvPrivacy,
    TvPrivacyBrand,
    TvQuirk,
    TvQuirkId
} from "./schema.js";

export * from "./schema.js";
export * from "./rules.js";
export * from "./search.js";

export const TV_MODELS = models as readonly TvModel[];
export const TV_QUIRK_SOURCES = quirks as readonly TvQuirk[];
export const TV_PRIVACY = privacy as TvPrivacy;
export const TV_DEBUGGING = debugging as TvDebugging;

/** The privacy switches for a model's brand, then its platform's own. */
export function privacyFor(model: Pick<TvModel, "brand" | "platform">): TvPrivacyBrand[] {
    const words = model.brand.toLowerCase().split(/\s+/);
    const own = TV_PRIVACY.brands.filter(
        (entry) =>
            entry.matches.some((match) => words.includes(match)) &&
            entry.platforms.includes(model.platform)
    );
    const platform = TV_PRIVACY.brands.filter(
        (entry) => entry.matches.length === 0 && entry.platforms.includes(model.platform)
    );
    return [...own, ...platform];
}

/** Where a quirk is documented. */
export function quirkSource(id: TvQuirkId): string | undefined {
    return TV_QUIRK_SOURCES.find((quirk) => quirk.id === id)?.source;
}

/** How a platform's debugging is turned on, or undefined where no install runs. */
export function debuggingFor(platform: TvPlatform): TvDebuggingSteps | undefined {
    return TV_DEBUGGING.platforms.find((entry) => entry.platforms.includes(platform));
}
