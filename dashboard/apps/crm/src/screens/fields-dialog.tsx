/**
 * The fields added to one kind of record: add one, rename it or change a
 * select's choices, delete it. Checked as it is typed against the schema the
 * server checks it with.
 */

import { useCrmT } from "./i18n";
import { currencyName } from "./format";
import { CURRENCIES } from "@polaris/core";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/records";
import { useState, type FormEvent } from "react";
import { hostUi } from "@polaris/app-host/client";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import {
    CRM_OBJECTS,
    CUSTOM_KINDS,
    isCrmObject,
    type CrmObject,
    type CustomKind
} from "../model/objects";
import {
    choiceChanges,
    FIELD_LABEL_MAX,
    fieldInputSchema,
    hasOptions,
    MAX_OPTIONS,
    normalizeLabel,
    RELATION_CARDINALITIES,
    type CustomField
} from "../model/fields";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    isDirty,
    useToast
} from "@polaris/ui";

interface FieldsDialogProps {
    readonly object: CrmObject;
    readonly fields: readonly CustomField[];
    /** Whether the reader may delete records: deleting a field or one of its
     *  choices loses what the records hold there. */
    readonly canDelete: boolean;
    /** A field was added: it is put in the view's columns. */
    readonly onCreated: (field: CustomField) => void;
    /** Something changed: the list is read again. */
    readonly onChanged: () => void;
    readonly onClose: () => void;
}

