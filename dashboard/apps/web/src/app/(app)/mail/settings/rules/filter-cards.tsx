"use client";

/**
 * The cards a filter is edited in: one per node, drawn in the form's column and
 * in the canvas's inspector alike, so both edit with the same fields and the
 * same checks. The frame of each card and every field's complaint line are the
 * shared automation editor's (`@polaris/ui/automation`); what is in them is
 * Mail's.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import * as words from "./filter-words";
import * as flow from "@polaris/ui/automation";
import type { MailLabelView } from "@/lib/mailbox/labels";
import type { MailFolderView } from "@/lib/mailbox/views";
import { Input, Select, SizeField, Switch } from "@polaris/ui";
import { swap, type Path } from "@polaris/ui/automation-graph";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** The trigger, which a filter cannot change: a message arriving in this
 *  mailbox, and whether the mail already there gets the same treatment once. */
export function TriggerCard({
    address,
    applyToExisting,
    disabled,
    onApplyToExisting
}: {
    address: string;
    applyToExisting: boolean;
    disabled: boolean;
    onApplyToExisting: (value: boolean) => void;
}) {
    const t = useTranslations("mailSettings");
    return (
        <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <p className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
                {t("rules.trigger.in", { address })}
            </p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                    checked={applyToExisting}
                    disabled={disabled}
                    onChange={onApplyToExisting}
                    aria-label={t("rules.existingLabel")}
                />
                <span className="min-w-0">{t("rules.existing")}</span>
            </label>
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
    onRemove
}: {
    group: core.MailFilterGroup;
    path: Path;
    disabled: boolean;
    attempted: boolean;
    onChange: (group: core.MailFilterGroup) => void;
    onRemove: () => void;
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
            {group.items.map((condition, index) => (
                <ConditionCard
                    key={condition.id}
                    condition={condition}
                    path={[...path, "items", index]}
                    disabled={disabled}
                    onChange={(next) => setItem(index, next)}
                    onRemove={() =>
                        onChange({ ...group, items: group.items.filter((_, at) => at !== index) })
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
            ))}
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
    onDown
}: {
    condition: core.MailFilterCondition;
    path: Path;
    disabled: boolean;
    onChange: (condition: core.MailFilterCondition) => void;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
}) {
    const t = useTranslations("mailSettings");
    const operators = core.mailOperatorsFor(condition.kind);
    const shape = condition.operator === "similar" ? core.mailSubjectShape(condition.value) : "";
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
                                onValueChange={(operator) =>
                                    onChange({
                                        ...condition,
                                        operator: operator as core.MailRuleOperator
                                    })
                                }
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
    onDown
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
}) {
    const t = useTranslations("mailSettings");
    return (
        <flow.NodeCard
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
