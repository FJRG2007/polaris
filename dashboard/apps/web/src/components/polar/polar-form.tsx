"use client";

/**
 * A form Polar drew in its answer (`lib/polar/forms.ts`), rendered from the
 * closed field set only. Each field is checked as it changes against the same
 * schema the server applies; Send goes out as the person's next message. Once
 * answered, the form shows what was sent and takes no more input.
 */

import { useMemo, useState } from "react";
import { Button, cn, Input, Textarea } from "@polaris/ui";
import { Check, ClipboardList, Star } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    checkFormValues,
    FORM_TEXT_MAX,
    FORM_TEXTAREA_MAX,
    formOf,
    ratingMax,
    type FormField,
    type FormValue,
    type FormValues
} from "@/lib/polar/forms";

export function PolarFormView({
    input,
    sent,
    disabled,
    onSubmit
}: {
    input: unknown;
    /** The values it was answered with, or null while it is open. */
    sent: FormValues | null;
    disabled: boolean;
    onSubmit: (values: FormValues) => void;
}) {
    const t = useTranslations("polar");
    const form = useMemo(() => formOf(input), [input]);
    const [values, setValues] = useState<Record<string, FormValue | undefined>>({});
    const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
    if (!form) return null;
    const shown: Record<string, FormValue | undefined> = sent ?? values;
    const checked = checkFormValues(form, shown);
    const bad = new Set(checked.ok ? [] : checked.fields);
    const locked = sent !== null || disabled;
    const set = (id: string, value: FormValue | undefined) => {
        setValues((all) => ({ ...all, [id]: value }));
        setTouched((all) => new Set(all).add(id));
    };
    const submit = () => {
        if (locked) return;
        if (!checked.ok) return setTouched(new Set(form.fields.map((field) => field.id)));
        onSubmit(checked.values);
    };
    return (
        <form
            aria-label={form.title || t("form.title")}
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-3"
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                    <ClipboardList className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 truncate">{form.title || t("form.title")}</span>
                </div>
                {form.description ? (
                    <p className="break-words text-sm text-muted-foreground">{form.description}</p>
                ) : null}
            </div>
            {form.fields.map((field) => {
                const id = `polar-form-${field.id}`;
                const invalid = bad.has(field.id) && touched.has(field.id) && !sent;
                const empty = shown[field.id] === undefined || shown[field.id] === "";
                return (
                    <div key={field.id} className="flex min-w-0 flex-col gap-1">
                        <label htmlFor={id} id={`${id}-label`} className="break-words text-sm font-medium">
                            {field.label}
                            {field.required ? (
                                <span className="text-destructive" aria-label={t("form.required")}>
                                    {" *"}
                                </span>
                            ) : null}
                        </label>
                        <FieldInput
                            field={field}
                            id={id}
                            value={shown[field.id]}
                            locked={locked}
                            invalid={invalid}
                            onChange={(value) => set(field.id, value)}
                        />
                        {field.hint ? <p className="break-words text-xs text-muted-foreground">{field.hint}</p> : null}
                        {invalid ? (
                            <p className="text-xs text-destructive">
                                {empty && field.required ? t("form.required") : t("form.invalid")}
                            </p>
                        ) : null}
                    </div>
                );
            })}
            <div className="flex min-w-0 items-center gap-2">
                {sent ? (
                    <span className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Check className="size-4 shrink-0" aria-hidden />
                        {t("form.sent")}
                    </span>
                ) : (
                    <Button type="submit" size="sm" disabled={disabled} aria-disabled={!checked.ok}>
                        {form.submitLabel || t("form.submit")}
                    </Button>
                )}
            </div>
        </form>
    );
}

function FieldInput({
    field,
    id,
    value,
    locked,
    invalid,
    onChange
}: {
    field: FormField;
    id: string;
    value: FormValue | undefined;
    locked: boolean;
    invalid: boolean;
    onChange: (value: FormValue | undefined) => void;
}) {
    const t = useTranslations("polar");
    const common = { id, disabled: locked, "aria-invalid": invalid || undefined } as const;
    switch (field.type) {
        case "text":
            return (
                <Input
                    {...common}
                    value={typeof value === "string" ? value : ""}
                    maxLength={FORM_TEXT_MAX}
                    placeholder={field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                />
            );
        case "textarea":
            return (
                <Textarea
                    {...common}
                    rows={3}
                    value={typeof value === "string" ? value : ""}
                    maxLength={FORM_TEXTAREA_MAX}
                    placeholder={field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                />
            );
        case "number":
            return (
                <Input
                    {...common}
                    type="number"
                    inputMode="decimal"
                    min={field.min}
                    max={field.max}
                    step={field.step ?? "any"}
                    value={typeof value === "number" ? String(value) : ""}
                    onChange={(event) =>
                        onChange(event.target.value === "" ? undefined : Number(event.target.value))
                    }
                />
            );
        case "date":
            return (
                <Input
                    {...common}
                    type="date"
                    min={field.min}
                    max={field.max}
                    value={typeof value === "string" ? value : ""}
                    onChange={(event) => onChange(event.target.value || undefined)}
                />
            );
        case "choice": {
            const picked = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
            return (
                <div
                    role={field.multiple ? "group" : "radiogroup"}
                    aria-labelledby={`${id}-label`}
                    className="flex min-w-0 flex-wrap gap-1.5"
                >
                    {field.options.map((option) => {
                        const on = picked.includes(option);
                        return (
                            <button
                                key={option}
                                type="button"
                                role={field.multiple ? "checkbox" : "radio"}
                                aria-checked={on}
                                disabled={locked}
                                onClick={() => {
                                    if (!field.multiple) return onChange(on ? undefined : option);
                                    const next = on ? picked.filter((entry) => entry !== option) : [...picked, option];
                                    onChange(next.length > 0 ? next : undefined);
                                }}
                                className={cn(
                                    "min-w-0 max-w-full truncate rounded-full border px-2.5 py-1 text-sm transition-colors hover:bg-card-hover disabled:opacity-60",
                                    on ? "border-primary bg-primary/10" : "border-border"
                                )}
                            >
                                {option}
                            </button>
                        );
                    })}
                </div>
            );
        }
        case "rating": {
            const max = ratingMax(field);
            const current = typeof value === "number" ? value : 0;
            return (
                <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex items-center gap-0.5">
                    {Array.from({ length: max }, (_, index) => index + 1).map((count) => (
                        <button
                            key={count}
                            type="button"
                            role="radio"
                            aria-checked={current === count}
                            aria-label={t("form.stars", { count, max })}
                            disabled={locked}
                            onClick={() => onChange(current === count ? undefined : count)}
                            className="rounded p-0.5 hover:bg-card-hover disabled:opacity-60"
                        >
                            <Star
                                className={cn(
                                    "size-5 shrink-0",
                                    count <= current ? "fill-primary text-primary" : "text-muted-foreground"
                                )}
                                aria-hidden
                            />
                        </button>
                    ))}
                </div>
            );
        }
    }
}
