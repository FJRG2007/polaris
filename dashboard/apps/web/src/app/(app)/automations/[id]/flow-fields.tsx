"use client";

/**
 * The settings of the flow-control nodes (Choose, At the same time, Join,
 * loops, Stop, waits for an announcement, calls between automations) and the
 * pieces several nodes share: the AND/OR/NOT condition editor, "if this
 * fails" with its retry, and how the triggers combine. Used by the list view
 * and the canvas's side panel alike; every value is checked by the node's Zod
 * config on save and publish.
 */

import * as core from "@polaris/core";
import { nodeTitle } from "../shared";
import { RefInput } from "./references";
import { Plus, Trash2 } from "lucide-react";
import { Field, type T } from "./node-fields";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AutomationDetail } from "@/lib/automations/service";
import { Button, Checkbox, Input, Select, Switch, type SelectOption } from "@polaris/ui";

type Config = Record<string, any>;
const L = core.AUTOMATION_LIMITS;

/** Node types whose settings live here. */
export const FLOW_FIELD_TYPES = new Set([
    "core.called",
    "core.onEvent",
    "core.failed",
    "core.switch",
    "core.parallel",
    "core.join",
    "core.forEach",
    "core.repeat",
    "core.stop",
    "core.waitEvent",
    "core.run",
    "core.answer",
    "core.set",
    "core.announce",
    "core.try",
    "core.waitCondition"
]);

const emptyCompare = (): core.CompareLeaf => ({ kind: "compare", left: "", op: "eq", right: "" });
export const emptyCondition = (): core.ConditionGroup => ({
    kind: "group",
    join: "all",
    items: [emptyCompare()]
});

