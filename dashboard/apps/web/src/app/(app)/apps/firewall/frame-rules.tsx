"use client";

/**
 * Conditional "Sites allowed to embed": framing decided per request.
 *
 * A browser only accepts a list of sites in `frame-ancestors`, so a condition cannot be
 * written into the header. The edge judges each request to the page instead and picks
 * the list it sends: an `allow` rule adds its sites when its conditions hold, a
 * `refuse` rule shuts every frame out. The conditions describe the request for the
 * framed page - its address, hostname, path, user agent - never who is looking at the
 * parent page, which nothing on the server can see.
 *
 * Order is not offered, unlike the custom rules: a matching refusal wins wherever it
 * sits and matching allows add up, so the order of the list changes nothing.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { ChipList } from "@/components/rules/chip-list";
import { anyEmpty } from "./rule-editor";
import { ruleDescription } from "./rule-language";
import { PageHeader, Section } from "@/components/rules/page-parts";
import { ConditionBuilder } from "./condition-builder";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge, Button, ConfirmDeleteDialog, Input, Select, Switch, isDirty } from "@polaris/ui";

type WafFrameRule = core.WafFrameRule;

type Words = NamespaceTranslator<"firewall">;

/** A framing rule with nothing in it yet, offered when one is created. */
export function emptyFrameRule(count: number, t: Words): WafFrameRule {
    return {
        name: t("framing.rules.newName", { number: count + 1 }),
        enabled: true,
        action: "allow",
        ancestors: [],
        conditions: [{ field: "ip", operator: "equals", values: [] }]
    };
}

/** Why this rule cannot be saved yet, or null when it can. */
function blockingReason(rule: WafFrameRule, t: Words): string | null {
    if (rule.name.trim() === "") return t("editor.blocked.name");
    if (rule.conditions.length === 0) return t("editor.blocked.noCondition");
    if (anyEmpty(rule.conditions)) return t("editor.blocked.emptyValue");
    const tests = rule.conditions.reduce(
        (total, condition) => total + core.wafConditionTests(condition),
        0
    );
    if (tests > core.WAF_RULE_TESTS_MAX)
        return t("editor.blocked.tooMany", { max: core.WAF_RULE_TESTS_MAX });
    if (rule.action === "allow" && rule.ancestors.length === 0)
        return t("framing.rules.noSites");
    return null;
}

/** The sites as the edge writes them, so a chip shows exactly what a browser is told. */
function normalized(entries: readonly string[]): string[] {
    return [...new Set(entries.flatMap((entry) => core.normalizeFrameOrigin(entry) ?? []))];
}

/** What a rule does, in the words the list shows under its name. */
function effect(rule: WafFrameRule, t: Words): string {
    return rule.action === "refuse"
        ? t("framing.rules.refuses")
        : t("framing.rules.allows", { sites: rule.ancestors.join(", ") });
}

