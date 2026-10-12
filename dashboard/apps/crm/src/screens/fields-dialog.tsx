/**
 * The fields added to one kind of record: add one, rename it or change a
 * select's choices, delete it. Checked as it is typed against the schema the
 * server checks it with.
 */

import { useCrmT } from "./i18n";
import { messageOf, unwrap } from "./call";
import * as actions from "../actions/records";
import { useState, type FormEvent } from "react";
import { hostUi } from "@polaris/app-host/client";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { CUSTOM_KINDS, type CrmObject, type CustomKind } from "../model/objects";
import { FIELD_LABEL_MAX, MAX_OPTIONS, fieldInputSchema, type CustomField } from "../model/fields";
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

interface FieldsDialogProps {
    readonly object: CrmObject;
    readonly fields: readonly CustomField[];
    /** A field was added: it is put in the view's columns. */
    readonly onCreated: (field: CustomField) => void;
    /** Something changed: the list is read again. */
    readonly onChanged: () => void;
    readonly onClose: () => void;
}

export function FieldsDialog({ object, fields, onCreated, onChanged, onClose }: FieldsDialogProps) {
    const t = useCrmT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [editing, setEditing] = useState<CustomField | "new" | null>(
        fields.length > 0 ? null : "new"
    );
    const [failure, setFailure] = useState<string | null>(null);

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
                        taken={fields
                            .filter((one) => editing === "new" || one.id !== editing.id)
                            .map((one) => one.label.toLowerCase())}
                        onDone={(saved, created) => {
                            setEditing(null);
                            if (created) onCreated(saved);
                            else onChanged();
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
                                            title={t("customFields.delete")}
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
    /** The other fields' names, lowercased. */
    readonly taken: readonly string[];
    readonly onDone: (field: CustomField, created: boolean) => void;
    readonly onCancel: () => void;
}

function FieldForm({ object, field, taken, onDone, onCancel }: FieldFormProps) {
    const t = useCrmT();
    const [label, setLabel] = useState(field?.label ?? "");
    const [kind, setKind] = useState<CustomKind>(field?.kind ?? "text");
    const [options, setOptions] = useState<string[]>(
        field && field.options.length > 0 ? [...field.options] : [""]
    );
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const parsed = fieldInputSchema.safeParse({
        label,
        kind,
        options: options.filter((one) => one.trim() !== "")
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
        kind === "select" && options.some((one) => one.trim() !== "") ? issue("options") : null;
    const unchanged =
        field !== null &&
        parsed.success &&
        parsed.data.label === field.label &&
        JSON.stringify(parsed.data.options) === JSON.stringify(field.options);
    const blocked = busy || !parsed.success || nameTaken || unchanged;
    const say = (code: string) =>
        t(`customFields.invalid.${code}` as Parameters<typeof t>[0], {
            length: FIELD_LABEL_MAX,
            max: MAX_OPTIONS
        });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (blocked || !parsed.success) return;
        const input = parsed.data;
        setBusy(true);
        setFailure(null);
        const call = field
            ? () => actions.updateFieldAction({ object, fieldId: field.id, field: input })
            : () => actions.createFieldAction({ object, field: input });
        unwrap(call, t("errors.fieldNotSaved"))
            .then((answer) => onDone(answer.field, field === null))
            .catch((caught) => {
                setFailure(messageOf(caught));
                setBusy(false);
            });
    };

    return (
        <form onSubmit={submit} className="flex flex-col gap-4">
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
            {kind === "select" ? (
                <div className="flex flex-col gap-1.5 text-[0.8125rem]">
                    <span className="font-medium">
                        {t("customFields.options")}
                        <span aria-hidden className="text-danger">
                            {" "}
                            *
                        </span>
                    </span>
                    {options.map((option, index) => (
                        <div key={index} className="flex min-w-0 items-center gap-1">
                            <Input
                                value={option}
                                maxLength={FIELD_LABEL_MAX}
                                placeholder={t("customFields.optionPlaceholder")}
                                aria-label={t("customFields.options")}
                                className="min-w-0 flex-1"
                                onChange={(event) =>
                                    setOptions(
                                        options.map((one, at) =>
                                            at === index ? event.target.value : one
                                        )
                                    )
                                }
                            />
                            <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={t("customFields.removeOption")}
                                title={t("customFields.removeOption")}
                                disabled={options.length === 1}
                                onClick={() => setOptions(options.filter((_, at) => at !== index))}
                            >
                                <X className="size-4" />
                            </Button>
                        </div>
                    ))}
                    {optionsIssue ? (
                        <span className="text-[0.75rem] text-danger">{say(optionsIssue)}</span>
                    ) : null}
                    <Button
                        type="button"
                        variant="ghost"
                        className="self-start"
                        disabled={options.length >= MAX_OPTIONS}
                        onClick={() => setOptions([...options, ""])}
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
        </form>
    );
}
