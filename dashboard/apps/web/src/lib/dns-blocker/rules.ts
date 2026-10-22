/**
 * The operator's own rules edited one at a time, the way the Firewall lists
 * its rules, or added several at once from a pasted list: each one an action
 * (allow or block) and a value of one of the four shapes `normalizeDnsRule`
 * accepts. Stored exactly as before - the `allow` and
 * `deny` arrays of the settings - so older settings and export files read the
 * same. Pure, and shared by the dialog and the server action.
 */

import { z } from "zod";
import { DNS_LIMITS, normalizeDnsRule, type DnsSettings } from "./settings";

export const DNS_RULE_ACTIONS = ["allow", "deny"] as const;
export type DnsRuleAction = (typeof DNS_RULE_ACTIONS)[number];
export type DnsRuleKind = "exact" | "wildcard" | "anyEnding" | "regex";

/** Which of the four shapes a stored rule is. */
export function ruleKind(rule: string): DnsRuleKind {
    if (rule.length > 2 && rule.startsWith("/") && rule.endsWith("/")) return "regex";
    if (rule.startsWith("*.")) return "wildcard";
    return rule.endsWith(".*") ? "anyEnding" : "exact";
}

/**
 * A stored rule as the engine reads it in a list. The engine has exact names,
 * `*.name` and `/regex/` (Go RE2, matched anywhere in the name unless
 * anchored), but nothing for "any ending", so `google.*` is written as an
 * anchored pattern: the name itself or anything under it, then one or two
 * labels - `.com`, `.es`, `.co.uk`.
 */
export function engineRule(rule: string): string {
    if (ruleKind(rule) !== "anyEnding") return rule;
    const name = rule.slice(0, -2).replaceAll(".", "\\.");
    return `/^(.+\\.)?${name}(\\.[a-z0-9-]+){1,2}$/`;
}

/** What a rule covers, as the key the screen says it with and the name in it. */
export function ruleCoverage(rule: string): { key: DnsRuleKind; name: string } {
    const key = ruleKind(rule);
    if (key === "wildcard") return { key, name: rule.slice(2) };
    if (key === "anyEnding") return { key, name: rule.slice(0, -2) };
    return { key, name: rule };
}

/** The most entries one paste may hold, the same as a whole list. */
export const DNS_RULE_BATCH = DNS_LIMITS.rules;

/**
 * Several rules typed or pasted into one field, split on commas, spaces and
 * line breaks. A pattern between slashes is kept whole even when it holds a
 * comma or a space (`/a{1,3}/`): it runs to the next slash that ends a word.
 */
export function splitRuleEntries(text: string): string[] {
    const entries: string[] = [];
    const separator = /[\s,;]/;
    let at = 0;
    while (at < text.length) {
        if (separator.test(text[at]!)) {
            at += 1;
            continue;
        }
        let end = at;
        if (text[at] === "/") {
            let close = text.indexOf("/", at + 1);
            while (close >= 0 && close + 1 < text.length && !separator.test(text[close + 1]!))
                close = text.indexOf("/", close + 1);
            if (close > at + 1) end = close + 1;
        }
        if (end === at) {
            while (end < text.length && !separator.test(text[end]!)) end += 1;
        }
        entries.push(text.slice(at, end));
        at = end;
    }
    return entries;
}

/** Why one entry of a paste is not added, as a key the screen says. */
export type DnsRuleEntryProblem = "invalidRule" | "repeated" | "present";

export type DnsRuleEntry =
    | { text: string; rule: string; problem: null }
    | { text: string; rule: string | null; problem: DnsRuleEntryProblem };

/**
 * Each entry of a paste, normalized and checked: the ones that are not a rule,
 * the ones repeated in the paste, and the ones the action already has are
 * named with why, and the rest are what is added. Shared by the dialog's
 * preview and the server, which checks the same list again.
 */
export function parseRuleEntries(text: string, existing: readonly string[] = []): DnsRuleEntry[] {
    const seen = new Set<string>();
    const present = new Set(existing);
    return splitRuleEntries(text).map((entry): DnsRuleEntry => {
        const rule = normalizeDnsRule(entry);
        if (!rule) return { text: entry, rule: null, problem: "invalidRule" };
        if (seen.has(rule)) return { text: entry, rule, problem: "repeated" };
        seen.add(rule);
        if (present.has(rule)) return { text: entry, rule, problem: "present" };
        return { text: entry, rule, problem: null };
    });
}

