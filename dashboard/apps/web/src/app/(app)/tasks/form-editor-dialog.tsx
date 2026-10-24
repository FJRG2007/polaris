"use client";

/**
 * Editing an intake form after it was made: what it is called and where it
 * files, what it asks, what it says, who may send it, and the same link limits
 * every public link in Polaris offers (password, expiry, a cap on submissions,
 * addresses and regions). The public route enforces those limits
 * (`lib/tasks/form-access`); this only saves them.
 */

import { useState } from "react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { optionLabel } from "./option-label";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { FormView } from "@/lib/tasks/form-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    LinkAdvancedFields,
    linkLimits,
    linkExpiryDay,
    linkGuardFields,
    type LinkAdvancedValue
} from "@/components/link-advanced-fields";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty,
    Select,
    Switch,
    Textarea
} from "@polaris/ui";

interface Draft {
    name: string;
    listId: string;
    intro: string;
    confirmation: string;
    requireLogin: boolean;
    enabled: boolean;
    fields: core.FormField[];
    advanced: LinkAdvancedValue;
}

function draftOf(form: FormView): Draft {
    return {
        name: form.name,
        listId: form.listId,
        intro: form.intro,
        confirmation: form.confirmation,
        requireLogin: form.requireLogin,
        enabled: form.enabled,
        fields: form.fields,
        advanced: {
            password: "",
            expiresAt: linkExpiryDay(form.expiresAt),
            maxUses: form.maxSubmissions === null ? "" : String(form.maxSubmissions),
            allowedCidrs: form.allowedCidrs,
            allowedCountries: form.allowedCountries,
            allowedContinents: form.allowedContinents,
            ...linkGuardFields(form.guards)
        }
    };
}

/** A new question's id: unique within the form, which is all an answer key needs. */
function questionId(fields: readonly core.FormField[]): string {
    let n = fields.length + 1;
    while (fields.some((field) => field.id === `q${n}`)) n += 1;
    return `q${n}`;
}

/** A dropdown's choices typed as one comma-separated line. The text is kept as
 *  typed, so a trailing comma survives until the next choice follows it. */
function ChoicesInput({
    options,
    label,
    onChange
}: {
    options: readonly string[];
    label: string;
    onChange: (options: string[]) => void;
}) {
    const [text, setText] = useState(() => options.join(", "));
    return (
        <Input
            value={text}
            aria-label={label}
            placeholder={label}
            onChange={(event) => {
                setText(event.target.value);
                onChange(
                    event.target.value
                        .split(",")
                        .map((option) => option.trim())
                        .filter(Boolean)
                        .slice(0, 30)
                );
            }}
        />
    );
}

