"use client";

/**
 * The rule's conditions, as rows you build or as text you write.
 *
 * The rows are the good way to write a first rule and the wrong way to write the
 * twentieth, so both are here and they are the same rule: switching to the expression
 * renders what the rows say, and switching back parses what was typed. Neither is a
 * draft of the other - the parse is refused rather than approximated, because a
 * condition quietly dropped from a firewall rule is the failure nobody sees.
 *
 * `And` and `Or` sit on each row rather than on the list, because that is the question
 * being asked at that moment: "and what else?" against this row. A row in an `and`
 * list that is given an `Or` becomes a group of its own holding the two - which is
 * what the brackets in the expression then say, and what the engine then does.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Button, Select } from "@polaris/ui";
import { ChipList, validAddress } from "./chip-list";
import { Plus, TriangleAlert, X } from "lucide-react";
import {
    emptyCondition,
    fieldValue,
    FIELD_OPTIONS,
    IP_OPERATORS,
    operatorOptions,
    SIGNAL_OPERATORS,
    VALUE_PLACEHOLDER
} from "./rule-language";

type WafCondition = core.WafCondition;
type WafConditionGroup = core.WafConditionGroup;
type WafLeafCondition = core.WafLeafCondition;
type WafSignalCondition = core.WafSignalCondition;

/** How deep a group may sit before the schema stops accepting one. The editor stops
 *  offering the join that would go deeper rather than letting a save fail on it. */
const GROUP_DEPTH_MAX = 2;