/** The scope's framing rules, under the static list they add to or override. */
export function FrameRuleList({
    rules,
    onCreate,
    onEdit,
    onChange
}: {
    rules: readonly WafFrameRule[];
    onCreate: () => void;
    onEdit: (index: number) => void;
    /** The whole list, already toggled or trimmed. The caller persists it. */
    onChange: (next: WafFrameRule[]) => void;
}) {
    const t = useTranslations("firewall");
    // By index, like the custom rules: a rule has a name but no identifier.
    const [deleting, setDeleting] = useState<number | null>(null);
    const max = core.FRAME_RULES_MAX;
    return (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-sm">{t("framing.rules.title")}</span>
                    <span className="text-xs text-muted-foreground">
                        {t("framing.rules.count", { count: rules.length, max })}
                    </span>
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={rules.length >= max}
                    title={rules.length >= max ? t("framing.rules.atMost", { max }) : undefined}
                    onClick={onCreate}
                >
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    {t("framing.rules.create")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("framing.rules.hint")}</p>
            {rules.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("framing.rules.empty")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {rules.map((rule, index) => (
                        <li key={index} className="flex items-center gap-3 px-3 py-2.5">
                            <button
                                type="button"
                                onClick={() => onEdit(index)}
                                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start"
                            >
                                <span className="flex max-w-full min-w-0 items-center gap-2">
                                    <span className="truncate text-sm" title={rule.name}>
                                        {rule.name}
                                    </span>
                                    <Badge
                                        variant={rule.action === "refuse" ? "danger" : "success"}
                                    >
                                        {t(`framing.rules.actions.${rule.action}`)}
                                    </Badge>
                                </span>
                                <span
                                    className="max-w-full truncate text-xs text-muted-foreground"
                                    title={`${ruleDescription(rule, t)} - ${effect(rule, t)}`}
                                >
                                    {ruleDescription(rule, t)} - {effect(rule, t)}
                                </span>
                            </button>
                            <Switch
                                checked={rule.enabled}
                                aria-label={rule.name}
                                onChange={(enabled) =>
                                    onChange(
                                        rules.map((entry, i) =>
                                            i === index ? { ...entry, enabled } : entry
                                        )
                                    )
                                }
                            />
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("framing.rules.edit", { name: rule.name })}
                                title={t("framing.rules.edit", { name: rule.name })}
                                onClick={() => onEdit(index)}
                            >
                                <Pencil className="size-4 shrink-0" aria-hidden="true" />
                            </Button>
                            <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={t("framing.rules.remove", { name: rule.name })}
                                title={t("framing.rules.remove", { name: rule.name })}
                                onClick={() => setDeleting(index)}
                            >
                                <Trash2 className="size-4 shrink-0" aria-hidden="true" />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                kind={t("framing.rules.kind")}
                requireTyping={false}
                name={deleting === null ? "" : (rules[deleting]?.name ?? "")}
                description={t("framing.rules.deleteBody")}
                onConfirm={() => {
                    if (deleting === null) return;
                    onChange(rules.filter((_, i) => i !== deleting));
                    setDeleting(null);
                }}
            />
        </div>
    );
}

/** One framing rule, open for editing. Saving is explicit for the reason it is on a
 *  custom rule: a half-written condition must never reach the edge. */
export function FrameRuleEditor({
    rule: initial,
    creating,
    onCancel,
    onSave
}: {
    rule: WafFrameRule;
    creating: boolean;
    onCancel: () => void;
    onSave: (rule: WafFrameRule) => void;
}) {
    const t = useTranslations("firewall");
    const tcommon = useTranslations("common");
    const [rule, setRule] = useState<WafFrameRule>(initial);
    const blocked = blockingReason(rule, t);
    const unchanged = !creating && !isDirty(initial, rule);

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title={creating ? t("framing.rules.createTitle") : t("framing.rules.editTitle")}
                onBack={onCancel}
            />

            <Section title={t("editor.name")}>
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

            <Section title={t("editor.when")} hint={t("framing.rules.whenHint")}>
                <ConditionBuilder
                    conditions={rule.conditions}
                    onChange={(conditions) => setRule({ ...rule, conditions })}
                />
            </Section>

            <Section title={t("editor.then")}>
                <div className="flex flex-col gap-1.5">
                    <Select
                        value={rule.action}
                        aria-label={t("list.columns.action")}
                        className="max-w-xs"
                        options={core.WAF_FRAME_RULE_ACTIONS.map((action) => ({
                            value: action,
                            label: t(`framing.rules.actions.${action}`)
                        }))}
                        onValueChange={(value) =>
                            setRule({ ...rule, action: value as WafFrameRule["action"] })
                        }
                    />
                    <p className="text-xs text-muted-foreground">
                        {t(`framing.rules.effects.${rule.action}`)}
                    </p>
                </div>
                {/* Kept when the action changes, so switching to refuse and back does
                    not lose the sites somebody typed. */}
                {rule.action === "allow" ? (
                    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                        <span className="text-xs font-medium text-muted-foreground">
                            {t("framing.rules.sites")}
                        </span>
                        <ChipList
                            entries={rule.ancestors}
                            placeholder={t("framing.placeholder")}
                            validate={(value) => core.normalizeFrameOrigin(value) !== null}
                            invalidMessage={t("framing.invalid")}
                            onChange={(next) => setRule({ ...rule, ancestors: normalized(next) })}
                        />
                    </div>
                ) : null}
            </Section>

            <Section title={t("list.columns.status")}>
                <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                    <Switch
                        checked={rule.enabled}
                        aria-label={t("list.active")}
                        onChange={(enabled) => setRule({ ...rule, enabled })}
                    />
                    {rule.enabled ? t("list.active") : t("editor.disabled")}
                </label>
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
                    disabled={blocked !== null || unchanged}
                    title={blocked ?? undefined}
                    onClick={() => onSave({ ...rule, name: rule.name.trim() })}
                >
                    {tcommon("actions.save")}
                </Button>
            </div>
        </div>
    );
}
