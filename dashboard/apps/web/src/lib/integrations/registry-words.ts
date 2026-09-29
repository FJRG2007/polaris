/**
 * The integrations catalog in the reader's words.
 *
 * `registry.ts` keeps every service's English, because the server side, the
 * search and the tests read it. The Integrations screen says it through the
 * `admin` catalog instead, keyed by the service's slug (camel case) and, for a
 * setup step, its place in the list: `integrations.catalog.<slug>.<field>`. A
 * service the catalog has no words for - an AI provider, whose seeds are
 * generated - is said as the registry has it.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import type {
    IntegrationCatalogEntry,
    IntegrationCategory,
    IntegrationSetupLink
} from "@/lib/integrations/registry";

type AdminWords = NamespaceTranslator<"admin">;

function slugKey(slug: string): string {
    return slug.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** The words at `key` when the catalog has them, and `english` when it does not. */
function said(t: AdminWords, key: string, english: string): string;
function said(t: AdminWords, key: string, english: string | undefined): string | undefined;
function said(t: AdminWords, key: string, english: string | undefined): string | undefined {
    if (english === undefined) return undefined;
    return t.has(key) ? t(key as NamespaceKey<"admin">) : english;
}

export interface IntegrationWords {
    readonly summary: string;
    readonly description: string;
    readonly apiKeyLabel?: string;
    readonly apiKeyHelp?: string;
    readonly setupLinks?: readonly IntegrationSetupLink[];
}

/** One service's copy, in the reader's words. */
export function integrationWords(t: AdminWords, entry: IntegrationCatalogEntry): IntegrationWords {
    const base = `integrations.catalog.${slugKey(entry.slug)}`;
    return {
        summary: said(t, `${base}.summary`, entry.summary),
        description: said(t, `${base}.description`, entry.description),
        apiKeyLabel: said(t, `${base}.apiKeyLabel`, entry.apiKeyLabel),
        apiKeyHelp: said(t, `${base}.apiKeyHelp`, entry.apiKeyHelp),
        setupLinks: entry.setupLinks?.map((link, index) => ({
            ...link,
            label: said(t, `${base}.links.${index}.label`, link.label),
            help: said(t, `${base}.links.${index}.help`, link.help)
        }))
    };
}

const CATEGORY_KEY: Readonly<Record<IntegrationCategory, string>> = {
    Security: "security",
    "OAuth apps": "oauthApps",
    Networking: "networking",
    Games: "games",
    Chat: "chat",
    Models: "models"
};

/** A group's heading and the line under it, in the reader's words. */
export function categoryWords(
    t: AdminWords,
    category: { name: IntegrationCategory; hint: string }
): { name: string; hint: string } {
    const base = `integrations.categories.${CATEGORY_KEY[category.name]}`;
    return { name: said(t, `${base}.name`, category.name), hint: said(t, `${base}.hint`, category.hint) };
}

/** One of Dymo's IP rules, as the screen names it; a rule the catalog does not
 *  know is named as the registry has it. */
export function dymoRule(t: AdminWords, rule: { value: string; label: string }): string {
    return said(t, `integrations.dymo.rules.${rule.value}`, rule.label);
}