export function FormEditorDialog({
    form,
    spaceId,
    lists,
    onClose
}: {
    form: FormView;
    spaceId: string;
    lists: readonly { id: string; name: string }[];
    onClose: () => void;
}) {
    const t = useTranslations("tasks");
    const tc = useTranslations("common");
    const [initial] = useState(() => draftOf(form));
    const [draft, setDraft] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
        setDraft((d) => ({ ...d, [key]: value }));
    const setField = (index: number, patch: Partial<core.FormField>) =>
        set(
            "fields",
            draft.fields.map((field, i) => (i === index ? { ...field, ...patch } : field))
        );

    // A typed password is always a change: a stored one cannot be read back.
    const dirty = draft.advanced.password !== "" || isDirty(initial, draft);
    const complete =
        draft.name.trim() !== "" &&
        draft.listId !== "" &&
        draft.fields.length > 0 &&
        draft.fields.every(
            (field) =>
                field.label.trim() !== "" && (field.type !== "dropdown" || field.options.length > 0)
        );

    const save = async () => {
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.updateFormAction(spaceId, form.id, {
                    listId: draft.listId,
                    name: draft.name.trim(),
                    intro: draft.intro,
                    fields: draft.fields,
                    defaultStatusId: form.defaultStatusId,
                    confirmation: draft.confirmation,
                    requireLogin: draft.requireLogin,
                    enabled: draft.enabled,
                    limits: linkLimits(draft.advanced)
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) setError(result.error);
        else onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle className="truncate">
                        {t("forms.editor.title", { name: form.name })}
                    </DialogTitle>
                    <DialogDescription>{t("forms.editor.hint")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("forms.name")} *</span>
                        <Input
                            value={draft.name}
                            onChange={(event) => set("name", event.target.value)}
                        />
                    </label>
                    <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("forms.list")} *</span>
                        <Select
                            value={draft.listId}
                            onValueChange={(listId) => set("listId", listId)}
                            options={lists.map((list) => ({ value: list.id, label: list.name }))}
                            aria-label={t("forms.list")}
                        />
                    </div>
                    <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("forms.editor.intro")}
                        </span>
                        <Textarea
                            value={draft.intro}
                            maxLength={1000}
                            rows={2}
                            onChange={(event) => set("intro", event.target.value)}
                        />
                    </label>

                    <fieldset className="flex min-w-0 flex-col gap-2">
                        <legend className="mb-1 text-xs text-muted-foreground">
                            {t("forms.editor.questions")} *
                        </legend>
                        {draft.fields.map((field, index) => (
                            <div
                                key={field.id}
                                className="flex flex-col gap-2 rounded-md border border-border p-2"
                            >
                                <div className="flex min-w-0 items-center gap-2">
                                    <Input
                                        value={field.label}
                                        aria-label={t("forms.editor.question")}
                                        placeholder={t("forms.editor.question")}
                                        maxLength={200}
                                        className="min-w-0 flex-1"
                                        onChange={(event) =>
                                            setField(index, { label: event.target.value })
                                        }
                                    />
                                    <Select
                                        value={field.type}
                                        onValueChange={(type) =>
                                            setField(index, { type: type as core.FormFieldType })
                                        }
                                        options={core.FORM_FIELD_TYPES.map((type) => ({
                                            value: type,
                                            label: optionLabel(t, "formField", type)
                                        }))}
                                        aria-label={t("forms.editor.type")}
                                        className="w-36 shrink-0"
                                    />
                                    <button
                                        type="button"
                                        aria-label={t("forms.editor.removeQuestion")}
                                        title={t("forms.editor.removeQuestion")}
                                        disabled={draft.fields.length === 1}
                                        onClick={() =>
                                            set(
                                                "fields",
                                                draft.fields.filter((_, i) => i !== index)
                                            )
                                        }
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger disabled:opacity-40"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </div>
                                {field.type === "dropdown" && (
                                    <ChoicesInput
                                        options={field.options}
                                        label={t("forms.editor.choices")}
                                        onChange={(options) => setField(index, { options })}
                                    />
                                )}
                                <label className="flex items-center gap-2 text-xs">
                                    <Switch
                                        checked={field.required}
                                        aria-label={t("forms.editor.required")}
                                        onChange={(required) => setField(index, { required })}
                                    />
                                    {t("forms.editor.required")}
                                </label>
                            </div>
                        ))}
                        {draft.fields.length < 30 && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="self-start"
                                onClick={() =>
                                    set("fields", [
                                        ...draft.fields,
                                        {
                                            id: questionId(draft.fields),
                                            label: "",
                                            type: "text",
                                            required: false,
                                            options: [],
                                            mapsTo: ""
                                        }
                                    ])
                                }
                            >
                                <Plus className="size-3.5" /> {t("forms.editor.addQuestion")}
                            </Button>
                        )}
                    </fieldset>

                    <label className="flex min-w-0 flex-col gap-1">
                        <span className="text-xs text-muted-foreground">
                            {t("forms.editor.confirmation")}
                        </span>
                        <Input
                            value={draft.confirmation}
                            maxLength={500}
                            onChange={(event) => set("confirmation", event.target.value)}
                        />
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={draft.enabled}
                            onChange={(enabled) => set("enabled", enabled)}
                        />
                        {t("forms.editor.open")}
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                        <Switch
                            checked={draft.requireLogin}
                            onChange={(requireLogin) => set("requireLogin", requireLogin)}
                        />
                        {t("forms.editor.requireLogin")}
                    </label>

                    <LinkAdvancedFields
                        value={draft.advanced}
                        onChange={(advanced) => set("advanced", advanced)}
                        passwordSet={form.hasPassword}
                        clearablePassword
                        usesLabel={t("forms.editor.maxSubmissions")}
                        // The form has its own "require sign-in" switch above.
                        omit={["signin"]}
                        idPrefix={`form-${form.id}`}
                    />

                    {error && <p className="text-xs text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={onClose}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button
                            size="sm"
                            disabled={saving || !dirty || !complete}
                            onClick={() => void save()}
                        >
                            {saving && <Loader2 className="size-4 animate-spin" />}
                            {t("forms.editor.save")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
