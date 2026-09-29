"use client";

/**
 * One rule, open for editing.
 *
 * It takes over the screen instead of expanding in place. A rule is five decisions -
 * what it matches, what it then does, what that action steps over, where it sits in
 * the order, and whether it is on - and each of them wants room; inline, they turned
 * the list into a wall and hid the order, which is the one thing the list is for.
 *
 * Saving is explicit here, and that is the whole reason this screen exists as a
 * separate step. A half-written rule must never reach the edge: a condition with no
 * values yet matches nothing or everything depending on the operator, and either way
 * it would be enforcing while somebody is still typing it.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { TriangleAlert } from "lucide-react";
import { PageHeader, Section } from "./page-parts";
import { ConditionBuilder } from "./condition-builder";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";

type WafCondition = core.WafCondition;
type WafCustomRule = core.WafCustomRule;
type WafSkipComponent = core.WafSkipComponent;

type Words = NamespaceTranslator<"firewall">;

const ACTIONS = ["block", "allow", "skip"] as const;

/** What each component skips, in order; its title and what leaving it on would still
 *  do are `editor.skip.<component>` in the catalog. */
const SKIP_COMPONENTS: readonly WafSkipComponent[] = [
    "custom_rules",
    "managed_rules",
    "injection_checks",
    "browser_integrity",
    "challenge"
];

/** Where the rule sits. `custom` is the only one that needs a second answer, which is
 *  why it is a separate choice rather than every rule in a single long list. */
const POSITIONS = ["first", "last", "custom"] as const;

/** Three separate members rather than one with a `"first" | "last"` kind: only a
 *  single literal per member discriminates, which is what lets a reader (and the
 *  compiler) know `index` is there once the other two are ruled out. */
export type RulePosition =
    | { readonly kind: "first" }
    | { readonly kind: "last" }
    | { readonly kind: "after"; readonly index: number };

/** A rule with nothing in it yet, offered when one is created. */
export function emptyRule(count: number, t: Words): WafCustomRule {
    return {
        name: t("editor.newName", { number: count + 1 }),
        enabled: true,
        action: "block",
        conditions: [{ field: "path", operator: "starts_with", values: [] }]
    };
}

/** Whether any test anywhere in the tree is still waiting for a value. A half-written
 *  condition matches nothing or everything depending on its operator, which is the one
 *  thing that must never reach the edge. A signature check has no value to wait for. */
function anyEmpty(conditions: readonly WafCondition[]): boolean {
    return conditions.some((condition) => {
        if (core.isWafSignalCondition(condition)) return false;
        return core.isWafConditionGroup(condition) ? anyEmpty(condition.conditions) : condition.values.length === 0;
    });
}

/** Why this rule cannot be saved yet, or null when it can. Every reason is something
 *  the reader can see and fix on this screen. */
function blockingReason(rule: WafCustomRule, t: Words): string | null {
    if (rule.name.trim() === "") return t("editor.blocked.name");
    if (rule.conditions.length === 0) return t("editor.blocked.noCondition");
    if (anyEmpty(rule.conditions)) return t("editor.blocked.emptyValue");
    const tests = rule.conditions.reduce((total, condition) => total + core.wafConditionTests(condition), 0);
    if (tests > core.WAF_RULE_TESTS_MAX) return t("editor.blocked.tooMany", { max: core.WAF_RULE_TESTS_MAX });
    if (rule.action === "skip" && (rule.skip ?? []).length === 0) return t("editor.blocked.nothingSkipped");
    return null;
}