export function FieldsDialog({
    object,
    fields,
    canDelete,
    onCreated,
    onChanged,
    onClose
}: FieldsDialogProps) {
    const t = useCrmT();
    const toast = useToast();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [editing, setEditing] = useState<CustomField | "new" | null>(
        fields.length > 0 ? null : "new"
    );
    const [failure, setFailure] = useState<string | null>(null);
    const deleteDenied = canDelete ? null : t("errors.forbidden", { verb: "delete", object });

    const remove = async (field: CustomField) => {
        const ok = await confirm({
            title: t("customFields.deleteTitle", { name: field.label }),
            description: t("customFields.deleteDescription"),
            confirmLabel: t("customFields.delete"),
            danger: true
        });
        if (!ok) return;
        setFailure(null);
        try {
            await unwrap(
                () => actions.deleteFieldAction({ object, fieldId: field.id }),
                t("errors.fieldNotDeleted")
            );
            toast.show({ title: t("customFields.deleted", { name: field.label }) });
            onChanged();
        } catch (caught) {
            setFailure(messageOf(caught));
        }
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-md">
                <DialogHeader className="mb-0">
                    <DialogTitle>{t("customFields.title")}</DialogTitle>
                    <DialogDescription>{t("customFields.intro")}</DialogDescription>
                </DialogHeader>
                {editing ? (
                    <FieldForm
                        object={object}
                        field={editing === "new" ? null : editing}
                        canDelete={canDelete}
                        taken={fields
                            .filter((one) => editing === "new" || one.id !== editing.id)
                            .map((one) => one.label.toLowerCase())}
                        onDone={(saved, created) => {
                            setEditing(null);
                            if (created) {
                                toast.show({
                                    title: t("customFields.created", { name: saved.label })
                                });
                                onCreated(saved);
                            } else onChanged();
                        }}
                        onCancel={() => (fields.length > 0 ? setEditing(null) : onClose())}
                    />
                ) : (
                    <div className="flex flex-col gap-3">
                        {fields.length === 0 ? (
                            <p className="text-[0.8125rem] text-muted-foreground">
                                {t("customFields.empty")}
                            </p>
                        ) : (
                            <ul className="flex flex-col gap-1">
                                {fields.map((field) => (
                                    <li key={field.id} className="flex min-w-0 items-center gap-2">
                                        <span
                                            className="min-w-0 flex-1 truncate text-[0.8125rem]"
                                            title={field.label}
                                        >
                                            {field.label}
                                        </span>
                                        <span className="shrink-0 text-[0.75rem] text-muted-foreground">
                                            {t(`customFields.kinds.${field.kind}`)}
                                        </span>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("customFields.edit")}
                                            title={t("customFields.edit")}
                                            onClick={() => setEditing(field)}
                                        >
                                            <Pencil className="size-4" />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("customFields.delete")}
                                            title={deleteDenied ?? t("customFields.delete")}
                                            disabled={!canDelete}
                                            onClick={() => void remove(field)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {failure ? <p className="text-[0.75rem] text-danger">{failure}</p> : null}
                        <DialogFooter className="mt-0">
                            <Button type="button" variant="ghost" onClick={onClose}>
                                {t("actions.cancel")}
                            </Button>
                            <Button type="button" onClick={() => setEditing("new")}>
                                <Plus className="size-4" />
                                {t("customFields.add")}
                            </Button>
                        </DialogFooter>
                    </div>
                )}
                {confirmElement}
            </DialogContent>
        </Dialog>
    );
}

interface FieldFormProps {
    readonly object: CrmObject;
    readonly field: CustomField | null;
    readonly canDelete: boolean;
    /** The other fields' names, lowercased. */
    readonly taken: readonly string[];
    readonly onDone: (field: CustomField, created: boolean) => void;
    readonly onCancel: () => void;
}

/** One line of a select's choices: what it reads now, and the saved choice it
 *  started as, so rewording it keeps the records that hold it. */
interface ChoiceRow {
    readonly text: string;
    readonly from: string | null;
}

function FieldForm({ object, field, canDelete, taken, onDone, onCancel }: FieldFormProps) {
    const t = useCrmT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [label, setLabel] = useState(field?.label ?? "");
    const [kind, setKind] = useState<CustomKind>(field?.kind ?? "text");
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [currency, setCurrency] = useState(
        field?.kind === "money"
            ? (field.options[0] ?? "")
            : CURRENCIES.some((entry) => entry.code === format.preferences.currency)
              ? format.preferences.currency
              : "EUR"
    );
    const [target, setTarget] = useState<CrmObject>(
        field?.kind === "relation" && isCrmObject(field.options[0] ?? "")
            ? (field.options[0] as CrmObject)
            : object
    );
    const [cardinality, setCardinality] = useState<"one" | "many">(
        field?.kind === "relation" && field.options[1] === "many" ? "many" : "one"
    );
    const [rows, setRows] = useState<ChoiceRow[]>(
        field && hasOptions(field.kind) && field.options.length > 0
            ? field.options.map((option) => ({ text: option, from: option }))
            : [{ text: "", from: null }]
    );
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const parsed = fieldInputSchema.safeParse({
        label,
        kind,
        options:
            kind === "money"
                ? [currency]
                : kind === "relation"
                  ? [target, cardinality]
                  : rows.map((row) => row.text).filter((one) => one.trim() !== "")
    });
    const issue = (path: string): string | null =>
        parsed.success
            ? null
            : (parsed.error.issues.find((one) => String(one.path[0]) === path)?.message ?? null);
    // An empty name or no choice yet is not filled in rather than wrong: the
    // button waits and nothing is shown in red.
    const nameIssue = label.trim() === "" ? null : issue("label");
    const nameTaken = parsed.success && taken.includes(parsed.data.label.toLowerCase());
    const optionsIssue =
        hasOptions(kind) && rows.some((row) => row.text.trim() !== "") ? issue("options") : null;
    const unchanged =
        field !== null &&
        parsed.success &&
        !isDirty(
            { label: field.label, options: field.options },
            { label: parsed.data.label, options: parsed.data.options }
        );
    const renames = rows.flatMap((row) =>
        hasOptions(kind) && row.from !== null && row.text.trim() !== ""
            ? [{ from: row.from, to: normalizeLabel(row.text) }]
            : []
    );
    const removed =
        field && parsed.success
            ? choiceChanges(field.options, parsed.data.options, renames).removed
            : [];
    const forbidden = t("errors.forbidden", { verb: "delete", object });
    const removeDenied = removed.length > 0 && !canDelete;
    const blocked = busy || !parsed.success || nameTaken || unchanged || removeDenied;
    const say = (code: string) =>
        t(`customFields.invalid.${code}` as Parameters<typeof t>[0], {
            length: FIELD_LABEL_MAX,
            max: MAX_OPTIONS
        });

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (blocked || !parsed.success) return;
        const input = parsed.data;
        if (removed.length > 0) {
            const ok = await confirm({
                title: t("customFields.removeChoicesTitle", { count: removed.length }),
                description: t("customFields.removeChoicesDescription", {
                    choices: removed.join(", ")
                }),
                confirmLabel: t("customFields.save"),
                danger: true
            });
            if (!ok) return;
        }
        setBusy(true);
        setFailure(null);
        const call = field
            ? () => actions.updateFieldAction({ object, fieldId: field.id, field: input, renames })
            : () => actions.createFieldAction({ object, field: input });
        unwrap(call, t("errors.fieldNotSaved"))
            .then((answer) => onDone(answer.field, field === null))
            .catch((caught) => {
                setFailure(messageOf(caught));
                setBusy(false);
            });
    };

    return (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[0.8125rem]">
                <span className="font-medium">
                    {t("customFields.name")}
                    <span aria-hidden className="text-danger">
                        {" "}
                        *
                    </span>
                </span>
                <Input
                    autoFocus
                    value={label}
                    maxLength={FIELD_LABEL_MAX}
                    required
                    aria-invalid={Boolean(nameIssue) || nameTaken}
                    placeholder={t("customFields.namePlaceholder")}
                    onChange={(event) => setLabel(event.target.value)}
                />
                {nameTaken ? (
                    <span className="text-[0.75rem] text-danger">{t("errors.fieldNameTaken")}</span>
                ) : nameIssue ? (
                    <span className="text-[0.75rem] text-danger">{say(nameIssue)}</span>
                ) : null}
            </label>
            <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                <span className="font-medium">{t("customFields.kind")}</span>
                {field !== null ? (
                    <span className="text-muted-foreground" title={t("customFields.kindFixed")}>
                        {t(`customFields.kinds.${kind}`)}
                    </span>
                ) : (
                    <Select
                        value={kind}
                        aria-label={t("customFields.kind")}
                        options={CUSTOM_KINDS.map((one) => ({
                            value: one,
                            label: t(`customFields.kinds.${one}`)
                        }))}
                        onValueChange={(next) => setKind(next as CustomKind)}
                    />
                )}
            </div>
            {kind === "money" ? (
                <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                    <span className="font-medium">{t("customFields.currency")}</span>
                    {field !== null ? (
                        <span
                            className="text-muted-foreground"
                            title={t("customFields.currencyFixed")}
                        >
                            {`${currency} - ${currencyName(currency, locale)}`}
                        </span>
                    ) : (
                        <Select
                            value={currency}
                            aria-label={t("customFields.currency")}
                            options={CURRENCIES.map((entry) => ({
                                value: entry.code,
                                label: `${entry.code} - ${currencyName(entry.code, locale)}`
                            }))}
                            onValueChange={setCurrency}
                        />
                    )}
                </div>
            ) : null}
            {kind === "relation" ? (
                <>
                    <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                        <span className="font-medium">{t("customFields.target")}</span>
                        {field !== null ? (
                            <span
                                className="text-muted-foreground"
                                title={t("customFields.targetFixed")}
                            >
                                {t(`objects.${target}.plural`)}
                            </span>
                        ) : (
                            <Select
                                value={target}
                                aria-label={t("customFields.target")}
                                options={CRM_OBJECTS.map((one) => ({
                                    value: one,
                                    label: t(`objects.${one}.plural`)
                                }))}
                                onValueChange={(next) => setTarget(next as CrmObject)}
                            />
                        )}
                    </div>
                    <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                        <span className="font-medium">{t("customFields.cardinality")}</span>
                        {field !== null ? (
                            <span
                                className="text-muted-foreground"
                                title={t("customFields.cardinalityFixed")}
                            >
                                {t(`customFields.cardinalities.${cardinality}`)}
                            </span>
                        ) : (
                            <Select
                                value={cardinality}
                                aria-label={t("customFields.cardinality")}
                                options={RELATION_CARDINALITIES.map((one) => ({
                                    value: one,
                                    label: t(`customFields.cardinalities.${one}`)
                                }))}
                                onValueChange={(next) => setCardinality(next as "one" | "many")}
                            />
                        )}
                    </div>
                </>
            ) : null}
            {hasOptions(kind) ? (
                <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                    <span className="font-medium">
                        {t("customFields.options")}
                        <span aria-hidden className="text-danger">
                            {" "}
                            *
                        </span>
                    </span>
                    {rows.map((row, index) => (
                        <div key={index} className="flex min-w-0 items-center gap-1">
                            <Input
                                value={row.text}
                                maxLength={FIELD_LABEL_MAX}
                                placeholder={t("customFields.optionPlaceholder")}
                                aria-label={t("customFields.options")}
                                className="min-w-0 flex-1"
                                onChange={(event) =>
                                    setRows(
                                        rows.map((one, at) =>
                                            at === index
                                                ? { ...one, text: event.target.value }
                                                : one
                                        )
                                    )
                                }
                            />
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={t("customFields.removeOption")}
                                title={
                                    row.from !== null && !canDelete
                                        ? forbidden
                                        : t("customFields.removeOption")
                                }
                                disabled={rows.length === 1 || (row.from !== null && !canDelete)}
                                onClick={() => setRows(rows.filter((_, at) => at !== index))}
                            >
                                <X className="size-4" />
                            </Button>
                        </div>
                    ))}
                    {optionsIssue ? (
                        <span className="text-[0.75rem] text-danger">{say(optionsIssue)}</span>
                    ) : removeDenied ? (
                        <span className="text-[0.75rem] text-danger">{forbidden}</span>
                    ) : null}
                    <Button
                        type="button"
                        variant="ghost"
                        className="self-start"
                        disabled={rows.length >= MAX_OPTIONS}
                        onClick={() => setRows([...rows, { text: "", from: null }])}
                    >
                        <Plus className="size-4" />
                        {t("customFields.addOption")}
                    </Button>
                </div>
            ) : null}
            {failure ? <p className="text-[0.75rem] text-danger">{failure}</p> : null}
            <DialogFooter className="mt-0">
                <Button type="button" variant="ghost" onClick={onCancel}>
                    {t("actions.cancel")}
                </Button>
                <Button
                    type="submit"
                    aria-disabled={blocked}
                    className={blocked ? "opacity-60" : undefined}
                >
                    {field ? t("customFields.save") : t("customFields.create")}
                </Button>
            </DialogFooter>
            {confirmElement}
        </form>
    );
}
