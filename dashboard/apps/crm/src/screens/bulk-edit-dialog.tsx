"use client";

/**
 * Giving every chosen record the same value for one field: the stage of ten
 * opportunities, the owner of a batch of companies. The value is checked as it
 * is typed, with the same rules a cell uses.
 */

import { useCrmT } from "./i18n";
import { currencyName } from "./format";
import { RefChip } from "./cell-display";
import { CellPicker } from "./cell-picker";
import { CURRENCIES } from "@polaris/core";
import { hostUi } from "@polaris/app-host/client";
import { useMemo, useState, type FormEvent } from "react";
import { normalizeInput, parseAmount, typedCount, type InputValue } from "../model/values";
import { FIELDS, type CrmObject, type FieldDef, type FieldValue, type Ref } from "../model/objects";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** Stands for "no value" in a list of choices, which cannot hold an empty one. */
const NONE = "-";

interface Draft {
    readonly text: string;
    readonly currency: string;
    readonly ref: Ref | null;
}

/** What a field's value starts as in the dialog: its first choice, or nothing. */
function startText(field: FieldDef | undefined): string {
    if (field?.kind === "select") return field.options?.[0] ?? "";
    if (field?.kind === "boolean") return "yes";
    if (field?.kind === "member") return NONE;
    return "";
}

/** What the draft holds for a field, ready to store, or why it cannot be. */
function settle(
    field: FieldDef,
    draft: Draft
): { stored: InputValue; shown: FieldValue } | { error: string } {
    let raw: unknown = draft.text;
    if (field.kind === "currency") {
        const amount = draft.text.trim() === "" ? null : parseAmount(draft.text);
        if (draft.text.trim() !== "" && amount === null) return { error: "number" };
        raw = { amount, currency: draft.currency };
    } else if (field.kind === "boolean") {
        raw = draft.text === "yes";
    } else if (field.kind === "relation") {
        raw = draft.ref?.id ?? null;
    } else if (field.kind === "member" || field.kind === "select") {
        raw = draft.text === NONE ? null : draft.text;
    } else if (field.kind === "number") {
        raw = typedCount(draft.text);
    }
    const result = normalizeInput(field, raw);
    if (!result.ok) return { error: result.reason };
    const shown: FieldValue =
        field.kind === "relation"
            ? draft.ref
            : field.kind === "member"
              ? null
              : (result.value as FieldValue);
    return { stored: result.value, shown };
}

