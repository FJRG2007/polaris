/**
 * Variable groups and tags for Deploy.
 *
 * A variable group is a named set of variables that lives on a shelf (somebody's
 * own, or one organization's) rather than inside one project, so the same
 * database address or API key can be handed to services in many projects and
 * changed in one place.
 *
 * What a running service ends up with is a stack of layers, most general first:
 * linked groups in the order they were linked, the environment's shared
 * variables, then the service's own. A later layer wins a key it shares with an
 * earlier one, which is what `layerVariables` computes and what the screen
 * shows - including which layers lost.
 */

import { z } from "zod";

export const VARIABLE_GROUP_NAME_MAX = 60;
export const VARIABLE_GROUP_DESCRIPTION_MAX = 200;
/** How many groups one service may link. Enough for real use, small enough that
 *  the resolution order stays something a person can read. */
export const VARIABLE_GROUP_LINKS_MAX = 10;

export const TAG_MAX_LENGTH = 32;
export const TAGS_MAX = 12;

const collapse = (value: string) => value.trim().replace(/\s+/g, " ");

export const variableGroupInputSchema = z.object({
    name: z.string().transform(collapse).pipe(z.string().min(1).max(VARIABLE_GROUP_NAME_MAX)),
    description: z
        .string()
        .transform(collapse)
        .pipe(z.string().max(VARIABLE_GROUP_DESCRIPTION_MAX))
        .optional()
        .default("")
});
export type VariableGroupInput = z.infer<typeof variableGroupInputSchema>;

/**
 * One tag in its stored form: lowercase, words joined by hyphens, nothing but
 * letters, digits, hyphens, dots and underscores. Empty when nothing is left.
 */
export function normalizeTag(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^\p{L}\p{N}._-]/gu, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

/** Normalized, de-duplicated, empty ones dropped, order kept. */
export function normalizeTags(raw: readonly string[]): string[] {
    const out: string[] = [];
    for (const one of raw) {
        const tag = normalizeTag(one);
        if (tag && !out.includes(tag)) out.push(tag);
    }
    return out;
}

/** A tag list as typed: normalized first, then checked, so a check here can fail. */
export const tagsSchema = z
    .array(z.string().max(200))
    .max(50)
    .transform(normalizeTags)
    .pipe(z.array(z.string().min(1).max(TAG_MAX_LENGTH)).max(TAGS_MAX));

/** A stored tag column (a JSON array) read back, tolerating anything older. */
export function parseTags(stored: string | null | undefined): string[] {
    if (!stored) return [];
    try {
        const value: unknown = JSON.parse(stored);
        if (!Array.isArray(value)) return [];
        return normalizeTags(value.filter((one): one is string => typeof one === "string")).slice(
            0,
            TAGS_MAX
        );
    } catch {
        return [];
    }
}

/** Where a resolved value came from. */
export type VariableSource =
    | { readonly kind: "group"; readonly id: string; readonly name: string }
    | { readonly kind: "environment" }
    | { readonly kind: "service" };

export interface VariableLayer {
    readonly source: VariableSource;
    /** Key -> value. The value may be null when it is not to be read here (a
     *  secret the reader may not see); the key still takes part in resolution. */
    readonly values: Readonly<Record<string, string | null>>;
}

export interface ResolvedVariable {
    readonly key: string;
    readonly value: string | null;
    readonly source: VariableSource;
    /** The layers that also set this key and lost, earliest first. */
    readonly overridden: readonly VariableSource[];
}

/**
 * Stack the layers, earliest first: a later layer wins every key it shares with
 * an earlier one. Answers every key once, sorted by key.
 */
export function layerVariables(layers: readonly VariableLayer[]): ResolvedVariable[] {
    const winners = new Map<
        string,
        { value: string | null; source: VariableSource; lost: VariableSource[] }
    >();
    for (const layer of layers) {
        for (const [key, value] of Object.entries(layer.values)) {
            const previous = winners.get(key);
            winners.set(key, {
                value,
                source: layer.source,
                lost: previous ? [...previous.lost, previous.source] : []
            });
        }
    }
    return [...winners.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => ({
            key,
            value: entry.value,
            source: entry.source,
            overridden: entry.lost
        }));
}

/** The layers flattened to the environment a container gets. */
export function flattenLayers(layers: readonly VariableLayer[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const one of layerVariables(layers)) if (one.value !== null) out[one.key] = one.value;
    return out;
}

/** Who a group belongs to: a person's own shelf, or one organization's. */
export interface GroupShelf {
    readonly ownerId: string;
    readonly orgId: string | null;
}

/**
 * Whether a project may link a group: only one on the project's own shelf. A
 * personal group belongs with that same person's personal projects; an
 * organization's group with that organization's projects. That keeps a
 * group's values inside the circle that already reads the project, instead of
 * leaking one person's keys into a project somebody else runs.
 */
export function groupFitsProject(group: GroupShelf, project: GroupShelf): boolean {
    if (group.orgId !== null) return project.orgId === group.orgId;
    return project.orgId === null && project.ownerId === group.ownerId;
}
