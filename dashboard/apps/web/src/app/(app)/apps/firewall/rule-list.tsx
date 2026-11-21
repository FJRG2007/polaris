"use client";

/**
 * The firewall's custom rules, on the shared rule list: its words, its rule
 * description, its action badges, and the column of what each rule matches over
 * recent traffic - the one column only the firewall can fill.
 */

import { Skeleton } from "@polaris/ui";
import { Sparkline } from "./sparkline";
import { ruleDescription } from "./rule-language";
import type { WafCustomRule } from "@polaris/core";
import { SharedRuleList } from "@/components/rules/rule-list";
import { useTranslations } from "@/components/i18n/i18n-provider";

export { moved } from "@/components/rules/rule-list";

/** How each action reads in the Action column; its words are `actions.<action>`. */
const ACTION_BADGE: Record<WafCustomRule["action"], "danger" | "success" | "neutral"> = {
    block: "danger",
    allow: "success",
    skip: "neutral"
};

export function RuleList({
    rules,
    max,
    canEdit,
    hidden,
    matches,
    onEdit,
    onCreate,
    onChange
}: {
    rules: readonly WafCustomRule[];
    max: number;
    canEdit: boolean;
    /** Indices the current search filters out; see the shared list. */
    hidden?: ReadonlySet<number>;
    /** What each rule matches over recent traffic, by index. Absent until it arrives. */
    matches?: Readonly<Record<string, { total: number; series: number[] }>>;
    onEdit: (index: number) => void;
    onCreate: () => void;
    /** The whole list, already reordered/toggled/removed. The caller persists it. */
    onChange: (next: WafCustomRule[]) => void;
}) {
    const t = useTranslations("firewall");
    return (
        <SharedRuleList<WafCustomRule>
            rules={rules}
            max={max}
            canEdit={canEdit}
            hidden={hidden}
            words={{
                title: t("list.title"),
                empty: t("list.empty"),
                orderHint: t("list.orderHint"),
                deleteBody: t("list.deleteBody")
            }}
            describe={(rule) => ruleDescription(rule, t)}
            actionBadge={(rule) => ({ variant: ACTION_BADGE[rule.action], label: t(`actions.${rule.action}`) })}
            matchesColumn={(rule, index) => <MatchesCell name={rule.name} activity={matches?.[`custom:${index}`]} />}
            onEdit={onEdit}
            onCreate={onCreate}
            onChange={onChange}
        />
    );
}

/**
 * What a rule matches over recent traffic, as a line and a count.
 *
 * Shared by the custom rules and the predefined ones, because it says the same thing
 * on both and the caveat has to be identical: this is a replay of the rule over the
 * edge log, so it counts what the rule MATCHES rather than what it caught - which is
 * what makes it worth showing next to a rule that is switched off.
 */
export function MatchesCell({
    name,
    activity
}: {
    name: string;
    activity?: { total: number; series: number[] };
}) {
    const t = useTranslations("firewall");
    if (!activity) return <Skeleton className="h-6 w-24 rounded" />;
    return (
        <div className="flex items-center gap-2">
            <Sparkline series={activity.series} label={t("list.sparkline", { name })} />
            <span className="tabular-nums text-xs text-muted-foreground" title={t("list.matchesHint")}>
                {activity.total}
            </span>
        </div>
    );
}
