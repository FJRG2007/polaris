"use client";

/**
 * One rule, open for editing.
 *
 * It takes over the screen instead of expanding in place. A rule is four decisions -
 * what it matches, what it then does, where it sits in the order, and whether it is
 * on - and each of them wants room; inline, they turned the list into a wall and hid
 * the order, which is the one thing the list is for.
 *
 * Saving is explicit here, and that is the whole reason this screen exists as a
 * separate step. A half-written rule must never reach the edge: a condition with no
 * values yet matches nothing or everything depending on the operator, and either way
 * it would be enforcing while somebody is still typing it.
 */

import { useState } from "react";
import { PageHeader, Section } from "./page-parts";
import { Button, Input, Select } from "@polaris/ui";
import { ChipList, validAddress } from "./chip-list";
import { Brackets, Plus, TriangleAlert, X } from "lucide-react";
import { isWafConditionGroup, WAF_RULE_TESTS_MAX, wafConditionTests } from "@polaris/core";
import type {
    WafCondition,
    WafConditionGroup,
    WafCustomRule,
    WafLeafCondition,
    WafRuleField,
    WafRuleOperator
} from "@polaris/core";
import {
    emptyCondition,
    emptyGroup,
    FIELD_OPTIONS,
    IP_OPERATORS,
    operatorOptions,
    ruleExpression,
    VALUE_PLACEHOLDER
} from "./rule-language";

const ACTION_OPTIONS = [
    { value: "block", label: "Block" },
    { value: "allow", label: "Allow" }
];

/** What the chosen action actually does, said where the choice is made. */
const ACTION_EFFECT: Record<WafCustomRule["action"], string> = {
    block: "Refuses matching requests with 403 and stops evaluating later rules.",
    allow: "Admits matching requests and stops evaluating later rules, so a rule below cannot block them."
};

/** Where the rule sits. `custom` is the only one that needs a second answer, which is
 *  why it is a separate choice rather than every rule in a single long list. */
const POSITION_OPTIONS = [
    { value: "first", label: "First" },
    { value: "last", label: "Last" },
    { value: "custom", label: "Custom" }
];

/** Three separate members rather than one with a `"first" | "last"` kind: only a
 *  single literal per member discriminates, which is what lets a reader (and the
 *  compiler) know `index` is there once the other two are ruled out. */
export type RulePosition =
    | { readonly kind: "first" }
    | { readonly kind: "last" }
    | { readonly kind: "after"; readonly index: number };

/** A rule with nothing in it yet, offered when one is created. */
export function emptyRule(count: number): WafCustomRule {
    return {
        name: `Rule ${count + 1}`,
        enabled: true,
        action: "block",
        conditions: [{ field: "path", operator: "starts_with", values: [] }]
    };
}

/** Whether any test anywhere in the tree is still waiting for a value. A half-written
 *  condition matches nothing or everything depending on its operator, which is the one
 *  thing that must never reach the edge. */
function anyEmpty(conditions: readonly WafCondition[]): boolean {
    return conditions.some((condition) =>
        isWafConditionGroup(condition) ? anyEmpty(condition.conditions) : condition.values.length === 0
    );
}

/** Why this rule cannot be saved yet, or null when it can. Every reason is something
 *  the reader can see and fix on this screen. */
