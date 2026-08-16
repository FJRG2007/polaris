"use client";

/**
 * Rendering and editing one custom-field value.
 *
 * Every value is stored as a string, so this module is the only place that knows
 * how each type reads and writes one. Keeping that in a single switch means a
 * new field type is one case here and one entry in the schema, rather than a
 * change in the table, the card, the panel and the filter bar.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Avatar, StatusDot } from "./pickers";
import type { PersonRef } from "@/lib/tasks/facts";
import { Input, Select, Textarea } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import type { CustomFieldView } from "@/lib/tasks/space-service";

/** A stored value as it reads in a cell or on a card. */
export function CustomFieldValue({
    field,
    value,
    people
}: {
    field: CustomFieldView;
    value: string;
    people: readonly PersonRef[];
}) {
    const format = useDisplayFormat();
    if (!value) return <span className="text-muted-foreground">-</span>;

    switch (field.type) {
        case "checkbox":
            return <span>{value === "true" ? "Yes" : "No"}</span>;
        case "date":
            return <span>{format.date(value)}</span>;
        case "money":
            return <span>{format.currency(Number(value))}</span>;
        case "percent":
        case "progress":
            return <span>{Number(value)}%</span>;
        case "rating":
            return (
                <span aria-label={`${value} out of ${field.config.max ?? 5}`}>
                    {"*".repeat(Number(value) || 0)}
                </span>
            );
        case "url":
            return (
                <a
                    href={value}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate text-primary hover:underline"
                >
                    {value.replace(/^https?:\/\//, "")}
                </a>
            );
        case "email":
            return (
                <a href={`mailto:${value}`} className="truncate text-primary hover:underline">
                    {value}
                </a>
            );
        case "phone":
            return (
                <a href={`tel:${value}`} className="truncate text-primary hover:underline">
                    {value}
                </a>
            );
        case "people": {
            const chosen = people.filter((person) => value.split(",").includes(person.id));
            return (
                <span className="flex items-center gap-1">
                    {chosen.map((person) => (
                        <Avatar key={person.id} person={person} size={20} />
                    ))}
                </span>
            );
        }
        case "dropdown":
        case "labels": {
            const chosen = (field.config.options ?? []).filter((option) =>
                value.split(",").includes(option.id)
            );
            if (chosen.length === 0) return <span className="text-muted-foreground">-</span>;
            return (
                <span className="flex flex-wrap items-center gap-1">
                    {chosen.map((option) => (
                        <span
                            key={option.id}
                            className="inline-flex items-center gap-1 text-xs"
                            style={{ color: option.color }}
                        >
                            <StatusDot color={option.color} />
                            {option.label}
                        </span>
                    ))}
                </span>
            );
        }
        default:
            return <span className="truncate">{value}</span>;
    }
}

/** The control that writes one. Reports on blur (or on change for the controls
 *  where a blur never comes), so a keystroke is not a round trip. */
export function CustomFieldEditor({
    field,
    value,
    people,
    disabled,
    onEdit,
    onChange
}: {
    field: CustomFieldView;
    value: string;
    people: readonly PersonRef[];
    disabled?: boolean;
    /** Told on every keystroke of the controls somebody types into, so what was
     *  typed is not waiting on the blur to exist anywhere but the screen. */
    onEdit?: (value: string) => void;
    onChange: (value: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    const commit = (next: string) => {
        setDraft(next);
        if (next !== value) onChange(next);
    };

    const options = field.config.options ?? [];
    const multiple = field.type === "labels" || (field.type === "people" && field.config.multiple);
    const selected = value ? value.split(",") : [];

    switch (field.type) {
        case "checkbox":
            return (
                <input
                    type="checkbox"
                    checked={value === "true"}
                    disabled={disabled}
                    aria-label={field.name}
                    onChange={(event) => commit(event.target.checked ? "true" : "false")}
                />
            );
        case "longText":
            return (
                <Textarea
                    defaultValue={value}
                    rows={3}
                    disabled={disabled}
                    aria-label={field.name}
                    onChange={(event) => onEdit?.(event.target.value)}
                    onBlur={(event) => commit(event.target.value)}
                    className="w-full resize-y rounded-md border border-border bg-field px-2 py-1 text-xs hover:border-border-strong focus:border-border-strong"
                />
            );
        case "date":
            return (
                <input
                    type={field.config.includeTime ? "datetime-local" : "date"}
                    defaultValue={value ? value.slice(0, field.config.includeTime ? 16 : 10) : ""}
                    disabled={disabled}
                    aria-label={field.name}
                    onChange={(event) => commit(event.target.value)}
                    className="rounded-md border border-border bg-field px-2 py-1 text-xs hover:border-border-strong focus:border-border-strong"
                />
            );
        case "number":
        case "money":
        case "percent":
        case "progress":
        case "rating":
            return (
                <Input
                    type="number"
                    defaultValue={value}
                    disabled={disabled}
                    aria-label={field.name}
                    min={field.config.min ?? (field.type === "rating" ? 0 : undefined)}
                    max={
                        field.config.max ??
                        (field.type === "rating" ? 5 : field.type === "percent" ? 100 : undefined)
                    }
                    onChange={(event) => onEdit?.(event.target.value.trim())}
                    onBlur={(event) => commit(event.target.value.trim())}
                    className="h-8 w-24 text-xs"
                />
            );
        case "dropdown":
            return (
                <Select
                    value={value}
                    disabled={disabled}
                    aria-label={field.name}
                    placeholder="Not set"
                    onValueChange={commit}
                    options={[
                        { value: "", label: "Not set" },
                        ...options.map((option) => ({ value: option.id, label: option.label }))
                    ]}
                    className="h-8 text-xs"
                />
            );
        case "labels":
        case "people": {
            const entries: { id: string; label: string; person?: PersonRef }[] =
                field.type === "people"
                    ? people.map((person) => ({ id: person.id, label: person.name, person }))
                    : options.map((option) => ({ id: option.id, label: option.label }));
            return (
                <div className="flex flex-wrap gap-1">
                    {entries.map((entry) => {
                        const on = selected.includes(entry.id);
                        return (
                            <button
                                key={entry.id}
                                type="button"
                                disabled={disabled}
                                aria-pressed={on}
                                onClick={() => {
                                    const next = on
                                        ? selected.filter((id) => id !== entry.id)
                                        : multiple
                                          ? [...selected, entry.id]
                                          : [entry.id];
                                    commit(next.join(","));
                                }}
                                className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                                    on
                                        ? "border-primary bg-primary/10 text-primary"
                                        : "border-border text-muted-foreground hover:bg-muted"
                                }`}
                            >
                                <span className="inline-flex items-center gap-1">
                                    {entry.person && <Avatar person={entry.person} size={16} />}
                                    {entry.label}
                                </span>
                            </button>
                        );
                    })}
                </div>
            );
        }
        default:
            return (
                <Input
                    type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
                    defaultValue={draft}
                    disabled={disabled}
                    aria-label={field.name}
                    onChange={(event) => onEdit?.(event.target.value.trim())}
                    onBlur={(event) => commit(event.target.value.trim())}
                    className="h-8 text-xs"
                />
            );
    }
}

/** The label a column header shows for a field type, for the settings screen. */
export function customFieldTypeLabel(type: core.CustomFieldType): string {
    return core.CUSTOM_FIELD_LABELS[type];
}
