"use client";

/**
 * The firewall's conditions: the shared rule builder with the firewall's vocabulary
 * - the request's own facts and the signature checks - and its expression language.
 *
 * The expression is parsed as well as rendered, and the parse is refused rather
 * than approximated, because a condition quietly dropped from a firewall rule is the
 * failure nobody sees.
 */

import { useMemo } from "react";
import * as core from "@polaris/core";
import { ChipList, validAddress } from "./chip-list";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    RuleConditionBuilder,
    type ConditionVocabulary,
    type RuleCondition
} from "@/components/rules/condition-builder";
import {
    emptyCondition,
    fieldOptions,
    fieldValue,
    IP_OPERATORS,
    operatorOptions,
    signalOperators,
    valuePlaceholder
} from "./rule-language";

type WafCondition = core.WafCondition;
type WafLeafCondition = core.WafLeafCondition;
type WafSignalCondition = core.WafSignalCondition;
type WafTest = WafLeafCondition | WafSignalCondition;

/** How deep a group may sit before the schema stops accepting one. */
const GROUP_DEPTH_MAX = 2;

export function ConditionBuilder({
    conditions,
    onChange
}: {
    conditions: readonly WafCondition[];
    onChange: (next: WafCondition[]) => void;
}) {
    const t = useTranslations("firewall");
    const vocabulary = useMemo<ConditionVocabulary<WafTest>>(
        () => ({
            fieldOptions: fieldOptions(t),
            fieldValue,
            fieldChanged,
            operatorOptions: (test) =>
                core.isWafSignalCondition(test) ? signalOperators(t) : operatorOptions(test.field, t),
            operatorValue: (test) =>
                core.isWafSignalCondition(test) ? (test.negate ? "not_matches" : "matches") : test.operator,
            operatorChanged: (test, value) =>
                core.isWafSignalCondition(test)
                    ? { ...test, negate: value === "not_matches" }
                    : { ...test, operator: value as core.WafRuleOperator },
            emptyCondition,
            maxDepth: GROUP_DEPTH_MAX,
            valueEditor: (test, change) =>
                core.isWafSignalCondition(test) ? (
                    <p className="text-xs text-muted-foreground">{t("conditions.signalHint")}</p>
                ) : (
                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("conditions.value")}</span>
                        <ChipList
                            entries={test.values}
                            onChange={(values) => change({ ...test, values })}
                            placeholder={valuePlaceholder(t, test.field)}
                            validate={test.field === "ip" ? validAddress : undefined}
                            invalidMessage={test.field === "ip" ? t("rules.invalidAddress") : undefined}
                        />
                    </div>
                ),
            expression: {
                render: (list) => core.renderWafExpression(list as WafCondition[]),
                parse: (text) => {
                    const parsed = core.parseWafExpression(text);
                    return parsed.ok
                        ? { ok: true, conditions: core.foldWafValues(parsed.conditions) as RuleCondition<WafTest>[] }
                        : { ok: false, error: parsed.error };
                },
                max: core.WAF_EXPRESSION_MAX
            }
        }),
        [t]
    );
    return (
        <RuleConditionBuilder<WafTest>
            conditions={conditions as readonly RuleCondition<WafTest>[]}
            vocabulary={vocabulary}
            // The schema types the innermost group as holding tests only, which is
            // the depth limit expressed in the type; the builder stops offering the
            // join at GROUP_DEPTH_MAX, so this narrows back to what was already true.
            onChange={(next) => onChange(next as WafCondition[])}
        />
    );
}

/** The condition a change of field leaves behind. */
function fieldChanged(condition: WafTest, value: string): WafTest {
    if (value.startsWith("signal:")) {
        return { signal: value.slice("signal:".length) as core.WafRuleSignal, negate: false };
    }
    const field = value as core.WafRuleField;
    if (core.isWafSignalCondition(condition)) return { field, operator: "equals", values: [] };
    // The address field takes different operators, so one that no longer applies is
    // replaced rather than left reading wrong. Values go with it: an address list is
    // not a sensible list of user agents.
    const keepsOperator = field !== "ip" || IP_OPERATORS.includes(condition.operator);
    const changedKind = (field === "ip") !== (condition.field === "ip");
    return {
        field,
        operator: keepsOperator ? condition.operator : "equals",
        values: changedKind ? [] : condition.values
    };
}