function clampInt(value: string, min: number, max: number): number {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function NumberInput({
    value,
    min,
    max,
    label,
    onChange
}: {
    value: number;
    min: number;
    max: number;
    label: string;
    onChange: (value: number) => void;
}) {
    return (
        <Field label={label}>
            <Input
                type="number"
                min={min}
                max={max}
                value={String(value)}
                onChange={(event) => onChange(clampInt(event.target.value, min, max))}
            />
        </Field>
    );
}

/** The triggers a "Triggered by" condition can name: the graph's trigger nodes. */
export function triggerChoices(t: T, graph: core.AutomationGraph): { id: string; label: string }[] {
    return core.triggerNodes(graph).map((node, index) => ({
        id: node.id,
        label: `${index + 1}. ${node.alias || nodeTitle(t, node.type)}`
    }));
}

/** An AND/OR group with an optional NOT, nested up to the schema's depth. */
export function ConditionEditor({
    value,
    onChange,
    triggers,
    depth = 0
}: {
    value: core.ConditionGroup;
    onChange: (group: core.ConditionGroup) => void;
    triggers: readonly { id: string; label: string }[];
    depth?: number;
}) {
    const t = useTranslations("automations");
    const setItem = (index: number, item: core.ConditionNode | null) =>
        onChange({
            ...value,
            items: item
                ? value.items.map((entry, at) => (at === index ? item : entry))
                : value.items.filter((_, at) => at !== index)
        });
    const full = value.items.length >= 20;
    const remove = (index: number) => (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("editor.remove")}
            title={t("editor.remove")}
            onClick={() => setItem(index, null)}
        >
            <Trash2 aria-hidden="true" />
        </Button>
    );
    return (
        <div
            className={depth > 0 ? "space-y-2 rounded-md border border-border p-2" : "space-y-2"}
            role="group"
            aria-label={t("flow.conditionGroup")}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Select
                    value={value.join}
                    onValueChange={(join) => onChange({ ...value, join: join as "all" | "any" })}
                    options={[
                        { value: "all", label: t("fields.joinAll") },
                        { value: "any", label: t("fields.joinAny") }
                    ]}
                    aria-label={t("fields.join")}
                    className="w-full sm:w-56"
                />
                <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                        checked={value.negate === true}
                        onChange={(event) =>
                            onChange({ ...value, negate: event.target.checked || undefined })
                        }
                    />
                    {t("flow.negate")}
                </label>
            </div>
            {value.items.map((item, index) =>
                item.kind === "group" ? (
                    <div key={index} className="flex min-w-0 items-start gap-1">
                        <div className="min-w-0 flex-1">
                            <ConditionEditor
                                value={item}
                                onChange={(group) => setItem(index, group)}
                                triggers={triggers}
                                depth={depth + 1}
                            />
                        </div>
                        {remove(index)}
                    </div>
                ) : item.kind === "triggeredBy" ? (
                    <div key={index} className="flex min-w-0 items-start gap-2">
                        <div className="min-w-0 flex-1 space-y-1 text-sm">
                            <span>{t("flow.triggeredBy")}</span>
                            <div className="flex flex-wrap gap-3">
                                {triggers.map((choice) => (
                                    <label
                                        key={choice.id}
                                        className="flex min-w-0 items-center gap-1 text-xs"
                                    >
                                        <Checkbox
                                            checked={item.triggers.includes(choice.id)}
                                            onChange={(event) =>
                                                setItem(index, {
                                                    ...item,
                                                    triggers: event.target.checked
                                                        ? [...item.triggers, choice.id]
                                                        : item.triggers.filter(
                                                              (id) => id !== choice.id
                                                          )
                                                })
                                            }
                                        />
                                        <span className="truncate" title={choice.label}>
                                            {choice.label}
                                        </span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        {remove(index)}
                    </div>
                ) : (
                    <div
                        key={index}
                        className="grid min-w-0 gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]"
                    >
                        <RefInput
                            aria-label={t("fields.left")}
                            placeholder="{{trigger.body.value}}"
                            value={item.left}
                            onChange={(event) =>
                                setItem(index, { ...item, left: event.target.value })
                            }
                        />
                        <Select
                            value={item.op}
                            onValueChange={(op) =>
                                setItem(index, { ...item, op: op as core.CompareOperator })
                            }
                            options={core.COMPARE_OPERATORS.map((op) => ({
                                value: op,
                                label: t(`operators.${op}`)
                            }))}
                            aria-label={t("fields.op")}
                        />
                        {core.UNARY_OPERATORS.includes(item.op) ? (
                            <span />
                        ) : (
                            <RefInput
                                aria-label={t("fields.right")}
                                value={item.right}
                                onChange={(event) =>
                                    setItem(index, { ...item, right: event.target.value })
                                }
                            />
                        )}
                        {remove(index)}
                    </div>
                )
            )}
            <div className="flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    size="sm"
                    disabled={full}
                    onClick={() => onChange({ ...value, items: [...value.items, emptyCompare()] })}
                >
                    {t("fields.addCondition")}
                </Button>
                {depth < 3 ? (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={full}
                        onClick={() =>
                            onChange({
                                ...value,
                                items: [...value.items, { ...emptyCondition(), join: "any" }]
                            })
                        }
                    >
                        {t("flow.addGroup")}
                    </Button>
                ) : null}
                {triggers.length > 1 ? (
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={full}
                        onClick={() =>
                            onChange({
                                ...value,
                                items: [...value.items, { kind: "triggeredBy", triggers: [] }]
                            })
                        }
                    >
                        {t("flow.addTriggeredBy")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}

/** Named values with references: a call's inputs, an Answer's outputs, an announcement's data. */
function Pairs({
    value,
    onChange,
    label
}: {
    value: { name: string; value: string }[];
    onChange: (pairs: { name: string; value: string }[]) => void;
    label: string;
}) {
    const t = useTranslations("automations");
    const setAt = (index: number, change: Partial<{ name: string; value: string }>) =>
        onChange(value.map((entry, at) => (at === index ? { ...entry, ...change } : entry)));
    return (
        <div className="space-y-2" role="group" aria-label={label}>
            <p className="text-sm">{label}</p>
            {value.map((pair, index) => (
                <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-[12rem_1fr_auto]">
                    <Input
                        aria-label={t("flow.valueName")}
                        placeholder={t("flow.valueName")}
                        value={pair.name}
                        maxLength={64}
                        onChange={(event) => setAt(index, { name: event.target.value.trim() })}
                    />
                    <RefInput
                        aria-label={t("flow.value")}
                        value={pair.value}
                        onChange={(event) => setAt(index, { value: event.target.value })}
                    />
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("editor.remove")}
                        title={t("editor.remove")}
                        onClick={() => onChange(value.filter((_, at) => at !== index))}
                    >
                        <Trash2 aria-hidden="true" />
                    </Button>
                </div>
            ))}
            <Button
                variant="outline"
                size="sm"
                disabled={value.length >= L.callInputs}
                onClick={() => onChange([...value, { name: "", value: "" }])}
            >
                <Plus aria-hidden="true" />
                {t("flow.addValue")}
            </Button>
        </div>
    );
}

function Duration({
    value,
    onChange,
    label
}: {
    value: { amount: number; unit: string };
    onChange: (value: { amount: number; unit: string }) => void;
    label: string;
}) {
    const t = useTranslations("automations");
    const units: SelectOption[] = [
        { value: "seconds", label: t("fields.seconds") },
        { value: "minutes", label: t("fields.minutes") },
        { value: "hours", label: t("fields.hours") },
        { value: "days", label: t("fields.days") }
    ];
    return (
        <div className="grid gap-2 sm:grid-cols-2">
            <NumberInput
                label={label}
                value={value.amount}
                min={1}
                max={100000}
                onChange={(amount) => onChange({ ...value, amount })}
            />
            <Field label={t("fields.unit")}>
                <Select
                    value={value.unit}
                    onValueChange={(unit) => onChange({ ...value, unit })}
                    options={units}
                    aria-label={t("fields.unit")}
                />
            </Field>
        </div>
    );
}

function EventName({ value, onChange }: { value: string; onChange: (name: string) => void }) {
    const t = useTranslations("automations");
    return (
        <Field label={t("flow.eventName")}>
            <Input
                value={value}
                maxLength={64}
                placeholder="order.paid"
                onChange={(event) => onChange(event.target.value.trim().toLowerCase())}
            />
        </Field>
    );
}

/**
 * The built-in "automation.finished" event: a button that picks it, and once
 * picked, which endings of the other automation count.
 */
function FinishedEvent({
    config,
    set,
    example
}: {
    config: Config;
    set: (change: Config) => void;
    /** Where the steps after it read the ending. */
    example: string;
}) {
    const t = useTranslations("automations");
    const name = core.AUTOMATION_FINISHED_EVENT;
    if (config.name !== name)
        return (
            <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-muted-foreground">
                    {t("flow.builtInEvent", { name })}
                </p>
                <Button size="sm" variant="outline" onClick={() => set({ name, outcomes: [] })}>
                    {t("flow.useFinished")}
                </Button>
            </div>
        );
    const picked = (config.outcomes ?? []) as string[];
    return (
        <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("flow.outcomes")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                {core.FINISHED_EVENT_OUTCOMES.map((outcome) => (
                    <label key={outcome} className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={picked.includes(outcome)}
                            onChange={(event) =>
                                set({
                                    outcomes: event.target.checked
                                        ? [...picked, outcome]
                                        : picked.filter((entry) => entry !== outcome)
                                })
                            }
                        />
                        {t(`status.${outcome}`)}
                    </label>
                ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("flow.outcomesAny", { example })}</p>
        </fieldset>
    );
}

export function FlowNodeFields({
    node,
    setConfig,
    detail
}: {
    node: core.GraphNode;
    setConfig: (config: unknown) => void;
    detail: AutomationDetail;
}) {
    const t = useTranslations("automations");
    const config = (node.config ?? {}) as Config;
    const set = (change: Config) => setConfig({ ...config, ...change });
    const triggers = triggerChoices(t, detail.draft);
    const others = detail.others ?? [];
    const hint = (text: string) => <p className="text-xs text-muted-foreground">{text}</p>;

    switch (node.type) {
        case "core.called": {
            const inputs = (config.inputs ?? []) as core.CalledConfig["inputs"];
            const setInputs = (next: core.CalledConfig["inputs"]) => set({ inputs: next });
            return (
                <div className="space-y-2">
                    {hint(t("nodeHints.called"))}
                    {inputs.map((input, index) => (
                        <div
                            key={index}
                            className="grid min-w-0 gap-2 sm:grid-cols-[1fr_9rem_auto_auto]"
                        >
                            <Input
                                aria-label={t("flow.valueName")}
                                placeholder={t("flow.valueName")}
                                value={input.name}
                                maxLength={64}
                                onChange={(event) =>
                                    setInputs(
                                        inputs.map((entry, at) =>
                                            at === index
                                                ? { ...entry, name: event.target.value.trim() }
                                                : entry
                                        )
                                    )
                                }
                            />
                            <Select
                                value={input.kind}
                                onValueChange={(kind) =>
                                    setInputs(
                                        inputs.map((entry, at) =>
                                            at === index
                                                ? {
                                                      ...entry,
                                                      kind: kind as (typeof core.CALL_INPUT_KINDS)[number]
                                                  }
                                                : entry
                                        )
                                    )
                                }
                                options={core.CALL_INPUT_KINDS.map((kind) => ({
                                    value: kind,
                                    label: t(`flow.kinds.${kind}`)
                                }))}
                                aria-label={t("flow.kind")}
                            />
                            <label className="flex items-center gap-1 text-xs">
                                <Checkbox
                                    checked={input.required}
                                    onChange={(event) =>
                                        setInputs(
                                            inputs.map((entry, at) =>
                                                at === index
                                                    ? { ...entry, required: event.target.checked }
                                                    : entry
                                            )
                                        )
                                    }
                                />
                                {t("flow.required")}
                            </label>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("editor.remove")}
                                title={t("editor.remove")}
                                onClick={() => setInputs(inputs.filter((_, at) => at !== index))}
                            >
                                <Trash2 aria-hidden="true" />
                            </Button>
                        </div>
                    ))}
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={inputs.length >= L.callInputs}
                        onClick={() =>
                            setInputs([...inputs, { name: "", kind: "text", required: false }])
                        }
                    >
                        <Plus aria-hidden="true" />
                        {t("flow.addInput")}
                    </Button>
                </div>
            );
        }
        case "core.onEvent":
            return (
                <div className="space-y-2">
                    <EventName value={config.name ?? ""} onChange={(name) => set({ name })} />
                    {hint(t("nodeHints.onEvent"))}
                    <FinishedEvent
                        config={config}
                        set={set}
                        example="{{trigger.payload.outcome}}"
                    />
                </div>
            );
        case "core.failed": {
            const watched = (config.automations ?? []) as string[];
            return (
                <div className="space-y-2">
                    {hint(t("nodeHints.failed"))}
                    {others.length === 0 ? hint(t("flow.noOthers")) : null}
                    <div className="flex flex-col gap-1">
                        {others.map((other) => (
                            <label
                                key={other.id}
                                className="flex min-w-0 items-center gap-2 text-sm"
                            >
                                <Checkbox
                                    checked={watched.includes(other.id)}
                                    onChange={(event) =>
                                        set({
                                            automations: event.target.checked
                                                ? [...watched, other.id]
                                                : watched.filter((id) => id !== other.id)
                                        })
                                    }
                                />
                                <span className="truncate" title={other.name}>
                                    {other.name}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>
            );
        }
        case "core.switch": {
            const rules = config.kind !== "value";
            const cases = (config.cases ?? []) as Config[];
            const setCase = (index: number, change: Config) =>
                set({
                    cases: cases.map((entry, at) =>
                        at === index ? { ...entry, ...change } : entry
                    )
                });
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.switch"))}
                    <Field label={t("flow.chooseBy")}>
                        <Select
                            value={rules ? "rules" : "value"}
                            onValueChange={(kind) =>
                                setConfig(
                                    kind === "rules"
                                        ? {
                                              kind,
                                              cases: [{ label: "", condition: emptyCondition() }],
                                              every: false,
                                              fallback: true
                                          }
                                        : {
                                              kind,
                                              value: "",
                                              cases: [{ label: "", equals: "" }],
                                              ignoreCase: true,
                                              fallback: true
                                          }
                                )
                            }
                            options={[
                                { value: "rules", label: t("flow.byRules") },
                                { value: "value", label: t("flow.byValue") }
                            ]}
                            aria-label={t("flow.chooseBy")}
                        />
                    </Field>
                    {rules ? null : (
                        <Field label={t("flow.valueToMatch")}>
                            <RefInput
                                value={config.value ?? ""}
                                onChange={(event) => set({ value: event.target.value })}
                            />
                        </Field>
                    )}
                    {cases.map((entry, index) => (
                        <div key={index} className="space-y-2 rounded-md border border-border p-2">
                            <div className="flex min-w-0 items-end gap-2">
                                <div className="min-w-0 flex-1">
                                    <Field label={t("flow.caseLabel", { number: index + 1 })}>
                                        <Input
                                            value={entry.label ?? ""}
                                            maxLength={60}
                                            onChange={(event) =>
                                                setCase(index, { label: event.target.value })
                                            }
                                        />
                                    </Field>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    disabled={cases.length === 1}
                                    aria-label={t("editor.remove")}
                                    title={t("editor.remove")}
                                    onClick={() =>
                                        set({ cases: cases.filter((_, at) => at !== index) })
                                    }
                                >
                                    <Trash2 aria-hidden="true" />
                                </Button>
                            </div>
                            {rules ? (
                                <ConditionEditor
                                    value={entry.condition as core.ConditionGroup}
                                    onChange={(condition) => setCase(index, { condition })}
                                    triggers={triggers}
                                />
                            ) : (
                                <Field label={t("flow.equals")}>
                                    <RefInput
                                        value={entry.equals ?? ""}
                                        onChange={(event) =>
                                            setCase(index, { equals: event.target.value })
                                        }
                                    />
                                </Field>
                            )}
                        </div>
                    ))}
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={cases.length >= L.switchCases}
                        onClick={() =>
                            set({
                                cases: [
                                    ...cases,
                                    rules
                                        ? { label: "", condition: emptyCondition() }
                                        : { label: "", equals: "" }
                                ]
                            })
                        }
                    >
                        <Plus aria-hidden="true" />
                        {t("flow.addCase")}
                    </Button>
                    <div className="flex flex-wrap gap-4">
                        {rules ? (
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={config.every === true}
                                    onChange={(event) => set({ every: event.target.checked })}
                                />
                                {t("flow.every")}
                            </label>
                        ) : (
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={config.ignoreCase !== false}
                                    onChange={(event) => set({ ignoreCase: event.target.checked })}
                                />
                                {t("flow.ignoreCase")}
                            </label>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox
                                checked={config.fallback !== false}
                                onChange={(event) => set({ fallback: event.target.checked })}
                            />
                            {t("flow.fallback")}
                        </label>
                    </div>
                </div>
            );
        }
        case "core.parallel":
            return (
                <div className="space-y-2">
                    {hint(t("nodeHints.parallel"))}
                    <NumberInput
                        label={t("flow.lanes")}
                        value={config.lanes ?? 2}
                        min={2}
                        max={L.parallelLanes}
                        onChange={(lanes) => set({ lanes })}
                    />
                </div>
            );
        case "core.join": {
            const inputs = [
                ...new Set(
                    detail.draft.edges
                        .filter((edge) => edge.to.node === node.id)
                        .map((edge) => edge.from.node)
                )
            ];
            const label = (id: string) => {
                const from = detail.draft.nodes.find((entry) => entry.id === id);
                return from ? from.alias || nodeTitle(t, from.type) : id;
            };
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.join"))}
                    <Field label={t("flow.joinWait")}>
                        <Select
                            value={config.wait ?? "all"}
                            onValueChange={(wait) => set({ wait })}
                            options={core.JOIN_WAITS.map((wait) => ({
                                value: wait,
                                label: t(`flow.joinWaits.${wait}`)
                            }))}
                            aria-label={t("flow.joinWait")}
                        />
                    </Field>
                    {config.wait === "count" ? (
                        <NumberInput
                            label={t("flow.joinCount")}
                            value={config.count ?? 2}
                            min={1}
                            max={L.joinInputs}
                            onChange={(count) => set({ count })}
                        />
                    ) : null}
                    <Field label={t("flow.joinOutput")}>
                        <Select
                            value={config.output ?? "byInput"}
                            onValueChange={(output) => set({ output })}
                            options={core.JOIN_OUTPUTS.map((output) => ({
                                value: output,
                                label: t(`flow.joinOutputs.${output}`)
                            }))}
                            aria-label={t("flow.joinOutput")}
                        />
                    </Field>
                    {config.output === "keep" ? (
                        <Field label={t("flow.joinKeep")}>
                            <Select
                                value={config.keep ?? ""}
                                placeholder={t("flow.joinKeepFirst")}
                                onValueChange={(keep) => set({ keep })}
                                options={inputs.map((id) => ({ value: id, label: label(id) }))}
                                aria-label={t("flow.joinKeep")}
                            />
                        </Field>
                    ) : null}
                </div>
            );
        }
        case "core.forEach":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.forEach"))}
                    <Field label={t("flow.items")}>
                        <RefInput
                            value={config.items ?? ""}
                            placeholder="{{steps.http1.body.items}}"
                            onChange={(event) => set({ items: event.target.value })}
                        />
                    </Field>
                    <NumberInput
                        label={t("flow.batch")}
                        value={config.batch ?? 1}
                        min={1}
                        max={L.loopBatch}
                        onChange={(batch) => set({ batch })}
                    />
                    {hint(t("flow.itemHint", { item: "{{item}}", index: "{{index}}" }))}
                </div>
            );
        case "core.repeat":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.repeat"))}
                    <Field label={t("flow.repeatKind")}>
                        <Select
                            value={config.kind ?? "times"}
                            onValueChange={(kind) =>
                                setConfig(
                                    kind === "times"
                                        ? { kind, count: 3 }
                                        : { kind, max: 10, condition: emptyCondition() }
                                )
                            }
                            options={[
                                { value: "times", label: t("flow.repeatTimes") },
                                { value: "until", label: t("flow.repeatUntil") }
                            ]}
                            aria-label={t("flow.repeatKind")}
                        />
                    </Field>
                    {config.kind === "until" ? (
                        <>
                            <ConditionEditor
                                value={config.condition as core.ConditionGroup}
                                onChange={(condition) => set({ condition })}
                                triggers={triggers}
                            />
                            <NumberInput
                                label={t("flow.maxPasses")}
                                value={config.max ?? 10}
                                min={1}
                                max={L.repeatPasses}
                                onChange={(max) => set({ max })}
                            />
                        </>
                    ) : (
                        <NumberInput
                            label={t("flow.passes")}
                            value={config.count ?? 3}
                            min={1}
                            max={L.repeatPasses}
                            onChange={(count) => set({ count })}
                        />
                    )}
                </div>
            );
        case "core.stop":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.stop"))}
                    <Field label={t("flow.stopAs")}>
                        <Select
                            value={config.as ?? "succeeded"}
                            onValueChange={(as) => set({ as })}
                            options={[
                                { value: "succeeded", label: t("flow.stopSucceeded") },
                                { value: "failed", label: t("flow.stopFailed") }
                            ]}
                            aria-label={t("flow.stopAs")}
                        />
                    </Field>
                    <Field label={t("flow.reason")}>
                        <RefInput
                            value={config.reason ?? ""}
                            maxLength={200}
                            onChange={(event) => set({ reason: event.target.value })}
                        />
                    </Field>
                </div>
            );
        case "core.waitEvent":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.waitEvent"))}
                    <EventName value={config.name ?? ""} onChange={(name) => set({ name })} />
                    <FinishedEvent
                        config={config}
                        set={set}
                        example={`{{steps.${node.id}.payload.outcome}}`}
                    />
                    <Duration
                        label={t("flow.timeout")}
                        value={config.timeout ?? { amount: 1, unit: "hours" }}
                        onChange={(timeout) => set({ timeout })}
                    />
                    <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                            checked={Boolean(config.filter)}
                            onChange={(event) =>
                                set({ filter: event.target.checked ? emptyCondition() : undefined })
                            }
                        />
                        {t("flow.onlyWhen")}
                    </label>
                    {config.filter ? (
                        <>
                            {hint(t("flow.filterHint", { example: "{{event.status}}" }))}
                            <ConditionEditor
                                value={config.filter as core.ConditionGroup}
                                onChange={(filter) => set({ filter })}
                                triggers={[]}
                            />
                        </>
                    ) : null}
                </div>
            );
        case "core.try":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.try"))}
                    <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0">{t("flow.recover")}</span>
                        <Switch
                            checked={config.recover === true}
                            aria-label={t("flow.recover")}
                            onChange={(on: boolean) => set({ recover: on })}
                        />
                    </label>
                    {hint(t(config.recover === true ? "flow.recoverOn" : "flow.recoverOff"))}
                    {hint(t("flow.tryErrorHint", { example: `{{steps.${node.id}.error}}` }))}
                </div>
            );
        case "core.waitCondition":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.waitCondition"))}
                    <ConditionEditor
                        value={(config.condition as core.ConditionGroup) ?? emptyCondition()}
                        onChange={(condition) => set({ condition })}
                        triggers={triggers}
                    />
                    {hint(t("flow.conditionWaitHint", { example: "{{event.payload.status}}" }))}
                    <Duration
                        label={t("flow.timeout")}
                        value={config.timeout ?? { amount: 1, unit: "hours" }}
                        onChange={(timeout) => set({ timeout })}
                    />
                    <Duration
                        label={t("flow.recheckEvery")}
                        value={config.every ?? { amount: 5, unit: "minutes" }}
                        onChange={(every) => set({ every })}
                    />
                    {core.durationSeconds(config.every ?? { amount: 5, unit: "minutes" }) <
                        L.conditionRecheckMinSeconds ||
                    core.durationSeconds(config.every ?? { amount: 5, unit: "minutes" }) >
                        L.conditionRecheckMaxSeconds ? (
                        <p role="alert" className="text-xs text-danger">
                            {t("flow.recheckRange")}
                        </p>
                    ) : null}
                </div>
            );
        case "core.run":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.run"))}
                    <Field label={t("flow.automation")}>
                        <Select
                            value={
                                others.some((other) => other.id === config.automationId)
                                    ? config.automationId
                                    : ""
                            }
                            placeholder={
                                others.length ? t("flow.chooseAutomation") : t("flow.noOthers")
                            }
                            onValueChange={(automationId) => set({ automationId })}
                            options={others.map((other) => ({
                                value: other.id,
                                label: other.name
                            }))}
                            aria-label={t("flow.automation")}
                        />
                    </Field>
                    <Pairs
                        label={t("flow.inputs")}
                        value={config.inputs ?? []}
                        onChange={(inputs) => set({ inputs })}
                    />
                    <label className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0">{t("flow.waitForIt")}</span>
                        <Switch
                            checked={config.wait !== false}
                            aria-label={t("flow.waitForIt")}
                            onChange={(on: boolean) => set({ wait: on })}
                        />
                    </label>
                </div>
            );
        case "core.answer":
            return (
                <div className="space-y-2">
                    {hint(t("nodeHints.answer"))}
                    <Pairs
                        label={t("flow.outputs")}
                        value={config.outputs ?? []}
                        onChange={(outputs) => set({ outputs })}
                    />
                </div>
            );
        case "core.set":
            return (
                <div className="space-y-2">
                    {hint(t("nodeHints.set"))}
                    <Pairs
                        label={t("flow.values")}
                        value={config.values ?? []}
                        onChange={(values) => set({ values })}
                    />
                </div>
            );
        case "core.announce":
            return (
                <div className="space-y-3">
                    {hint(t("nodeHints.announce"))}
                    <EventName value={config.name ?? ""} onChange={(name) => set({ name })} />
                    {core.isReservedEventName(String(config.name ?? "")) ? (
                        <p role="alert" className="text-xs text-danger">
                            {t("flow.eventNameReserved", { prefix: core.RESERVED_EVENT_PREFIX })}
                        </p>
                    ) : null}
                    <Pairs
                        label={t("flow.payload")}
                        value={config.payload ?? []}
                        onChange={(payload) => set({ payload })}
                    />
                </div>
            );
        default:
            return null;
    }
}

type Retry = NonNullable<core.GraphNode["retry"]>;

/** "If this fails" and the retry, for every node that can fail on its own. */
export function FailureFields({
    node,
    onChange,
    allowPort
}: {
    node: core.GraphNode;
    onChange: (change: Partial<core.GraphNode>) => void;
    /** The error port is drawn only on the canvas. */
    allowPort: boolean;
}) {
    const t = useTranslations("automations");
    if (!core.canTakeErrorPort(node.type)) return null;
    const retry = node.retry;
    const setRetry = (change: Partial<Retry>) =>
        onChange({ retry: { tries: 3, waitSeconds: 30, backoff: "fixed", ...retry, ...change } });
    return (
        <div className="space-y-3">
            <Field label={t("editor.ifFails")}>
                <Select
                    value={node.onError ?? "stop"}
                    onValueChange={(value) =>
                        onChange({ onError: value as "stop" | "continue" | "port" })
                    }
                    options={[
                        { value: "stop", label: t("editor.onErrorStop") },
                        { value: "continue", label: t("editor.onErrorContinue") },
                        ...(allowPort || node.onError === "port"
                            ? [{ value: "port", label: t("editor.onErrorPort") }]
                            : [])
                    ]}
                    aria-label={t("editor.ifFails")}
                />
            </Field>
            <label className="flex items-center gap-2 text-sm">
                <Checkbox
                    checked={Boolean(retry)}
                    onChange={(event) =>
                        onChange({
                            retry: event.target.checked
                                ? { tries: 3, waitSeconds: 30, backoff: "fixed" }
                                : undefined
                        })
                    }
                />
                {t("flow.retry")}
            </label>
            {retry ? (
                <div className="grid gap-2 sm:grid-cols-3">
                    <NumberInput
                        label={t("flow.tries")}
                        value={retry.tries}
                        min={2}
                        max={L.retryTries}
                        onChange={(tries) => setRetry({ tries })}
                    />
                    <NumberInput
                        label={t("flow.retryWait")}
                        value={retry.waitSeconds}
                        min={1}
                        max={L.retryWaitSeconds}
                        onChange={(waitSeconds) => setRetry({ waitSeconds })}
                    />
                    <Field label={t("flow.backoff")}>
                        <Select
                            value={retry.backoff}
                            onValueChange={(backoff) =>
                                setRetry({ backoff: backoff as Retry["backoff"] })
                            }
                            options={[
                                { value: "fixed", label: t("flow.backoffFixed") },
                                { value: "double", label: t("flow.backoffDouble") }
                            ]}
                            aria-label={t("flow.backoff")}
                        />
                    </Field>
                </div>
            ) : null}
            {retry ? <p className="text-xs text-muted-foreground">{t("flow.retryHint")}</p> : null}
        </div>
    );
}

/** How the triggers combine: any one starts a run, or all / at least N inside a window. */
export function WhenFields({
    when,
    triggers,
    onChange,
    readOnly
}: {
    when: core.WhenConfig;
    triggers: number;
    onChange: (when: core.WhenConfig) => void;
    readOnly?: boolean;
}) {
    const t = useTranslations("automations");
    if (triggers < 2 && when.kind === "any") return null;
    const minutes = when.kind === "any" ? 5 : Math.max(1, Math.round(when.windowSeconds / 60));
    const windowSeconds = (value: number) => value * 60;
    return (
        <fieldset disabled={readOnly} className="grid gap-2 sm:grid-cols-3">
            <Field label={t("flow.combine")}>
                <Select
                    value={when.kind}
                    onValueChange={(kind) =>
                        onChange(
                            kind === "any"
                                ? { kind: "any" }
                                : kind === "all"
                                  ? { kind: "all", windowSeconds: windowSeconds(minutes) }
                                  : {
                                        kind: "count",
                                        count: 2,
                                        windowSeconds: windowSeconds(minutes)
                                    }
                        )
                    }
                    options={[
                        { value: "any", label: t("flow.combineAny") },
                        { value: "all", label: t("flow.combineAll") },
                        { value: "count", label: t("flow.combineCount") }
                    ]}
                    aria-label={t("flow.combine")}
                />
            </Field>
            {when.kind === "count" ? (
                <NumberInput
                    label={t("flow.combineHowMany")}
                    value={when.count}
                    min={1}
                    max={Math.max(1, Math.min(20, triggers))}
                    onChange={(count) => onChange({ ...when, count })}
                />
            ) : null}
            {when.kind !== "any" ? (
                <NumberInput
                    label={t("flow.windowMinutes")}
                    value={minutes}
                    min={1}
                    max={Math.floor(L.combineWindowSeconds / 60)}
                    onChange={(value) => onChange({ ...when, windowSeconds: windowSeconds(value) })}
                />
            ) : null}
        </fieldset>
    );
}
