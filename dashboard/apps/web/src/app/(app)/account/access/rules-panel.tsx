"use client";

/**
 * The account's own access rules: a first-match-wins list, each rule opening as a
 * page of its own - built from the same list, page parts and condition builder
 * the firewall's custom rules use, with the account's vocabulary.
 *
 * Every save is judged on the server against the session making it, and one that
 * would block that session is refused with the rule's name, shown where the change
 * was made. A rule can also be tested against the current session before saving.
 * The list's own changes (order, on/off, delete) are applied at once and put back
 * if the server refuses them.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, CountryFlag, Input, Select, isDirty } from "@polaris/ui";
import { FlaskConical, Globe, ShieldAlert, Smartphone, TriangleAlert } from "lucide-react";
import {
    ACCOUNT_RULE_BROWSERS,
    ACCOUNT_RULE_DEVICE_TYPES,
    ACCOUNT_RULE_FIELDS,
    ACCOUNT_RULE_NETWORKS,
    ACCOUNT_RULE_SYSTEMS,
    ACCOUNT_RULE_WEEKDAYS,
    ACCOUNT_RULES_MAX,
    ACCOUNT_RULE_NAME_MAX,
    CONTINENTS,
    accountRuleSchema,
    type AccountRule,
    type AccountRuleCondition,
    type AccountRuleField,
    type AccountRuleLeaf
} from "@polaris/core";
import { SharedRuleList } from "@/components/rules/rule-list";
import { PageHeader, Section } from "@/components/rules/page-parts";
import { ChipList, validAddress } from "@/components/rules/chip-list";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { previewAccountRulesAction, saveAccountRulesAction, type RulePreview } from "./rule-actions";
import { ChoiceChips, CountryPicker, TimeRangePicker, regionName } from "@/components/rules/value-pickers";
import { RuleConditionBuilder, isRuleGroup, type ConditionVocabulary } from "@/components/rules/condition-builder";

type Words = NamespaceTranslator<"account">;

export interface SavedList {
    id: string;
    name: string;
}

const ACTION_BADGE: Record<AccountRule["action"], "danger" | "warning" | "success"> = {
    block: "danger",
    challenge: "warning",
    allow: "success"
};

/** How deep a group may sit: the schema takes one level of grouping. */
const GROUP_DEPTH_MAX = 1;

function emptyCondition(): AccountRuleLeaf {
    return { field: "country", operator: "equals", values: [] };
}

function browserTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

/** Every zone the browser knows, with UTC and the rule's own always present. */
function timeZones(current: string): string[] {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    let zones: string[] = [];
    try {
        zones = supported ? supported("timeZone") : [];
    } catch {
        zones = [];
    }
    return [...new Set(["UTC", current, ...zones])];
}

/** One value as the reader reads it. */
function valueLabel(
    field: AccountRuleField,
    value: string,
    t: Words,
    tc: NamespaceTranslator<"components">,
    locale: string,
    lists: readonly SavedList[]
): string {
    switch (field) {
        case "country":
            return regionName(value, locale);
        case "continent":
            return tc(`geo.continentNames.${value}` as NamespaceKey<"components">);
        case "device_type":
            return t(`access.rules.deviceTypes.${value as (typeof ACCOUNT_RULE_DEVICE_TYPES)[number]}`);
        case "network":
            return t(`access.rules.networks.${value as (typeof ACCOUNT_RULE_NETWORKS)[number]}`);
        case "weekday":
            return t(`access.rules.weekdays.${value as (typeof ACCOUNT_RULE_WEEKDAYS)[number]}`);
        case "access_group":
            return lists.find((list) => list.id === value)?.name ?? t("access.rules.deletedList");
        default:
            return value;
    }
}

/** A rule in one line, for the list. */
export function describeAccountRule(
    rule: Pick<AccountRule, "conditions">,
    t: Words,
    tc: NamespaceTranslator<"components">,
    locale: string,
    lists: readonly SavedList[]
): string {
    const leaf = (condition: AccountRuleLeaf) =>
        t("access.rules.describe", {
            field: t(`access.rules.fields.${condition.field}`),
            operator: t(`access.rules.operators.${condition.operator}`),
            values: condition.values.map((value) => valueLabel(condition.field, value, t, tc, locale, lists)).join(", ")
        });
    return rule.conditions
        .map((condition: AccountRuleCondition) =>
            "match" in condition
                ? `(${condition.conditions.map(leaf).join(condition.match === "any" ? t("access.rules.or") : t("access.rules.and"))})`
                : leaf(condition)
        )
        .join(t("access.rules.and"));
}