export function RuleEditor({
    rule: initial,
    /** Absent when the rule is being created. Used to keep it out of its own
     *  "fires after" list and to say whether this is a create or an edit. */
    index,
    others,
    onCancel,
    onSave
}: {
    rule: WafCustomRule;
    index: number | null;
    /** The other rules' names, in evaluation order, for the position picker. */
    others: readonly { readonly index: number; readonly name: string }[];
    onCancel: () => void;
    onSave: (rule: WafCustomRule, position: RulePosition) => void;
}) {
    const t = useTranslations("firewall");
    const tcommon = useTranslations("common");
    const [rule, setRule] = useState<WafCustomRule>(initial);
    // A rule that already exists keeps its place unless the reader moves it, so the
    // position picker starts on where it already is rather than on a default that
    // would silently relocate it the moment anything else was edited.
    const [position, setPosition] = useState<RulePosition>(() => startingPosition(index));
    const blocked = blockingReason(rule, t);
    const creating = index === null;
    const skip = rule.skip ?? [];

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={creating ? t("editor.createTitle") : t("editor.editTitle")} onBack={onCancel} />

            <Section title={t("editor.name")} hint={t("editor.nameHint")}>
                <Input
                    value={rule.name}
                    maxLength={80}
                    aria-label={t("editor.name")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="max-w-xl"
                    onChange={(event) => setRule({ ...rule, name: event.target.value })}
                />
            </Section>

            <Section title={t("editor.when")} hint={t("editor.whenHint")}>
                <ConditionBuilder
                    conditions={rule.conditions}
                    onChange={(conditions) => setRule({ ...rule, conditions })}
                />
            </Section>

            <Section title={t("editor.then")}>
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">{t("editor.chooseAction")}</span>
                    <Select
                        value={rule.action}
                        aria-label={t("list.columns.action")}
                        className="max-w-xs"
                        options={ACTIONS.map((action) => ({ value: action, label: t(`actions.${action}`) }))}
                        onValueChange={(value) => setRule({ ...rule, action: value as WafCustomRule["action"] })}
                    />
                    <p className="text-xs text-muted-foreground">{t(`editor.effects.${rule.action}`)}</p>
                </div>

                {/* Only under the action that gives them meaning. The choice is kept
                    either way, so switching to block and back comes back to what was
                    picked rather than to nothing. */}
                {rule.action === "skip" ? (
                    <fieldset className="flex flex-col gap-2 border-t border-border pt-3">
                        <legend className="text-xs font-medium text-muted-foreground">{t("editor.whatToSkip")}</legend>
                        {SKIP_COMPONENTS.map((component) => (
                            <label key={component} className="flex w-fit cursor-pointer items-start gap-2 text-sm">
                                <Checkbox
                                    className="mt-0.5"
                                    checked={skip.includes(component)}
                                    aria-label={t(`editor.skip.${component}.title`)}
                                    onChange={(event) =>
                                        setRule({
                                            ...rule,
                                            skip: event.target.checked
                                                ? [...skip, component]
                                                : skip.filter((entry) => entry !== component)
                                        })
                                    }
                                />
                                <span className="min-w-0">
                                    {t(`editor.skip.${component}.title`)}
                                    <span className="block text-xs text-muted-foreground">
                                        {t(`editor.skip.${component}.detail`)}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </fieldset>
                ) : null}
            </Section>

            <Section title={t("editor.order")} hint={t("editor.orderHint")}>
                <div className="flex flex-wrap gap-4">
                    <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("editor.selectOrder")}</span>
                        <Select
                            value={position.kind === "after" ? "custom" : position.kind}
                            aria-label={t("list.columns.order")}
                            className="w-40"
                            options={POSITIONS.map((one) => ({ value: one, label: t(`editor.positions.${one}`) }))}
                            onValueChange={(value) => {
                                if (value === "custom") {
                                    setPosition({ kind: "after", index: others[0]?.index ?? 0 });
                                    return;
                                }
                                setPosition({ kind: value as "first" | "last" });
                            }}
                        />
                    </div>
                    {position.kind === "after" ? (
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("editor.fireAfter")}
                            </span>
                            {others.length === 0 ? (
                                <p className="text-sm text-muted-foreground">{t("editor.noOther")}</p>
                            ) : (
                                <Select
                                    value={String(position.index)}
                                    aria-label={t("editor.firesAfter")}
                                    className="w-full max-w-sm"
                                    options={others.map((entry) => ({
                                        value: String(entry.index),
                                        label: entry.name
                                    }))}
                                    onValueChange={(value) => setPosition({ kind: "after", index: Number(value) })}
                                />
                            )}
                        </div>
                    ) : null}
                </div>
            </Section>

            <Section title={t("list.columns.status")} hint={t("editor.statusHint")}>
                <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">{t("list.columns.status")}</legend>
                    <Radio
                        name="rule-status"
                        label={t("list.active")}
                        checked={rule.enabled}
                        onSelect={() => setRule({ ...rule, enabled: true })}
                    />
                    <Radio
                        name="rule-status"
                        label={t("editor.disabled")}
                        checked={!rule.enabled}
                        onSelect={() => setRule({ ...rule, enabled: false })}
                    />
                </fieldset>
            </Section>

            {blocked ? (
                <p className="flex items-start gap-1.5 text-xs text-danger">
                    <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    {blocked}
                </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
                <Button type="button" variant="secondary" onClick={onCancel}>
                    {tcommon("actions.cancel")}
                </Button>
                <Button
                    type="button"
                    disabled={blocked !== null}
                    title={blocked ?? undefined}
                    onClick={() => onSave({ ...rule, name: rule.name.trim() }, position)}
                >
                    {tcommon("actions.save")}
                </Button>
            </div>
        </div>
    );
}

/** Where a rule starts out: a new one at the end, an existing one where it already
 *  is. Its own function so the two cases are stated once. */
function startingPosition(index: number | null): RulePosition {
    if (index === null) return { kind: "last" };
    return index === 0 ? { kind: "first" } : { kind: "after", index: index - 1 };
}

/** A radio, styled to match the design system. Native input so the arrow-key
 *  behaviour, the label association and the announcement come for free. */
function Radio({
    name,
    label,
    checked,
    onSelect
}: {
    name: string;
    label: string;
    checked: boolean;
    onSelect: () => void;
}) {
    return (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
            <input
                type="radio"
                name={name}
                checked={checked}
                onChange={onSelect}
                className="size-4 shrink-0 accent-[var(--color-primary)]"
            />
            {label}
        </label>
    );
}
