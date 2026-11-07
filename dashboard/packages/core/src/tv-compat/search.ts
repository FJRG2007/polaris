/**
 * The model search of "Does it work on my TV?": the one search every list in
 * Polaris runs (`search-text.ts`), over brand, model, aliases and platform.
 * Model numbers are compared without their spaces, dashes and underscores, so
 * "55c71k" finds "55-C71K" and the reverse.
 */

import type { TvModel, TvPlatform } from "./schema.js";
import { searchItems, type SearchField } from "../search-text.js";

/** The platform's name as people type it. */
export const PLATFORM_NAMES: Readonly<Record<TvPlatform, string>> = {
    "android-tv": "Android TV",
    "google-tv": "Google TV",
    android: "Android",
    "fire-os": "Fire TV Fire OS",
    webos: "LG webOS",
    tizen: "Samsung Tizen",
    roku: "Roku",
    vizio: "Vizio SmartCast",
    vidaa: "Hisense VIDAA",
    other: "Other"
};

/** A model number as compared: lowercase, no spaces, dashes or underscores. */
export function compactModel(value: string): string {
    return value.toLowerCase().replace(/[\s\-_]+/g, "");
}

/** A text plus the compact form of its words, so either spelling matches. */
function withCompact(value: string): string {
    const words = value.split(/[\s,()/"]+/).filter(Boolean);
    const compact = words.filter((word) => /[-_]/.test(word)).map(compactModel);
    // Neighbouring words joined, so "55 C71K" typed as one word finds them.
    const pairs = words.slice(1).map((word, at) => compactModel(`${words[at]}${word}`));
    return [value, ...compact, ...pairs].join(" ");
}

const FIELDS: readonly SearchField<TvModel>[] = [
    { text: (model) => withCompact(`${model.brand} ${model.model}`) },
    { text: (model) => model.aliases.map(withCompact), weight: 0.8 },
    { text: (model) => [PLATFORM_NAMES[model.platform], model.osVersion], weight: 0.5 }
];

/** The query as compared: a dash or underscore inside a model number dropped. */
function normalizeQuery(query: string): string {
    return query.replace(/(\w)[-_](?=\w)/g, "$1");
}

/** The models matching what somebody typed, brand matches first. */
export function searchTvModels(
    models: readonly TvModel[],
    query: string,
    options: { brand?: string | null; limit?: number } = {}
): TvModel[] {
    const brand = options.brand?.toLowerCase();
    const pool = brand ? models.filter((model) => model.brand.toLowerCase() === brand) : models;
    const typed = normalizeQuery(query);
    const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
    const named = (model: TvModel) => Number(words.includes(model.brand.toLowerCase()));
    return searchItems(pool, typed, FIELDS, {
        limit: options.limit,
        // Within a rank, a model of a brand the query names comes first.
        tieBreak: (left, right) => named(right) - named(left)
    });
}

/** Each brand with how many models it has, most first, then by name. */
export function tvBrandCounts(models: readonly TvModel[]): { brand: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const model of models) counts.set(model.brand, (counts.get(model.brand) ?? 0) + 1);
    return [...counts]
        .map(([brand, count]) => ({ brand, count }))
        .sort((left, right) => right.count - left.count || left.brand.localeCompare(right.brand));
}