/** Why a draft cannot be saved yet, or null when it can. */
function blockingReason(rule: AccountRule, t: Words): string | null {
    if (!rule.name.trim()) return t("access.rules.editor.needsName");
    const leaves = rule.conditions.flatMap((condition) => (isRuleGroup(condition) ? condition.conditions : [condition]));
    if (leaves.length === 0 || leaves.some((leaf) => leaf.values.length === 0)) return t("access.rules.editor.needsValues");
    const parsed = accountRuleSchema.safeParse(rule);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? t("access.errors.checkRules"));
}

function useVocabulary(lists: readonly SavedList[], reputation: boolean): ConditionVocabulary<AccountRuleLeaf> {
    const t = useTranslations("account");
    const tc = useTranslations("components");
    return useMemo<ConditionVocabulary<AccountRuleLeaf>>(
        () => ({
            fieldOptions: ACCOUNT_RULE_FIELDS.map((field) => ({ value: field, label: t(`access.rules.fields.${field}`) })),
            fieldValue: (test) => test.field,
            // Values belong to the field: a list of countries is not a list of browsers.
            fieldChanged: (test, value) =>
                value === test.field ? test : { field: value as AccountRuleField, operator: test.operator, values: [] },
            operatorOptions: () =>
                (["equals", "not_equals"] as const).map((operator) => ({
                    value: operator,
                    label: t(`access.rules.operators.${operator}`)
                })),
            operatorValue: (test) => test.operator,
            operatorChanged: (test, value) => ({ ...test, operator: value as AccountRuleLeaf["operator"] }),
            emptyCondition,
            maxDepth: GROUP_DEPTH_MAX,
            valueEditor: (test, change) => {
                const set = (values: string[]) => change({ ...test, values });
                const choices = (options: { value: string; label: string; icon?: React.ReactNode }[]) => (
                    <ChoiceChips
                        label={t(`access.rules.fields.${test.field}`)}
                        options={options}
                        selected={test.values}
                        onChange={set}
                        unknownLabel={() => t("access.rules.deletedList")}
                    />
                );
                let editor: React.ReactNode;
                switch (test.field) {
                    case "ip":
                        editor = (
                            <ChipList
                                entries={test.values}
                                onChange={set}
                                placeholder={t("access.rules.addressPlaceholder")}
                                validate={validAddress}
                                invalidMessage={t("access.rules.invalidAddress")}
                            />
                        );
                        break;
                    case "country":
                        editor = <CountryPicker selected={test.values} onChange={set} />;
                        break;
                    case "continent":
                        editor = choices(
                            CONTINENTS.map((continent) => ({
                                value: continent.code,
                                label: tc(`geo.continentNames.${continent.code}` as NamespaceKey<"components">)
                            }))
                        );
                        break;
                    case "os":
                        editor = choices(ACCOUNT_RULE_SYSTEMS.map((name) => ({ value: name, label: name })));
                        break;
                    case "browser":
                        editor = choices(ACCOUNT_RULE_BROWSERS.map((name) => ({ value: name, label: name })));
                        break;
                    case "device_type":
                        editor = choices(
                            ACCOUNT_RULE_DEVICE_TYPES.map((value) => ({
                                value,
                                label: t(`access.rules.deviceTypes.${value}`),
                                icon: <Smartphone className="size-3 shrink-0" aria-hidden="true" />
                            }))
                        );
                        break;
                    case "network":
                        editor = (
                            <div className="flex flex-col gap-2">
                                {choices(
                                    ACCOUNT_RULE_NETWORKS.map((value) => ({
                                        value,
                                        label: t(`access.rules.networks.${value}`),
                                        icon: <ShieldAlert className="size-3 shrink-0" aria-hidden="true" />
                                    }))
                                )}
                                {reputation ? null : (
                                    <p className="flex items-start gap-1.5 text-xs text-warning">
                                        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                                        {t("access.rules.reputationOff")}
                                    </p>
                                )}
                            </div>
                        );
                        break;
                    case "weekday":
                        editor = choices(
                            ACCOUNT_RULE_WEEKDAYS.map((value) => ({ value, label: t(`access.rules.weekdays.${value}`) }))
                        );
                        break;
                    case "time":
                        editor = (
                            <TimeRangePicker
                                selected={test.values}
                                onChange={set}
                                labels={{
                                    from: t("access.rules.time.from"),
                                    to: t("access.rules.time.to"),
                                    add: t("access.rules.time.add"),
                                    overnight: t("access.rules.time.overnight")
                                }}
                            />
                        );
                        break;
                    case "access_group":
                        editor =
                            lists.length === 0 && test.values.length === 0 ? (
                                <p className="text-xs text-muted-foreground">{t("access.rules.noLists")}</p>
                            ) : (
                                choices(
                                    lists.map((list) => ({
                                        value: list.id,
                                        label: list.name,
                                        icon: <Globe className="size-3 shrink-0" aria-hidden="true" />
                                    }))
                                )
                            );
                        break;
                }
                return (
                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("access.rules.values")}</span>
                        {editor}
                    </div>
                );
            }
        }),
        [t, tc, lists, reputation]
    );
}