export function ConditionBuilder({
    conditions,
    onChange
}: {
    conditions: readonly WafCondition[];
    onChange: (next: WafCondition[]) => void;
}) {
    // The expression while it is being written. Null means the rows are in charge, so
    // the text is never a stale copy of a rule the rows have since changed.
    const [draft, setDraft] = useState<string | null>(null);
    const [problem, setProblem] = useState<string | null>(null);

    const expression = core.renderWafExpression(conditions);

    /** Take what was typed, or say why it cannot be taken. */
    function applyDraft(text: string): boolean {
        const parsed = core.parseWafExpression(text);
        if (!parsed.ok) {
            setProblem(parsed.error);
            return false;
        }
        onChange(core.foldWafValues(parsed.conditions));
        setProblem(null);
        return true;
    }

    if (draft !== null) {
        return (
            <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Expression</span>
                    <button
                        type="button"
                        onClick={() => {
                            if (applyDraft(draft)) setDraft(null);
                        }}
                        className="text-xs text-primary underline-offset-2 hover:underline"
                    >
                        Use the builder
                    </button>
                </div>
                <textarea
                    value={draft}
                    rows={4}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    aria-label="Rule expression"
                    aria-invalid={problem !== null}
                    maxLength={core.WAF_EXPRESSION_MAX}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        setProblem(null);
                    }}
                    onBlur={() => applyDraft(draft)}
                    className="w-full rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground "
                />
                <div className="flex items-baseline justify-between gap-2">
                    {problem ? (
                        <p className="flex items-start gap-1.5 text-xs text-danger">
                            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                            {problem}
                        </p>
                    ) : (
                        <p className="text-xs text-muted-foreground">
                            Fields are named as they are at the edge, joined with and / or and brackets.
                        </p>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {draft.length} / {core.WAF_EXPRESSION_MAX} characters
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <ConditionList conditions={conditions} match="all" depth={0} onChange={onChange} />

            <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground">Expression Preview</span>
                    <button
                        type="button"
                        onClick={() => {
                            setProblem(null);
                            setDraft(expression);
                        }}
                        className="text-xs text-primary underline-offset-2 hover:underline"
                    >
                        Edit expression
                    </button>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                    {expression || "Add a condition to see the expression."}
                </pre>
                <span className="self-end text-xs text-muted-foreground">
                    {expression.length} / {core.WAF_EXPRESSION_MAX} characters
                </span>
            </div>
        </div>
    );
}

/**
 * One level of the condition tree: the rule's own list, or a group's members.
 *
 * The joiner between rows is drawn here rather than by each row, because it is a fact
 * about the list they are in - "and" at the top, whichever word the group matches on
 * inside one.
 */
function ConditionList({
    conditions,
    match,
    depth,
    onChange
}: {
    conditions: readonly WafCondition[];
    match: "all" | "any";
    depth: number;
    onChange: (next: WafCondition[]) => void;
}) {
    const joiner = match === "any" ? "or" : "and";

    const replace = (at: number, next: WafCondition): void =>
        onChange(conditions.map((entry, index) => (index === at ? next : entry)));

    /**
     * Add a condition next to the one at `at`, joined by `how`.
     *
     * Joining the way the list already reads is an append. Joining the other way turns
     * that one row into a group holding both, which is what the brackets in the
     * expression are about - and it is refused rather than done badly when the group
     * would sit deeper than a rule may go.
     */
    const join = (at: number, how: "all" | "any"): void => {
        if (how === match) {
            const next = [...conditions];
            next.splice(at + 1, 0, emptyCondition());
            onChange(next);
            return;
        }
        const here = conditions[at];
        if (!here) return;
        replace(at, { match: how, conditions: [here, emptyCondition()] } as WafConditionGroup);
    };

    return (
        <div className="flex flex-col gap-2">
            {conditions.map((condition, at) => {
                const canWrap = depth < GROUP_DEPTH_MAX && !core.isWafConditionGroup(condition);
                return (
                    <div key={at} className="flex flex-col gap-2">
                        {at === 0 ? null : <span className="text-xs font-medium text-muted-foreground">{joiner}</span>}
                        {core.isWafConditionGroup(condition) ? (
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
                                canWrap={canWrap}
                                onChange={(next) => replace(at, next)}
                                onJoin={(how) => join(at, how)}
                                onRemove={() => onChange(conditions.filter((_, index) => index !== at))}
                            />
                        )}
                    </div>
                );
            })}

            {conditions.length === 0 ? (
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-fit"
                    onClick={() => onChange([emptyCondition()])}
                >
                    <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                    Add a condition
                </Button>
            ) : null}
        </div>
    );
}

const MATCH_OPTIONS = [
    { value: "any", label: "any of these" },
    { value: "all", label: "all of these" }
];

/** A group, drawn as an indented surface so the bracket in the expression has
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
                        className="ml-auto inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-danger "
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
                // one deeper - it stops offering the join at GROUP_DEPTH_MAX - so this
                // narrows back to what was already true rather than asserting it.
                onChange={(conditions) => onChange({ ...group, conditions } as WafConditionGroup)}
            />
        </div>
    );
}

function ConditionRow({
    condition,
    removable,
    canWrap,
    onChange,
    onJoin,
    onRemove
}: {
    condition: WafLeafCondition | WafSignalCondition;
    removable: boolean;
    /** Whether the join that would open a group is still within the nesting limit. */
    canWrap: boolean;
    onChange: (next: WafCondition) => void;
    onJoin: (how: "all" | "any") => void;
    onRemove: () => void;
}) {
    // Split rather than narrowed in place: both halves of this row read one or the
    // other, and a check at every use would say the same thing eight times.
    const signal = core.isWafSignalCondition(condition) ? condition : null;
    const leaf = signal ? null : (condition as WafLeafCondition);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                    Field
                    <Select
                        value={fieldValue(condition)}
                        aria-label="Field"
                        className="w-52"
                        options={FIELD_OPTIONS}
                        onValueChange={(value) => onChange(fieldChanged(condition, value))}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-muted-foreground">
                    Operator
                    {signal || !leaf ? (
                        <Select
                            value={signal?.negate ? "not_matches" : "matches"}
                            aria-label="Operator"
                            className="w-56"
                            options={SIGNAL_OPERATORS}
                            onValueChange={(value) =>
                                signal && onChange({ ...signal, negate: value === "not_matches" })
                            }
                        />
                    ) : (
                        <Select
                            value={leaf.operator}
                            aria-label="Operator"
                            className="w-48"
                            options={operatorOptions(leaf.field)}
                            onValueChange={(value) => onChange({ ...leaf, operator: value as core.WafRuleOperator })}
                        />
                    )}
                </label>

                <div className="mb-1 ml-auto flex shrink-0 items-center gap-1">
                    <JoinButton label="And" disabled={!canWrap} onClick={() => onJoin("all")} />
                    <JoinButton label="Or" disabled={!canWrap} onClick={() => onJoin("any")} />
                    {removable ? (
                        <button
                            type="button"
                            onClick={onRemove}
                            aria-label="Remove this condition"
                            title="Remove"
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-danger "
                        >
                            <X className="size-3.5 shrink-0" aria-hidden="true" />
                        </button>
                    ) : null}
                </div>
            </div>

            {leaf ? (
                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Value</span>
                    <ChipList
                        entries={leaf.values}
                        onChange={(values) => onChange({ ...leaf, values })}
                        placeholder={VALUE_PLACEHOLDER[leaf.field]}
                        validate={leaf.field === "ip" ? validAddress : undefined}
                        invalidMessage={leaf.field === "ip" ? "Enter an IP address or a CIDR range." : undefined}
                    />
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    Reads the same check the managed rule does, so it can be narrowed to part of the traffic instead of
                    switched off for the whole scope.
                </p>
            )}
        </div>
    );
}

/** The condition a change of field leaves behind. */
function fieldChanged(condition: WafLeafCondition | WafSignalCondition, value: string): WafCondition {
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

/** One of the two words a row can be joined to the next by. */
function JoinButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            title={disabled ? "A rule cannot nest any deeper" : `Add a condition joined by ${label.toLowerCase()}`}
            className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40 "
        >
            {label}
        </button>
    );
}
