/**
 * The managed rules and the jails, in the reader's words.
 *
 * Both are defined in @polaris/core, in English, because the engine reads them too.
 * This hands the screen the same objects with their text said in the reader's
 * language, from `managed.<id>` and `jails.<id>` in the `firewall` catalog. A rule
 * core adds before the catalog has words for it keeps its English rather than
 * showing keys, which is what SHAPES is for: it is the catalog's layout, and a test
 * holds the English catalog to core's own text so the two cannot drift.
 */

import type { WafJail, WafManagedRule } from "@polaris/core";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"firewall">;
type Key = NamespaceKey<"firewall">;

/** What the catalog holds for each managed rule. A rule without its own `inspects`
 *  or `combines` says the shared sentence, as core does. */
interface Shape {
    readonly caution: boolean;
    readonly inspects: boolean;
    readonly combines: boolean;
    readonly rules: number;
    readonly signatures: number;
}

const SHAPES: Readonly<Record<string, Shape>> = {
    "sql-injection": { caution: false, inspects: true, combines: true, rules: 0, signatures: 8 },
    xss: { caution: false, inspects: true, combines: true, rules: 0, signatures: 5 },
    "browser-integrity": { caution: true, inspects: true, combines: false, rules: 0, signatures: 5 },
    tor: { caution: true, inspects: true, combines: true, rules: 0, signatures: 0 },
    scanners: { caution: false, inspects: false, combines: false, rules: 2, signatures: 0 },
    dotfiles: { caution: false, inspects: false, combines: false, rules: 2, signatures: 0 },
    "directory-listing": { caution: false, inspects: false, combines: false, rules: 2, signatures: 0 },
    "admin-panels": { caution: true, inspects: false, combines: false, rules: 1, signatures: 0 },
    "cms-probes": { caution: false, inspects: false, combines: false, rules: 2, signatures: 0 },
    "ai-crawlers": { caution: true, inspects: false, combines: false, rules: 1, signatures: 0 },
    "search-crawlers": { caution: true, inspects: false, combines: false, rules: 1, signatures: 0 }
};

const JAILS = new Set(["not-found", "subdomain-listing", "rate-limited", "auth-failed", "probes", "ssh-auth"]);

/** `sql-injection` -> `sqlInjection`, the form the catalog keys take. */
function keyOf(id: string): string {
    return id.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());
}

/** A managed rule with its text in the reader's words. */
export function localizeManaged(rule: WafManagedRule, t: Words): WafManagedRule {
    const shape = SHAPES[rule.id];
    if (!shape) return rule;
    const base = `managed.${keyOf(rule.id)}`;
    const say = (path: string, params?: Record<string, string>) => t(`${base}.${path}` as Key, params);
    return {
        ...rule,
        label: say("label"),
        description: say("description"),
        caution: rule.caution === undefined ? undefined : shape.caution ? say("caution") : rule.caution,
        inspects: shape.inspects ? say("inspects") : t("managed.sharedInspects"),
        combines: shape.combines ? say("combines") : t("managed.sharedCombines"),
        rules: rule.rules.map((entry, index) => (index < shape.rules ? { ...entry, name: say(`rules.${index}`) } : entry)),
        // `tag` is markup a sentence names; it is passed in so the catalog does not
        // have to hold a tag the message format would read as its own.
        signatures: rule.signatures.map((entry, index) =>
            index < shape.signatures ? { ...entry, detail: say(`signatures.${index}`, { tag: "<b>" }) } : entry
        )
    };
}

/** A jail with its name and what it catches in the reader's words. */
export function localizeJail<J extends Pick<WafJail, "id" | "label" | "description">>(jail: J, t: Words): J {
    if (!JAILS.has(jail.id)) return jail;
    const base = `jails.${keyOf(jail.id)}`;
    return { ...jail, label: t(`${base}.label` as Key), description: t(`${base}.description` as Key) };
}