/** What testing against the current session found, in a sentence and its facts. */
function PreviewResult({ preview }: { preview: RulePreview }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const unknown = t("access.rules.preview.unknown");
    const sentence = preview.ruleName
        ? t(`access.rules.preview.${preview.action}`, { rule: preview.ruleName })
        : t("access.rules.preview.noMatch");
    const tone =
        preview.action === "block" ? "text-danger" : preview.action === "challenge" ? "text-warning" : "text-success";
    return (
        <div role="status" className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-xs">
            <p className={`font-medium ${tone}`}>{sentence}</p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                <span className="font-mono">{preview.ip ?? unknown}</span>
                <span className="inline-flex items-center gap-1">
                    {preview.country ? <CountryFlag code={preview.country} className="shrink-0" /> : null}
                    {preview.country ? regionName(preview.country, locale) : unknown}
                </span>
                <span>
                    {t("access.rules.preview.client", {
                        browser: preview.browser ?? unknown,
                        os: preview.os ?? unknown
                    })}
                </span>
            </p>
        </div>
    );
}

/** The button that tests a set of rules against this session, and its answer. */
function TestSession({ rules, disabled }: { rules: readonly AccountRule[]; disabled?: boolean }) {
    const t = useTranslations("account");
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState<RulePreview | null>(null);
    const [error, setError] = useState<string | null>(null);
    return (
        <div className="flex flex-col gap-2">
            <Button
                type="button"
                variant="secondary"
                className="w-fit"
                disabled={busy || disabled}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    const result = await previewAccountRulesAction(rules);
                    setBusy(false);
                    if (result.error !== undefined) {
                        setPreview(null);
                        setError(result.error);
                    } else setPreview(result.preview);
                }}
            >
                <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
                {busy ? t("access.rules.preview.testing") : t("access.rules.preview.test")}
            </Button>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
            {preview ? <PreviewResult preview={preview} /> : null}
        </div>
    );
}

/** A refused save: the server's sentence, and the session it would have blocked. */
function Refusal({ error, lockout }: { error: string; lockout: RulePreview | null }) {
    return (
        <div role="alert" className="flex flex-col gap-2">
            <p className="flex items-start gap-1.5 text-sm text-danger">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {error}
            </p>
            {lockout ? <PreviewResult preview={lockout} /> : null}
        </div>
    );
}