/** A rule as typed in the dialog, normalized by the same function the settings
 *  use, so the screen and the server can never disagree about one. */
export const dnsRuleInputSchema = z.object({
    action: z.enum(DNS_RULE_ACTIONS),
    rule: z.string().transform((value, ctx) => {
        const rule = normalizeDnsRule(value);
        if (!rule) {
            ctx.addIssue({ code: "custom", message: "invalidRule" }); // i18n-ignore a key the screen says
            return z.NEVER;
        }
        return rule;
    })
});

/** Several rules for one action, each normalized as the single one is. */
export const dnsRuleBatchSchema = z.object({
    action: z.enum(DNS_RULE_ACTIONS),
    rules: z.array(dnsRuleInputSchema.shape.rule).min(1).max(DNS_RULE_BATCH)
});

const storedRule = z.object({ action: z.enum(DNS_RULE_ACTIONS), rule: z.string().max(300) });

export const dnsRuleEditSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("add"), next: dnsRuleInputSchema }),
    z.object({ op: z.literal("addMany"), next: dnsRuleBatchSchema }),
    z.object({ op: z.literal("edit"), from: storedRule, next: dnsRuleInputSchema }),
    z.object({ op: z.literal("delete"), from: storedRule })
]);
export type DnsRuleEdit = z.infer<typeof dnsRuleEditSchema>;

type Rules = Pick<DnsSettings, "allow" | "deny">;

/** Why an edit cannot be made, as a key the screen says. */
export type DnsRuleRefusal = "duplicate" | "tooMany" | "missing";

/**
 * The rules after one edit, or why it cannot be made. A rule added to one
 * action leaves the other, as the query log's Allow and Block buttons do.
 */
export function applyRuleEdit(rules: Rules, edit: DnsRuleEdit): Rules | DnsRuleRefusal {
    const lists: Record<DnsRuleAction, string[]> = {
        allow: [...rules.allow],
        deny: [...rules.deny]
    };
    if (edit.op === "addMany") {
        // The ones already there or repeated are left out, as the preview showed.
        const { action } = edit.next;
        const added = [...new Set(edit.next.rules)].filter((rule) => !lists[action].includes(rule));
        if (added.length === 0) return "duplicate";
        if (lists[action].length + added.length > DNS_LIMITS.rules) return "tooMany";
        lists[action].push(...added);
        const other: DnsRuleAction = action === "allow" ? "deny" : "allow";
        const moved = new Set(added);
        lists[other] = lists[other].filter((rule) => !moved.has(rule));
        return lists;
    }
    if (edit.op !== "add") {
        const at = lists[edit.from.action].indexOf(edit.from.rule);
        if (at < 0) return "missing";
        if (edit.op === "delete") {
            lists[edit.from.action].splice(at, 1);
            return lists;
        }
        const { action, rule } = edit.next;
        const same = edit.from.action === action && edit.from.rule === rule;
        if (same) return lists;
        if (lists[action].includes(rule)) return "duplicate";
        if (edit.from.action === action) lists[action][at] = rule;
        else {
            lists[edit.from.action].splice(at, 1);
            lists[action].push(rule);
        }
    } else {
        const { action, rule } = edit.next;
        if (lists[action].includes(rule)) return "duplicate";
        if (lists[action].length >= DNS_LIMITS.rules) return "tooMany";
        lists[action].push(rule);
    }
    const action = edit.next.action;
    const other: DnsRuleAction = action === "allow" ? "deny" : "allow";
    lists[other] = lists[other].filter((rule) => rule !== edit.next.rule);
    return lists;
}

/** Every rule as one row, allowed first, each in the order it was added. */
export function ruleRows(
    rules: Rules
): { action: DnsRuleAction; rule: string; kind: DnsRuleKind }[] {
    return DNS_RULE_ACTIONS.flatMap((action) =>
        rules[action].map((rule) => ({ action, rule, kind: ruleKind(rule) }))
    );
}
