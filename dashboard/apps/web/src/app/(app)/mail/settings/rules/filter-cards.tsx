"use client";

/**
 * The cards a filter is edited in: one per node, drawn in the form's column and
 * in the canvas's inspector alike, so both edit with the same fields and the
 * same checks. The frame of each card and every field's complaint line are the
 * shared automation editor's (`@polaris/ui/automation`); what is in them is
 * Mail's.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import * as core from "@polaris/core";
import * as words from "./filter-words";
import * as flow from "@polaris/ui/automation";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import { Plus, X } from "lucide-react";
import { Checkbox, Input, Select, SizeField } from "@polaris/ui";
import { swap, type Path } from "@polaris/ui/automation-graph";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The trigger, which a filter cannot change: a message arriving in the
 *  mailbox whose filters these are. Saving it switched on also applies it to
 *  the mail already there, which the card says, since it is not a choice. */
export function TriggerCard() {
    const t = useTranslations("mailSettings");
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <p className="min-w-0 text-xs text-muted-foreground">{t("rules.trigger.onSave")}</p>
        </div>
    );
}

/** A group of conditions: how they combine, the conditions, and room for more. */
export function GroupCard({
    group,
    path,
    disabled,
    attempted,
    onChange,
    onRemove,
    handle
}: {
    group: core.MailFilterGroup;
    path: Path;
    disabled: boolean;
    attempted: boolean;
    onChange: (group: core.MailFilterGroup) => void;
    onRemove: () => void;
    /** The drag handle, when the group sits in a list of groups. */
    handle?: ReactNode;
}) {
    const t = useTranslations("mailSettings");
    const setItem = (index: number, item: core.MailFilterCondition) =>
        onChange({
            ...group,
            items: group.items.map((entry, at) => (at === index ? item : entry))
        });
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-border p-2">
            <div className="flex min-w-0 items-center gap-2">
                {!disabled && handle}
                {group.items.length > 1 ? (
                    <flow.MatchPicker
                        value={group.match}
                        disabled={disabled}
                        label={t("rules.editor.groupMatch")}
                        allLabel={t("rules.editor.allOf")}
                        anyLabel={t("rules.editor.anyOf")}
                        onChange={(match) => onChange({ ...group, match })}
                    />
                ) : (
                    <span className="text-xs text-muted-foreground">{t("rules.editor.group")}</span>
                )}
                <span className="flex-1" />
                {!disabled && (
                    <button
                        type="button"
                        className="h-7 shrink-0 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={onRemove}
                    >
                        {t("rules.editor.removeGroup")}
                    </button>
                )}
            </div>
            <flow.SortableList
                items={group.items}
                label={t("rules.editor.conditionsList")}
                handleLabel={t("rules.editor.reorder")}
                disabled={disabled}
                onMove={(from, to) =>
                    onChange({ ...group, items: flow.moved(group.items, from, to) })
                }
            >
                {(condition, index, conditionHandle) => (
                    <ConditionCard
                        condition={condition}
                        path={[...path, "items", index]}
                        disabled={disabled}
                        handle={conditionHandle}
                        onChange={(next) => setItem(index, next)}
                        onRemove={() =>
                            onChange({
                                ...group,
                                items: group.items.filter((_, at) => at !== index)
                            })
                        }
                        onUp={
                            index > 0
                                ? () => onChange({ ...group, items: swap(group.items, index, -1) })
                                : undefined
                        }
                        onDown={
                            index < group.items.length - 1
                                ? () => onChange({ ...group, items: swap(group.items, index, 1) })
                                : undefined
                        }
                    />
                )}
            </flow.SortableList>
            {group.items.length === 0 && attempted && (
                <p className="text-xs text-danger">{t("rules.editor.emptyGroup")}</p>
            )}
            {!disabled && group.items.length < core.MAIL_FILTER_LIMITS.conditionsPerGroup && (
                <flow.AddMenu
                    label={t("rules.editor.addToGroup")}
                    options={words.CONDITION_KINDS.map((kind) => ({
                        value: kind,
                        label: words.conditionKindText(kind, t)
                    }))}
                    onPick={(kind) =>
                        onChange({
                            ...group,
                            items: [
                                ...group.items,
                                words.blankCondition(kind as core.MailRuleField)
                            ]
                        })
                    }
                />
            )}
        </div>
    );
}

