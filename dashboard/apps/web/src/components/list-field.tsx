"use client";

/**
 * A list of short values edited one at a time: each one a chip with its own
 * remove button, and a field that adds what is typed on Enter or a comma.
 *
 * For lists people add to and prune (labels, branches, logins, words) - a
 * textarea of one per line hides which entries exist and lets a stray space
 * become a value nobody can see.
 */

import { X } from "lucide-react";
import { useId, useState } from "react";
import { Button, Input, cn } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export interface ListFieldProps {
    value: readonly string[];
    onChange: (next: string[]) => void;
    placeholder?: string;
    /** The most entries the list takes. */
    max?: number;
    /** The longest one entry may be. */
    maxLength?: number;
    /** Entries that differ only in case are the same entry. */
    caseInsensitive?: boolean;
    disabled?: boolean;
    /** Names the field for assistive tech when no visible label points at it. */
    "aria-label"?: string;
    id?: string;
    className?: string;
}

export function ListField({
    value,
    onChange,
    placeholder,
    max = 50,
    maxLength = 100,
    caseInsensitive = false,
    disabled,
    "aria-label": ariaLabel,
    id,
    className
}: ListFieldProps) {
    const t = useTranslations("components");
    const [draft, setDraft] = useState("");
    const fallbackId = useId();
    const inputId = id ?? fallbackId;
    const key = (entry: string) => (caseInsensitive ? entry.toLowerCase() : entry);
    const full = value.length >= max;

    /** Add whatever was typed, split on commas, skipping blanks and repeats. */
    const commit = (text: string) => {
        const seen = new Set(value.map(key));
        const added: string[] = [];
        for (const part of text.split(",")) {
            const entry = part.trim().slice(0, maxLength);
            if (!entry || seen.has(key(entry))) continue;
            if (value.length + added.length >= max) break;
            seen.add(key(entry));
            added.push(entry);
        }
        setDraft("");
        if (added.length > 0) onChange([...value, ...added]);
    };

    const remove = (index: number) => onChange(value.filter((_, at) => at !== index));

    return (
        <div className={cn("flex min-w-0 flex-col gap-2", className)}>
            {value.length > 0 ? (
                <ul className="flex min-w-0 flex-wrap gap-1.5">
                    {value.map((entry, index) => (
                        <li
                            key={`${entry}-${index}`}
                            className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pl-2 pr-0.5 text-xs"
                        >
                            <span className="min-w-0 truncate" title={entry}>
                                {entry}
                            </span>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-5 shrink-0"
                                disabled={disabled}
                                aria-label={t("listField.remove", { value: entry })}
                                onClick={() => remove(index)}
                            >
                                <X className="size-3 shrink-0" aria-hidden />
                            </Button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <Input
                id={inputId}
                value={draft}
                aria-label={ariaLabel}
                placeholder={full ? t("listField.full", { max }) : placeholder}
                disabled={disabled || full}
                maxLength={maxLength * 4}
                onChange={(event) => {
                    const next = event.target.value;
                    if (next.includes(",")) commit(next);
                    else setDraft(next);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commit(draft);
                    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
                        remove(value.length - 1);
                    }
                }}
                onBlur={() => commit(draft)}
            />
        </div>
    );
}
