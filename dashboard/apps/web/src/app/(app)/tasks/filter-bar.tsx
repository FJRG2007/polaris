"use client";

/**
 * Building a filter, one readable condition at a time.
 *
 * Each row is a sentence: field, operator, value. The operators offered depend
 * on the field, so a date never gets "contains" and a person never gets "is
 * before" - an editor that lets you build a condition which can never be true is
 * an editor that wastes your afternoon.
 *
 * The result is the same TaskFilter the server stores on a view and the
 * automation engine matches rules with, so what you see here is exactly what a
 * rule will do.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Filter, Plus, X } from "lucide-react";
import { Button, Select, cn } from "@polaris/ui";
import type { PersonRef } from "@/lib/tasks/facts";
import { PersonName } from "@/components/person-name";
import { Avatar, preloadAvatars } from "@/components/avatar";
import { optionLabel } from "./option-label";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CustomFieldView, StatusView, TagView } from "@/lib/tasks/space-service";

/** Which operators make sense for a field. */
function operatorsFor(field: core.TaskFilterField): core.TaskFilterOperator[] {
    switch (field) {
        case "dueDate":
        case "startDate":
        case "createdAt":
            return ["is", "before", "after", "between", "isSet", "isNotSet"];
        case "name":
            return ["contains", "notContains"];
        case "points":
        case "timeEstimate":
            return ["is", "gt", "lt", "between", "isSet", "isNotSet"];
        case "archived":
        case "blocked":
            return ["is"];
        case "customField":
            return ["is", "isNot", "contains", "isSet", "isNotSet"];
        default:
            return ["anyOf", "noneOf", "is", "isNot", "isSet", "isNotSet"];
    }
}

/** The values a field can be compared against, when they come from a list. */
function choicesFor(
    t: NamespaceTranslator<"tasks">,
    condition: core.TaskFilterCondition,
    context: {
        statuses: readonly StatusView[];
        tags: readonly TagView[];
        people: readonly PersonRef[];
        fields: readonly CustomFieldView[];
        lists: readonly { id: string; name: string }[];
    }
): { value: string; label: string; person?: PersonRef }[] | null {
    switch (condition.field) {
        case "status":
            return context.statuses.map((status) => ({ value: status.id, label: status.name }));
        case "statusType":
            return core.TASK_STATUS_TYPES.map((type) => ({
                value: type,
                label: optionLabel(t, "statusType", type)
            }));
        case "priority":
            return core.TASK_PRIORITIES.map((priority) => ({
                value: priority,
                label: optionLabel(t, "priority", priority)
            }));
        case "tag":
            return context.tags.map((tag) => ({ value: tag.id, label: tag.name }));
        case "assignee":
        case "watcher":
        case "createdBy":
            // Carried whole, so the chip can draw the face beside the name the
            // way every other people picker does.
            return context.people.map((person) => ({ value: person.id, label: person.name, person }));
        case "list":
            return context.lists.map((list) => ({ value: list.id, label: list.name }));
        case "archived":
        case "blocked":
            return [
                { value: "true", label: t("fields.yes") },
                { value: "false", label: t("fields.no") }
            ];
        case "dueDate":
        case "startDate":
        case "createdAt":
            return core.RELATIVE_DATES.map((token) => ({
                value: token,
                label: optionLabel(t, "relativeDate", token)
            }));
        case "customField": {
            const field = context.fields.find((entry) => entry.id === condition.fieldId);
            return field?.config.options?.map((option) => ({ value: option.id, label: option.label })) ?? null;
        }
        default:
            return null;
    }
}

