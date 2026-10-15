/**
 * The reference screen's words for one documented route, in the reader's
 * language. The OpenAPI document keeps the English in routes.ts; the screen
 * reads the catalog under `apiKeys.reference`, keyed by operation id, with the
 * words several routes share (a status, a parameter, a tag) said once.
 */

import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { DocumentedRoute } from "@/lib/api-docs/routes";

type AccountTranslator = NamespaceTranslator<"account">;

/** The first of `keys` the catalog holds, or the English when none does. */
function pick(t: AccountTranslator, keys: string[], english: string): string {
    for (const key of keys) if (t.has(key)) return t(key);
    return english;
}

export function referenceCopy(t: AccountTranslator, route: DocumentedRoute, id: string) {
    const op = `apiKeys.reference.ops.${id}`;
    return {
        tag: pick(t, [`apiKeys.reference.tags.${route.tag}`], route.tag),
        summary: pick(t, [`${op}.summary`], route.summary),
        description: route.description ? pick(t, [`${op}.description`], route.description) : null,
        response: (status: string, english: string) =>
            pick(t, [`${op}.responses.${status}`, `apiKeys.reference.statuses.${status}`], english),
        parameter: (name: string, english: string | null) =>
            english === null ? null : pick(t, [`${op}.params.${name}`, `apiKeys.reference.params.${name}`], english)
    };
}