function RuleEditor({
    initial,
    creating,
    lists,
    reputation,
    others,
    busy,
    refusal,
    onCancel,
    onSave
}: {
    initial: AccountRule;
    creating: boolean;
    lists: readonly SavedList[];
    reputation: boolean;
    /** The whole list with this rule in its place, for the session test. */
    others: (draft: AccountRule) => AccountRule[];
    busy: boolean;
    refusal: { error: string; lockout: RulePreview | null } | null;
    onCancel: () => void;
    onSave: (rule: AccountRule) => void;
}) {
    const t = useTranslations("account");
    const tf = useTranslations("firewall");
    const tcommon = useTranslations("common");
    const [rule, setRule] = useState<AccountRule>(initial);
    const vocabulary = useVocabulary(lists, reputation);
    const blocked = blockingReason(rule, t);
    const unchanged = !creating && !isDirty(initial, rule);
    const readsClock = rule.conditions.some((condition) =>
        (isRuleGroup(condition) ? condition.conditions : [condition]).some(
            (leaf) => leaf.field === "time" || leaf.field === "weekday"
        )
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title={creating ? t("access.rules.editor.createTitle") : t("access.rules.editor.editTitle")}
                onBack={onCancel}
            />

            <Section title={t("access.rules.editor.name")}>
                <Input
                    value={rule.name}
                    maxLength={ACCOUNT_RULE_NAME_MAX}
                    aria-label={t("access.rules.editor.name")}
                    className="max-w-xl"
                    onChange={(event) => setRule({ ...rule, name: event.target.value })}
                />
            </Section>

            <Section title={t("access.rules.editor.when")} hint={t("access.rules.editor.whenHint")}>
                <RuleConditionBuilder<AccountRuleLeaf>
                    conditions={rule.conditions as AccountRuleCondition[]}
                    vocabulary={vocabulary}
                    onChange={(conditions) =>
                        setRule({ ...rule, conditions: conditions as AccountRule["conditions"] })
                    }
                />
            </Section>

            {readsClock ? (
                <Section title={t("access.rules.editor.timeZone")} hint={t("access.rules.editor.timeZoneHint")}>
                    <Select
                        value={rule.timeZone}
                        aria-label={t("access.rules.editor.timeZone")}
                        className="max-w-sm"
                        options={timeZones(rule.timeZone).map((zone) => ({ value: zone, label: zone }))}
                        onValueChange={(value) => setRule({ ...rule, timeZone: value })}
                    />
                </Section>
            ) : null}

            <Section title={t("access.rules.editor.then")}>
                <Select
                    value={rule.action}
                    aria-label={tf("list.columns.action")}
                    className="max-w-xs"
                    options={(["block", "challenge", "allow"] as const).map((action) => ({
                        value: action,
                        label: t(`access.rules.actions.${action}`)
                    }))}
                    onValueChange={(value) => setRule({ ...rule, action: value as AccountRule["action"] })}
                />
                <p className="text-xs text-muted-foreground">{t(`access.rules.effects.${rule.action}`)}</p>
            </Section>

            <Section title={t("access.rules.preview.title")} hint={t("access.rules.preview.hint")}>
                <TestSession rules={others(rule)} disabled={blocked !== null} />
            </Section>

            {refusal ? <Refusal error={refusal.error} lockout={refusal.lockout} /> : null}
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
                    disabled={busy || blocked !== null || unchanged}
                    title={blocked ?? undefined}
                    onClick={() => onSave({ ...rule, name: rule.name.trim() })}
                >
                    {busy ? tcommon("actions.saving") : tcommon("actions.save")}
                </Button>
            </div>
        </div>
    );
}

/** The country this session comes from, asked of the server the way a rule would
 *  ask it, so the "only my country" example can name it. */
async function currentCountry(): Promise<string | null> {
    const probe: AccountRule = {
        name: "probe",
        enabled: true,
        action: "allow",
        timeZone: "UTC",
        conditions: [{ field: "country", operator: "equals", values: ["US"] }]
    };
    const result = await previewAccountRulesAction([probe]);
    return result.error === undefined ? result.preview.country : null;
}