/** One condition: what it looks at, how it compares, and what with. */
export function ConditionCard({
    condition,
    path,
    disabled,
    onChange,
    onRemove,
    onUp,
    onDown,
    handle
}: {
    condition: core.MailFilterCondition;
    path: Path;
    disabled: boolean;
    onChange: (condition: core.MailFilterCondition) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
    /** The drag handle, when the condition sits in its group's list. */
    handle?: ReactNode;
}) {
    const t = useTranslations("mailSettings");
    const operators = core.mailOperatorsFor(condition.kind);
    const shape = condition.operator === "similar" ? core.mailSubjectShape(condition.value) : "";
    // More values ("this or that") and capitals, for the comparisons over text.
    const text = core.mailTakesValues(condition.operator, condition.kind);
    const more = condition.alternatives ?? [];
    const negative = condition.operator === "not-contains" || condition.operator === "is-not";
    const setMore = (next: readonly string[]) =>
        onChange({ ...condition, alternatives: next.length > 0 ? [...next] : undefined });
    /** A field changed under a condition keeps what it can of the rest: the
     *  comparison if the new field has it, the value if it still means one. */
    const changeKind = (kind: core.MailRuleField) => {
        const blank = words.blankCondition(kind);
        const keep = core.mailOperatorsFor(kind).includes(condition.operator);
        const sameSort =
            kind !== "size" &&
            kind !== "attachment" &&
            condition.kind !== "size" &&
            condition.kind !== "attachment";
        onChange({
            ...blank,
            id: condition.id,
            operator: keep ? condition.operator : blank.operator,
            value: sameSort ? condition.value : blank.value
        });
    };
    return (
        <flow.NodeCard
            handle={handle}
            kind={
                <flow.KindPicker
                    value={condition.kind}
                    kinds={words.CONDITION_KINDS}
                    label={t("rules.fieldLabel")}
                    text={(kind) => words.conditionKindText(kind, t)}
                    disabled={disabled}
                    onChange={changeKind}
                />
            }
            disabled={disabled}
            onRemove={onRemove}
            onUp={onUp}
            onDown={onDown}
            removeLabel={t("rules.removeCondition")}
            upLabel={t("rules.editor.up")}
            downLabel={t("rules.editor.down")}
        >
            {condition.kind === "header" && (
                <flow.Field
                    label={t("rules.editor.headerName")}
                    path={[...path, "header"]}
                    required
                >
                    {(id, invalid) => (
                        <Input
                            id={id}
                            value={condition.header ?? ""}
                            disabled={disabled}
                            maxLength={76}
                            placeholder={t("rules.editor.headerPlaceholder")}
                            aria-invalid={invalid || undefined}
                            onChange={(event) =>
                                onChange({ ...condition, header: event.target.value })
                            }
                        />
                    )}
                </flow.Field>
            )}
            {condition.kind === "attachment" ? (
                <flow.Field label={t("rules.editor.attachments")} path={[...path, "value"]}>
                    {(id) => (
                        <Select
                            id={id}
                            value={condition.value === "no" ? "no" : "yes"}
                            disabled={disabled}
                            options={[
                                { value: "yes", label: t("rules.editor.hasAttachments") },
                                { value: "no", label: t("rules.editor.noAttachments") }
                            ]}
                            onValueChange={(value) =>
                                onChange({ ...condition, operator: "is", value })
                            }
                        />
                    )}
                </flow.Field>
            ) : (
                <>
                    <flow.Field label={t("rules.operatorLabel")} path={[...path, "operator"]}>
                        {(id) => (
                            <Select
                                id={id}
                                value={condition.operator}
                                disabled={disabled}
                                options={operators.map((operator) => ({
                                    value: operator,
                                    label: words.operatorText(operator, t)
                                }))}
                                onValueChange={(operator) => {
                                    const next = operator as core.MailRuleOperator;
                                    onChange({
                                        ...condition,
                                        operator: next,
                                        caseSensitive: core.mailTellsCapitals(next, condition.kind)
                                            ? condition.caseSensitive
                                            : undefined
                                    });
                                }}
                            />
                        )}
                    </flow.Field>
                    {condition.kind === "size" ? (
                        <flow.Field
                            label={t("rules.editor.size")}
                            path={[...path, "value"]}
                            required
                        >
                            {() => (
                                <SizeField
                                    value={Number(condition.value) || 0}
                                    stored="B"
                                    min={0}
                                    disabled={disabled}
                                    aria-label={t("rules.editor.size")}
                                    onChange={(bytes) =>
                                        onChange({ ...condition, value: String(bytes) })
                                    }
                                />
                            )}
                        </flow.Field>
                    ) : (
                        <flow.Field
                            label={t("rules.valueLabel")}
                            path={[...path, "value"]}
                            required
                        >
                            {(id, invalid) => (
                                <Input
                                    id={id}
                                    value={condition.value}
                                    disabled={disabled}
                                    maxLength={core.MAIL_FILTER_LIMITS.value}
                                    placeholder={
                                        condition.operator === "similar"
                                            ? t("rules.similarPlaceholder")
                                            : condition.operator === "matches"
                                              ? t("rules.editor.patternPlaceholder")
                                              : undefined
                                    }
                                    aria-invalid={invalid || undefined}
                                    onChange={(event) =>
                                        onChange({ ...condition, value: event.target.value })
                                    }
                                />
                            )}
                        </flow.Field>
                    )}
                    {text && more.length > 0 ? (
                        <flow.Field
                            label={negative ? t("rules.editor.norAny") : t("rules.editor.orAny")}
                            path={[...path, "alternatives"]}
                        >
                            {() => (
                                <div className="flex min-w-0 flex-col gap-2">
                                    {more.map((value, at) => (
                                        <div key={at} className="flex min-w-0 items-center gap-2">
                                            <span className="w-6 shrink-0 text-xs text-muted-foreground">
                                                {negative ? t("rules.editor.nor") : t("rules.editor.or")}
                                            </span>
                                            <Input
                                                value={value}
                                                disabled={disabled}
                                                maxLength={core.MAIL_FILTER_LIMITS.value}
                                                aria-label={t("rules.editor.valueNumber", {
                                                    number: at + 2
                                                })}
                                                className="min-w-0 flex-1"
                                                onChange={(event) =>
                                                    setMore(
                                                        more.map((entry, index) =>
                                                            index === at ? event.target.value : entry
                                                        )
                                                    )
                                                }
                                            />
                                            {!disabled && (
                                                <button
                                                    type="button"
                                                    aria-label={t("rules.editor.removeValue", {
                                                        number: at + 2
                                                    })}
                                                    title={t("rules.editor.removeValue", {
                                                        number: at + 2
                                                    })}
                                                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                                    onClick={() =>
                                                        setMore(more.filter((_, index) => index !== at))
                                                    }
                                                >
                                                    <X className="size-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </flow.Field>
                    ) : null}
                    {text && !disabled ? (
                        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 sm:col-span-2">
                            {more.length < core.MAIL_FILTER_LIMITS.alternatives ? (
                                <button
                                    type="button"
                                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                                    onClick={() => setMore([...more, ""])}
                                >
                                    <Plus className="size-3.5" />
                                    {negative ? t("rules.editor.addNor") : t("rules.editor.addOr")}
                                </button>
                            ) : null}
                            {core.mailTellsCapitals(condition.operator, condition.kind) ? (
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Checkbox
                                        checked={condition.caseSensitive === true}
                                        onChange={(event) =>
                                            onChange({
                                                ...condition,
                                                caseSensitive: event.target.checked || undefined
                                            })
                                        }
                                    />
                                    {t("rules.editor.caseSensitive")}
                                </label>
                            ) : null}
                        </div>
                    ) : null}
                </>
            )}
            {/* What "similar" and a pattern will actually do, so the condition
                can be judged before it is saved. */}
            {condition.operator === "similar" && condition.value.trim() ? (
                <p className="min-w-0 break-words text-[0.6875rem] text-foreground-subtle [overflow-wrap:anywhere] sm:col-span-2">
                    {shape ? t("rules.similarShape", { shape }) : t("rules.similarNothing")}
                </p>
            ) : condition.operator === "matches" ? (
                <p className="text-[0.6875rem] text-foreground-subtle sm:col-span-2">
                    {t("rules.editor.patternHint", { count: core.MAIL_FILTER_LIMITS.patternText })}
                </p>
            ) : null}
        </flow.NodeCard>
    );
}

/** One step: what it does, and the folder, label or address it does it with. */
export function StepCard({
    step,
    number,
    path,
    folders,
    labels,
    forwardTargets,
    disabled,
    onChange,
    onRemove,
    onUp,
    onDown,
    handle
}: {
    step: core.MailFilterStep;
    number: number;
    path: Path;
    folders: readonly MailFolderView[];
    labels: readonly MailLabelView[];
    forwardTargets: readonly string[];
    disabled: boolean;
    onChange: (step: core.MailFilterStep) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
    /** The drag handle, when the step sits in the list of steps. */
    handle?: ReactNode;
}) {
    const t = useTranslations("mailSettings");
    return (
        <flow.NodeCard
            handle={handle}
            number={number}
            kind={
                <flow.KindPicker
                    value={step.kind}
                    kinds={words.STEP_KINDS}
                    label={t("rules.actionLabel")}
                    text={(kind) => words.stepKindText(kind, t)}
                    disabled={disabled}
                    onChange={(kind) => onChange({ ...words.blankStep(kind), id: step.id })}
                />
            }
            disabled={disabled}
            onRemove={onRemove}
            onUp={onUp}
            onDown={onDown}
            removeLabel={t("rules.editor.removeStep")}
            upLabel={t("rules.editor.up")}
            downLabel={t("rules.editor.down")}
        >
            {step.kind === "move" && (
                <flow.Field label={t("rules.folderLabel")} path={[...path, "folder"]} required>
                    {(id) =>
                        folders.length === 0 ? (
                            <p id={id} className="text-xs text-muted-foreground">
                                {t("rules.editor.noFolders")}
                            </p>
                        ) : (
                            <Select
                                id={id}
                                value={step.folder}
                                disabled={disabled}
                                placeholder={t("rules.editor.chooseFolder")}
                                options={folders.map((folder) => ({
                                    value: folder.id,
                                    label: `${" ".repeat(folder.depth * 2)}${folder.name}`
                                }))}
                                onValueChange={(folder) => onChange({ ...step, folder })}
                            />
                        )
                    }
                </flow.Field>
            )}
            {step.kind === "label" && (
                <flow.Field label={t("rules.labelLabel")} path={[...path, "label"]} required>
                    {(id) =>
                        labels.length === 0 ? (
                            <p id={id} className="text-xs text-muted-foreground">
                                {t("rules.editor.noLabels")}
                            </p>
                        ) : (
                            <Select
                                id={id}
                                value={step.label}
                                disabled={disabled}
                                placeholder={t("rules.editor.chooseLabel")}
                                options={labels.map((label) => ({
                                    value: label.id,
                                    label: label.name
                                }))}
                                onValueChange={(label) => onChange({ ...step, label })}
                            />
                        )
                    }
                </flow.Field>
            )}
            {step.kind === "forward" && (
                <flow.Field label={t("rules.forwardLabel")} path={[...path, "to"]} required>
                    {(id) => (
                        <div className="flex min-w-0 flex-col gap-1">
                            {forwardTargets.length > 0 || step.to ? (
                                <Select
                                    id={id}
                                    value={step.to}
                                    disabled={disabled}
                                    placeholder={t("rules.editor.chooseAddress")}
                                    options={[
                                        ...forwardTargets.map((address) => ({
                                            value: address,
                                            label: address
                                        })),
                                        // An address saved before forwards had to be verified
                                        // stays named, so the reader sees what to replace.
                                        ...(step.to && !forwardTargets.includes(step.to)
                                            ? [{ value: step.to, label: step.to }]
                                            : [])
                                    ]}
                                    onValueChange={(to) => onChange({ ...step, to })}
                                />
                            ) : (
                                <p id={id} className="text-xs text-muted-foreground">
                                    {t("rules.editor.noVerified")}
                                </p>
                            )}
                            <Link
                                href="/account/details"
                                className="self-start text-[0.6875rem] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                            >
                                {t("rules.editor.verifyAddress")}
                            </Link>
                        </div>
                    )}
                </flow.Field>
            )}
            {step.kind === "forward" && (
                <p className="text-[0.6875rem] text-foreground-subtle sm:col-span-2">
                    {t("rules.forwardHint")}
                </p>
            )}
            {step.kind === "stop" && (
                <p className="text-[0.6875rem] text-foreground-subtle sm:col-span-2">
                    {t("rules.editor.stopHint")}
                </p>
            )}
        </flow.NodeCard>
    );
}