export function FilterBar({
    filter,
    onChange,
    context,
    className
}: {
    filter: core.TaskFilter;
    onChange: (filter: core.TaskFilter) => void;
    context: {
        statuses: readonly StatusView[];
        tags: readonly TagView[];
        people: readonly PersonRef[];
        fields: readonly CustomFieldView[];
        lists: readonly { id: string; name: string }[];
    };
    className?: string;
}) {
    const t = useTranslations("tasksViews");
    const tt = useTranslations("tasks");
    const [open, setOpen] = useState(false);
    const count = filter.conditions.length;

    const update = (index: number, next: Partial<core.TaskFilterCondition>) => {
        onChange({
            ...filter,
            conditions: filter.conditions.map((condition, position) =>
                position === index ? { ...condition, ...next } : condition
            )
        });
    };

    return (
        <div className={cn("flex flex-col gap-2", className)}>
            <button
                type="button"
                onClick={() => {
                    // The faces a person condition offers, fetched as the panel
                    // opens rather than as the chips draw.
                    if (!open) preloadAvatars(context.people);
                    setOpen(!open);
                }}
                className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted",
                    count > 0 && "border-primary/50 text-primary"
                )}
            >
                <Filter className="size-3.5" />
                {count === 0 ? t("filter.button") : t("filter.count", { count })}
            </button>

            {open && (
                <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{t("filter.showMatching")}</span>
                        <Select
                            value={filter.match}
                            onValueChange={(match) => onChange({ ...filter, match: match as "all" | "any" })}
                            options={[
                                { value: "all", label: t("filter.all") },
                                { value: "any", label: t("filter.any") }
                            ]}
                            aria-label={t("filter.matchLabel")}
                            className="h-7 w-24 text-xs"
                        />
                        <span>{t("filter.ofThese")}</span>
                    </div>

                    {filter.conditions.map((condition, index) => {
                        const choices = choicesFor(tt, condition, context);
                        const operators = operatorsFor(condition.field);
                        const valueless = condition.operator === "isSet" || condition.operator === "isNotSet";

                        return (
                            <div key={`${condition.field}-${index}`} className="flex flex-wrap items-center gap-2">
                                <Select
                                    value={condition.field}
                                    onValueChange={(field) =>
                                        update(index, {
                                            field: field as core.TaskFilterField,
                                            operator: operatorsFor(field as core.TaskFilterField)[0],
                                            values: []
                                        })
                                    }
                                    options={core.TASK_FILTER_FIELDS.map((field) => ({
                                        value: field,
                                        label: optionLabel(tt, "filter", field)
                                    }))}
                                    aria-label={t("filter.field")}
                                    className="h-7 w-36 text-xs"
                                />

                                {condition.field === "customField" && (
                                    <Select
                                        value={condition.fieldId ?? ""}
                                        onValueChange={(fieldId) => update(index, { fieldId, values: [] })}
                                        options={context.fields.map((field) => ({
                                            value: field.id,
                                            label: field.name
                                        }))}
                                        placeholder={t("filter.pickField")}
                                        aria-label={t("filter.customField")}
                                        className="h-7 w-36 text-xs"
                                    />
                                )}

                                <Select
                                    value={condition.operator}
                                    onValueChange={(operator) =>
                                        update(index, { operator: operator as core.TaskFilterOperator })
                                    }
                                    options={operators.map((operator) => ({
                                        value: operator,
                                        label: optionLabel(tt, "filterOperator", operator)
                                    }))}
                                    aria-label={t("filter.operator")}
                                    className="h-7 w-36 text-xs"
                                />

                                {!valueless &&
                                    (choices ? (
                                        <div className="flex flex-wrap gap-1">
                                            {choices.map((choice) => {
                                                const on = condition.values.includes(choice.value);
                                                const single =
                                                    condition.operator === "is" || condition.operator === "isNot";
                                                return (
                                                    <button
                                                        key={choice.value}
                                                        type="button"
                                                        aria-pressed={on}
                                                        onClick={() =>
                                                            update(index, {
                                                                values: on
                                                                    ? condition.values.filter(
                                                                          (value) => value !== choice.value
                                                                      )
                                                                    : single
                                                                      ? [choice.value]
                                                                      : [...condition.values, choice.value]
                                                            })
                                                        }
                                                        className={cn(
                                                            "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[0.6875rem] transition-colors",
                                                            on
                                                                ? "border-primary bg-primary/10 text-primary"
                                                                : "border-border text-muted-foreground hover:bg-muted"
                                                        )}
                                                    >
                                                        {choice.person && <Avatar person={choice.person} size={16} />}
                                                        {/* Only the choices that
                                                            are people carry one:
                                                            a status or a tag has
                                                            no name of its own to
                                                            paint. */}
                                                        {choice.person ? (
                                                            <PersonName
                                                                id={choice.person.id}
                                                                name={choice.label}
                                                            />
                                                        ) : (
                                                            choice.label
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <input
                                            value={condition.values[0] ?? ""}
                                            onChange={(event) => update(index, { values: [event.target.value] })}
                                            placeholder={t("filter.value")}
                                            aria-label={t("filter.value")}
                                            className="h-7 w-40 rounded-md border border-border bg-field px-2 text-xs hover:border-border-strong focus:border-border-strong"
                                        />
                                    ))}

                                <button
                                    type="button"
                                    aria-label={t("filter.removeThis")}
                                    title={t("filter.remove")}
                                    onClick={() =>
                                        onChange({
                                            ...filter,
                                            conditions: filter.conditions.filter((_, position) => position !== index)
                                        })
                                    }
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                >
                                    <X className="size-3.5" />
                                </button>
                            </div>
                        );
                    })}

                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                                onChange({
                                    ...filter,
                                    conditions: [
                                        ...filter.conditions,
                                        { field: "status", operator: "anyOf", values: [] }
                                    ]
                                })
                            }
                        >
                            <Plus className="size-3.5" /> {t("filter.condition")}
                        </Button>
                        {count > 0 && (
                            <Button size="sm" variant="ghost" onClick={() => onChange(core.EMPTY_FILTER)}>
                                {t("filter.clearAll")}
                            </Button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