function Examples({ onPick }: { onPick: (rule: AccountRule) => void }) {
    const t = useTranslations("account");
    const [finding, setFinding] = useState(false);
    const zone = browserTimeZone();
    const base = { enabled: true, action: "block" as const, timeZone: zone };
    return (
        <div className="flex flex-col items-center gap-3">
            <p>{t("access.rules.empty")}</p>
            <p className="text-xs">{t("access.rules.examples.title")}</p>
            <div className="flex flex-wrap justify-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                        onPick({
                            ...base,
                            name: t("access.rules.examples.blockApple"),
                            conditions: [{ field: "os", operator: "equals", values: ["iOS", "macOS"] }]
                        })
                    }
                >
                    {t("access.rules.examples.blockApple")}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={finding}
                    onClick={async () => {
                        setFinding(true);
                        const country = await currentCountry();
                        setFinding(false);
                        onPick({
                            ...base,
                            name: t("access.rules.examples.onlyCountry"),
                            conditions: [{ field: "country", operator: "not_equals", values: country ? [country] : [] }]
                        });
                    }}
                >
                    {t("access.rules.examples.onlyCountry")}
                </Button>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                        onPick({
                            ...base,
                            name: t("access.rules.examples.blockAnonymous"),
                            conditions: [{ field: "network", operator: "equals", values: ["vpn", "proxy", "tor"] }]
                        })
                    }
                >
                    {t("access.rules.examples.blockAnonymous")}
                </Button>
            </div>
        </div>
    );
}

export function AccountRulesPanel({
    initialRules,
    lists,
    reputation
}: {
    initialRules: AccountRule[];
    lists: SavedList[];
    /** Whether this Polaris can tell what kind of network an address is on. */
    reputation: boolean;
}) {
    const router = useRouter();
    const t = useTranslations("account");
    const tc = useTranslations("components");
    const locale = useLocale();
    const [rules, setRules] = useState<AccountRule[]>(initialRules);
    const [editing, setEditing] = useState<{ index: number | null; rule: AccountRule } | null>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<{ error: string; lockout: RulePreview | null } | null>(null);

    /** Save the whole list. Returns whether it was taken. */
    async function persist(next: AccountRule[]): Promise<boolean> {
        setBusy(true);
        setRefusal(null);
        const result = await saveAccountRulesAction(next);
        setBusy(false);
        if (result.error !== undefined) {
            setRefusal({ error: result.error, lockout: result.lockout ?? null });
            return false;
        }
        router.refresh();
        return true;
    }

    const place = (draft: AccountRule, index: number | null): AccountRule[] =>
        index === null ? [...rules, draft] : rules.map((entry, i) => (i === index ? draft : entry));

    if (editing) {
        return (
            <RuleEditor
                key={editing.index ?? "new"}
                initial={editing.rule}
                creating={editing.index === null}
                lists={lists}
                reputation={reputation}
                others={(draft) => place(draft, editing.index)}
                busy={busy}
                refusal={refusal}
                onCancel={() => {
                    setRefusal(null);
                    setEditing(null);
                }}
                onSave={async (rule) => {
                    const next = place(rule, editing.index);
                    if (await persist(next)) {
                        setRules(next);
                        setEditing(null);
                    }
                }}
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {refusal ? <Refusal error={refusal.error} lockout={refusal.lockout} /> : null}
            <SharedRuleList<AccountRule>
                rules={rules}
                max={ACCOUNT_RULES_MAX}
                canEdit={!busy}
                words={{
                    title: t("access.rules.title"),
                    empty: (
                        <Examples
                            onPick={(rule) => {
                                setRefusal(null);
                                setEditing({ index: null, rule });
                            }}
                        />
                    ),
                    orderHint: t("access.rules.orderHint"),
                    deleteBody: t("access.rules.deleteBody")
                }}
                describe={(rule) => describeAccountRule(rule, t, tc, locale, lists)}
                actionBadge={(rule) => ({
                    variant: ACTION_BADGE[rule.action],
                    label: t(`access.rules.actions.${rule.action}`)
                })}
                onEdit={(index) => {
                    const rule = rules[index];
                    if (!rule) return;
                    setRefusal(null);
                    setEditing({ index, rule });
                }}
                onCreate={() => {
                    setRefusal(null);
                    setEditing({
                        index: null,
                        rule: {
                            name: "",
                            enabled: true,
                            action: "block",
                            timeZone: browserTimeZone(),
                            conditions: [emptyCondition()]
                        }
                    });
                }}
                onChange={async (next) => {
                    // Applied at once, put back if the server refuses it.
                    const before = rules;
                    setRules(next);
                    if (!(await persist(next))) setRules(before);
                }}
            />
            {rules.length > 0 ? (
                <Section title={t("access.rules.preview.title")} hint={t("access.rules.preview.listHint")}>
                    <TestSession rules={rules} />
                </Section>
            ) : null}
        </div>
    );
}