export function BulkEditDialog({
    object,
    count,
    people,
    defaultCurrency,
    onApply,
    onClose
}: {
    object: CrmObject;
    /** How many records are chosen. */
    count: number;
    people: readonly Ref[];
    defaultCurrency: string;
    /** Resolves once the server has answered; the dialog closes either way. */
    onApply: (field: FieldDef, stored: InputValue, shown: FieldValue) => void;
    onClose: () => void;
}) {
    const t = useCrmT();
    const locale = hostUi.i18nProvider.useLocale();
    const editable = useMemo(
        () => FIELDS[object].filter((field) => !field.primary && !field.readOnly),
        [object]
    );
    const [key, setKey] = useState(editable[0]!.key);
    const field = editable.find((one) => one.key === key) ?? editable[0]!;
    const [draft, setDraft] = useState<Draft>(() => ({
        text: startText(editable[0]),
        currency: defaultCurrency,
        ref: null
    }));
    const [touched, setTouched] = useState(false);
    const [picking, setPicking] = useState(false);
    const result = settle(field, draft);
    const error =
        "error" in result ? t(`invalid.${result.error}` as Parameters<typeof t>[0]) : null;
    const fieldLabel = (one: FieldDef) =>
        t(`fields.${object}.${one.key}` as Parameters<typeof t>[0]);

    const choose = (next: string) => {
        setKey(next);
        setDraft({
            text: startText(editable.find((one) => one.key === next)),
            currency: defaultCurrency,
            ref: null
        });
        setTouched(false);
    };

    const submit = (event: FormEvent) => {
        event.preventDefault();
        setTouched(true);
        if ("error" in result) return;
        const shown =
            field.kind === "member"
                ? (people.find((person) => person.id === result.stored) ?? null)
                : result.shown;
        onApply(field, result.stored, shown);
        onClose();
    };

    const textInput = (type: string, mode?: "numeric" | "decimal" | "tel" | "email") => (
        <Input
            id="crm-bulk-value"
            type={type}
            inputMode={mode}
            value={draft.text}
            aria-invalid={Boolean(touched && error)}
            onChange={(event) => {
                setDraft({ ...draft, text: event.target.value });
                setTouched(true);
            }}
        />
    );

    const valueControl = () => {
        switch (field.kind) {
            case "select":
                return (
                    <Select
                        id="crm-bulk-value"
                        value={draft.text}
                        onValueChange={(text) => setDraft({ ...draft, text })}
                        options={(field.options ?? []).map((option) => ({
                            value: option,
                            label: t(
                                `options.${object}.${field.key}.${option}` as Parameters<
                                    typeof t
                                >[0]
                            )
                        }))}
                    />
                );
            case "boolean":
                return (
                    <Select
                        id="crm-bulk-value"
                        value={draft.text || "yes"}
                        onValueChange={(text) => setDraft({ ...draft, text })}
                        options={[
                            { value: "yes", label: t("values.yes") },
                            { value: "no", label: t("values.no") }
                        ]}
                    />
                );
            case "member":
                return (
                    <Select
                        id="crm-bulk-value"
                        value={draft.text || NONE}
                        onValueChange={(text) => setDraft({ ...draft, text })}
                        options={[
                            { value: NONE, label: t("picker.none") },
                            ...people.map((person) => ({ value: person.id, label: person.name }))
                        ]}
                    />
                );
            case "relation":
                return (
                    <div className="relative">
                        <Button
                            id="crm-bulk-value"
                            type="button"
                            variant="outline"
                            className="w-full justify-start"
                            onClick={() => setPicking(true)}
                        >
                            {draft.ref && field.target ? (
                                <RefChip target={field.target} value={draft.ref} />
                            ) : (
                                <span className="text-muted-foreground">{t("picker.none")}</span>
                            )}
                        </Button>
                        {picking ? (
                            <CellPicker
                                object={object}
                                field={field}
                                value={draft.ref}
                                people={people}
                                onClose={() => setPicking(false)}
                                onPick={(_, shown) => {
                                    setPicking(false);
                                    setDraft({ ...draft, ref: (shown as Ref | null) ?? null });
                                }}
                            />
                        ) : null}
                    </div>
                );
            case "currency":
                return (
                    <div className="flex gap-2">
                        {textInput("text", "decimal")}
                        <Select
                            value={draft.currency}
                            onValueChange={(currency) => setDraft({ ...draft, currency })}
                            aria-label={t("fields.currencyOf")}
                            className="w-28 shrink-0"
                            options={CURRENCIES.map((entry) => ({
                                value: entry.code,
                                label: `${entry.code} - ${currencyName(entry.code, locale)}`
                            }))}
                        />
                    </div>
                );
            case "date":
                return textInput("date");
            case "number":
                return textInput("text", "numeric");
            case "email":
                return textInput("email", "email");
            case "phone":
                return textInput("tel", "tel");
            default:
                return textInput("text");
        }
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <form onSubmit={submit} className="flex flex-col gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("bulk.title", { count })}</DialogTitle>
                        <DialogDescription>{t("bulk.description")}</DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="crm-bulk-field" className="text-[0.8125rem] font-medium">
                            {t("bulk.field")}
                        </label>
                        <Select
                            id="crm-bulk-field"
                            value={field.key}
                            onValueChange={choose}
                            options={editable.map((one) => ({
                                value: one.key,
                                label: fieldLabel(one)
                            }))}
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="crm-bulk-value" className="text-[0.8125rem] font-medium">
                            {t("bulk.value")}
                        </label>
                        {valueControl()}
                        {touched && error ? (
                            <p className="text-[0.75rem] text-danger">{error}</p>
                        ) : null}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={touched && Boolean(error)}>
                            {t("bulk.apply", { count })}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
