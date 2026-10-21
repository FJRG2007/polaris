/**
 * The operator's own rules edited one at a time, the way the Firewall lists
 * its rules: each one an action (allow or block) and a value of one of the
 * three shapes the engine reads. Stored exactly as before - the `allow` and
 * `deny` arrays of the settings - so older settings and export files read the
 * same. Pure, and shared by the dialog and the server action.
 */

import { z } from "zod";
import { DNS_LIMITS, normalizeDnsRule, type DnsSettings } from "./settings";

export const DNS_RULE_ACTIONS = ["allow", "deny"] as const;
export type DnsRuleAction = (typeof DNS_RULE_ACTIONS)[number];
export type DnsRuleKind = "exact" | "wildcard" | "regex";

/** Which of the three shapes a stored rule is. */
export function ruleKind(rule: string): DnsRuleKind {
    if (rule.length > 2 && rule.startsWith("/") && rule.endsWith("/")) return "regex";
    return rule.startsWith("*.") ? "wildcard" : "exact";
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

const storedRule = z.object({ action: z.enum(DNS_RULE_ACTIONS), rule: z.string().max(300) });

export const dnsRuleEditSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("add"), next: dnsRuleInputSchema }),
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