function blockingReason(rule: WafCustomRule): string | null {
    if (rule.name.trim() === "") return "Give the rule a name.";
    if (rule.conditions.length === 0) return "Add at least one condition.";
    if (anyEmpty(rule.conditions)) return "Every condition needs at least one value.";
    const tests = rule.conditions.reduce((total, condition) => total + wafConditionTests(condition), 0);
    if (tests > WAF_RULE_TESTS_MAX) return `A rule can hold at most ${WAF_RULE_TESTS_MAX} conditions.`;
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
    const [rule, setRule] = useState<WafCustomRule>(initial);
    // A rule that already exists keeps its place unless the reader moves it, so the
    // position picker starts on where it already is rather than on a default that
    // would silently relocate it the moment anything else was edited.
    const [position, setPosition] = useState<RulePosition>(() => startingPosition(index));
    const expression = ruleExpression(rule);
    const blocked = blockingReason(rule);
    const creating = index === null;

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={creating ? "Create custom rule" : "Edit custom rule"} onBack={onCancel} />

            <Section
                title="Rule name"
                hint="Names the rule in the list and in the reason a blocked request is refused with."
            >
                <Input
                    value={rule.name}
                    maxLength={80}
                    aria-label="Rule name"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="max-w-xl"
                    onChange={(event) => setRule({ ...rule, name: event.target.value })}
                />
            </Section>

            <Section
                title="When incoming requests match..."
                hint="Every condition must hold. Within one condition, any of its values is enough. Group conditions to ask for any one of them instead."
            >
                <div className="flex flex-col gap-3">
                    <ConditionList
                        conditions={rule.conditions}
                        match="all"
                        depth={0}
                        onChange={(conditions) => setRule({ ...rule, conditions })}
                    />

                    <div className="mt-1 flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Expression preview</span>
                        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                            {expression || "Add a condition to see the expression."}
                        </pre>
                    </div>
                </div>
            </Section>

            <Section title="Then take action...">
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Choose action</span>
                    <Select
                        value={rule.action}
                        aria-label="Action"
                        className="max-w-xs"
                        options={ACTION_OPTIONS}
                        onValueChange={(value) => setRule({ ...rule, action: value as WafCustomRule["action"] })}
                    />
                    <p className="text-xs text-muted-foreground">{ACTION_EFFECT[rule.action]}</p>
                </div>
            </Section>

            <Section
                title="Execution order"
                hint="Rules are evaluated in order. Where this one sits decides whether it gets the request before or after the others."
            >
                <div className="flex flex-wrap gap-4">
                    <div className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Select order</span>
                        <Select
                            value={position.kind === "after" ? "custom" : position.kind}
                            aria-label="Order"
                            className="w-40"
                            options={POSITION_OPTIONS}
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
                                Select which rule this will fire after
                            </span>
                            {others.length === 0 ? (
                                <p className="text-sm text-muted-foreground">There is no other rule yet.</p>
                            ) : (
                                <Select
                                    value={String(position.index)}
                                    aria-label="Fires after"
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

            <Section title="Status" hint="Controls whether the rule evaluates incoming traffic.">
                <fieldset className="flex flex-col gap-2">
                    <legend className="sr-only">Status</legend>
                    <Radio
                        name="rule-status"
                        label="Active"
                        checked={rule.enabled}
                        onSelect={() => setRule({ ...rule, enabled: true })}
                    />
                    <Radio
                        name="rule-status"
                        label="Disabled"
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
                    Cancel
                </Button>
                <Button
                    type="button"
                    disabled={blocked !== null}
                    title={blocked ?? undefined}
                    onClick={() => onSave({ ...rule, name: rule.name.trim() }, position)}
                >
                    Save
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

/** How deep a group may sit before the schema stops accepting one. Three levels of
 *  reading is already the limit of what an operator can hold in their head, and it is
 *  the same bound `wafConditionSchema` is built to. */
const GROUP_DEPTH_MAX = 2;

/**
 * One level of the condition tree: the rule's own list, or a group's members.
 *
 * The joiner between rows is drawn here rather than by each row, because it is a fact
 * about the list they are in - "and" at the top, whichever word the group matches on
 * inside one. A row that drew its own would be stating its parent's rule from the
 * wrong place, and would have to be told anyway.
 */
function ConditionList({
    conditions,
    match,
    depth,
    onChange
}: {
    conditions: readonly WafCondition[];
    /** How this level reads its members, which is what the joiner says. */
    match: "all" | "any";
    depth: number;
    onChange: (next: WafCondition[]) => void;
}) {
    const joiner = match === "any" ? "or" : "and";
    const replace = (at: number, next: WafCondition): void =>
        onChange(conditions.map((entry, index) => (index === at ? next : entry)));

    return (
        <div className="flex flex-col gap-2">
            {conditions.map((condition, at) => (
                <div key={at} className="flex flex-col gap-2">
                    {at === 0 ? null : <span className="text-xs font-medium text-muted-foreground">{joiner}</span>}
                    {isWafConditionGroup(condition) ? (
                        <ConditionGroupBlock
                            group={condition}
                            depth={depth + 1}
                            removable={conditions.length > 1}
                            onChange={(next) => replace(at, next)}
                            onRemove={() => onChange(conditions.filter((_, index) => index !== at))}
                        />
                    ) : (
                        <ConditionRow
                            condition={condition}
                            removable={conditions.length > 1}
                            onChange={(next) => replace(at, next)}
                            onRemove={() => onChange(conditions.filter((_, index) => index !== at))}
                        />
                    )}
                </div>
            ))}

            <div className="flex flex-wrap gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-fit"
                    onClick={() => onChange([...conditions, emptyCondition()])}
                >
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    {match === "any" ? "Or" : "And"}
                </Button>
                {depth < GROUP_DEPTH_MAX ? (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-fit"
                        title="A group holds several conditions and is satisfied by any one of them"
                        onClick={() => onChange([...conditions, emptyGroup()])}
                    >
                        <Brackets className="size-3.5 shrink-0" aria-hidden="true" />
                        Group
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

const MATCH_OPTIONS = [
    { value: "any", label: "any of these" },
    { value: "all", label: "all of these" }
];

/** A group, drawn as an indented surface so the bracket in the expression preview has
 *  something on screen that corresponds to it. */
function ConditionGroupBlock({
    group,
    depth,
    removable,
    onChange,
    onRemove
}: {
    group: WafConditionGroup;
    depth: number;
    removable: boolean;
    onChange: (next: WafConditionGroup) => void;
    onRemove: () => void;
}) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 px-3 py-3">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Matches</span>
                <Select
                    value={group.match}
                    aria-label="How this group matches"
                    className="w-36"
                    options={MATCH_OPTIONS}
                    onValueChange={(value) => onChange({ ...group, match: value as WafConditionGroup["match"] })}
                />
                {removable ? (
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label="Remove this group"
                        title="Remove the group"
                        className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            <ConditionList
                conditions={group.conditions}
                match={group.match}
                depth={depth}
                // The schema types the innermost group as holding tests only, which is
                // the depth limit expressed in the type. The list above cannot produce
                // one deeper - it stops offering Group at GROUP_DEPTH_MAX - so this is
                // narrowing back to what was already true rather than asserting it.
                onChange={(conditions) => onChange({ ...group, conditions } as WafConditionGroup)}
            />
        </div>
    );
}

function ConditionRow({
    condition,
    removable,
    onChange,
    onRemove
}: {
    condition: WafLeafCondition;
    removable: boolean;
    onChange: (next: WafLeafCondition) => void;
    onRemove: () => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                    Field
                    <Select
                        value={condition.field}
                        aria-label="Field"
                        className="w-44"
                        options={FIELD_OPTIONS}
                        onValueChange={(value) => {
                            const field = value as WafRuleField;
                            // The address field takes different operators, so one that
                            // no longer applies is replaced rather than left reading
                            // wrong. Values go with it: an address list is not a
                            // sensible list of user agents.
                            const keepsOperator = field !== "ip" || IP_OPERATORS.includes(condition.operator);
                            const changedKind = (field === "ip") !== (condition.field === "ip");
                            onChange({
                                field,
                                operator: keepsOperator ? condition.operator : "equals",
                                values: changedKind ? [] : condition.values
                            });
                        }}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                    Operator
                    <Select
                        value={condition.operator}
                        aria-label="Operator"
                        className="w-48"
                        options={operatorOptions(condition.field)}
                        onValueChange={(value) => onChange({ ...condition, operator: value as WafRuleOperator })}
                    />
                </label>
                {removable ? (
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label="Remove this condition"
                        title="Remove"
                        className="mb-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                        <X className="size-3.5 shrink-0" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Value</span>
                <ChipList
                    entries={condition.values}
                    onChange={(values) => onChange({ ...condition, values })}
                    placeholder={VALUE_PLACEHOLDER[condition.field]}
                    validate={condition.field === "ip" ? validAddress : undefined}
                    invalidMessage={condition.field === "ip" ? "Enter an IP address or a CIDR range." : undefined}
                />
            </div>
        </div>
    );
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
