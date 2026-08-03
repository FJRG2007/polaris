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
import { Button, Input, Select } from "@polaris/ui";
import { ChipList, validAddress } from "./chip-list";
import { ArrowLeft, Plus, TriangleAlert, X } from "lucide-react";
import type { WafCondition, WafCustomRule, WafRuleField, WafRuleOperator } from "@polaris/core";
import {
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

/** Why this rule cannot be saved yet, or null when it can. Every reason is something
 *  the reader can see and fix on this screen. */
function blockingReason(rule: WafCustomRule): string | null {
    if (rule.name.trim() === "") return "Give the rule a name.";
    if (rule.conditions.length === 0) return "Add at least one condition.";
    if (rule.conditions.some((condition) => condition.values.length === 0)) {
        return "Every condition needs at least one value.";
    }
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

    function patchCondition(at: number, next: WafCondition) {
        setRule({ ...rule, conditions: rule.conditions.map((entry, i) => (i === at ? next : entry)) });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    aria-label="Back to the rule list"
                    title="Back"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
                </button>
                <h2 className="min-w-0 truncate text-lg font-semibold">
                    {creating ? "Create custom rule" : "Edit custom rule"}
                </h2>
            </div>

            <Field
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
            </Field>

            <Field
                title="When incoming requests match..."
                hint="Every condition must hold. Within one condition, any of its values is enough."
            >
                <div className="flex flex-col gap-3">
                    {rule.conditions.map((condition, at) => (
                        <ConditionRow
                            key={at}
                            condition={condition}
                            first={at === 0}
                            removable={rule.conditions.length > 1}
                            onChange={(next) => patchCondition(at, next)}
                            onRemove={() =>
                                setRule({ ...rule, conditions: rule.conditions.filter((_, i) => i !== at) })
                            }
                        />
                    ))}
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-fit"
                        onClick={() =>
                            setRule({
                                ...rule,
                                conditions: [...rule.conditions, { field: "path", operator: "contains", values: [] }]
                            })
                        }
                    >
                        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                        And
                    </Button>

                    <div className="mt-1 flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Expression preview</span>
                        <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                            {expression || "Add a condition to see the expression."}
                        </pre>
                    </div>
                </div>
            </Field>

            <Field title="Then take action...">
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
            </Field>

            <Field
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
            </Field>

            <Field title="Status" hint="Controls whether the rule evaluates incoming traffic.">
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
            </Field>

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

/** One titled block of the form. A sibling surface rather than a card inside the
 *  page's card - the same reason the list is a table and not a stack of boxes. */
function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4">
            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">{title}</h3>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            {children}
        </section>
    );
}

function ConditionRow({
    condition,
    first,
    removable,
    onChange,
    onRemove
}: {
    condition: WafCondition;
    first: boolean;
    removable: boolean;
    onChange: (next: WafCondition) => void;
    onRemove: () => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            {first ? null : <span className="text-xs font-medium text-muted-foreground">and</span>}
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
