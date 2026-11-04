"use client";

/**
 * Defining a name tag: the switch, the text, the emblem and its color, with a
 * preview. Shared by an organization's settings and the instance's own tag, and
 * validated as it is typed with the schema the server enforces.
 */

import { useState } from "react";
import { Check } from "lucide-react";
import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { NAME_TAG_HEX, NameTagEmblemMark, NameTagLabel } from "./name-tag-chip";
import { Button, Card, CardBody, CardHeader, CardTitle, cn, Input, Switch } from "@polaris/ui";

export interface NameTagFormValue {
    enabled: boolean;
    text: string;
    emblem: string;
    color: core.NameTagColor;
}

type ErrorKey =
    | "required"
    | "tooLong"
    | "characters"
    | "reserved"
    | "emblem"
    | "invalid"
    | "forbidden"
    | "unavailable";

const ERROR_KEYS: readonly string[] = [
    "required",
    "tooLong",
    "characters",
    "reserved",
    "emblem",
    "invalid",
    "forbidden",
    "unavailable"
];

/** A refusal code from the schema or the server, as a key this screen can say. */
export function nameTagErrorKey(code: string | undefined): ErrorKey {
    return (code && ERROR_KEYS.includes(code) ? code : "invalid") as ErrorKey;
}

export function NameTagEditor({
    title,
    intro,
    initial,
    staff,
    image,
    onSave
}: {
    title: string;
    intro: string;
    initial: NameTagFormValue;
    /** Instance administrators may use reserved words. */
    staff: boolean;
    /** The organization's avatar, when it has one; absent for the instance. */
    image?: string | null;
    onSave: (value: NameTagFormValue) => Promise<{ error?: string } | null>;
}) {
    const t = useTranslations("badges");
    const [saved, setSaved] = useState(initial);
    const [value, setValue] = useState(initial);
    const [saving, setSaving] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const allowAvatar = image !== undefined;

    const schema = core.nameTagDefinitionSchema({
        instanceName: core.NAME_TAG_INSTANCE_NAME,
        staff,
        allowAvatar
    });
    const normalized = { ...value, text: core.normalizeNameTagText(value.text) };
    const checked = schema.safeParse(normalized);
    // An empty field is unfinished, not wrong: no message until something is typed.
    const textIssue =
        normalized.text === ""
            ? null
            : checked.success
              ? null
              : (checked.error.issues.find((issue) => issue.path[0] === "text")?.message ?? null);
    const dirty =
        normalized.text !== saved.text ||
        value.enabled !== saved.enabled ||
        value.emblem !== saved.emblem ||
        value.color !== saved.color;

    const change = (next: Partial<NameTagFormValue>) => {
        setDone(false);
        setServerError(null);
        setValue((current) => ({ ...current, ...next }));
    };

    const save = async () => {
        if (!checked.success || !dirty || saving) return;
        setSaving(true);
        const result = await onSave(checked.data).catch(() => ({ error: "invalid" }));
        setSaving(false);
        if (!result || result.error) {
            setServerError(nameTagErrorKey(result?.error));
            return;
        }
        setSaved(checked.data);
        setValue(checked.data);
        setDone(true);
    };

    const emblems: string[] = allowAvatar && image ? [...core.NAME_TAG_EMBLEMS, core.NAME_TAG_AVATAR] : [...core.NAME_TAG_EMBLEMS];
    const preview: core.NameTagView = {
        text: normalized.text || "TAG",
        emblem: value.emblem,
        color: value.color,
        orgId: null,
        image: image ?? null
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-muted-foreground text-xs">{intro}</p>
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("nameTags.editor.enabled")}</p>
                        <p className="text-muted-foreground text-xs">{t("nameTags.editor.enabledHint")}</p>
                    </div>
                    <Switch
                        checked={value.enabled}
                        onChange={(enabled) => change({ enabled })}
                        aria-label={t("nameTags.editor.enabled")}
                    />
                </div>

                <label className="flex flex-col gap-1">
                    <span className="text-sm font-medium">
                        {t("nameTags.editor.text")}
                        <span aria-hidden="true"> *</span>
                    </span>
                    <Input
                        value={value.text}
                        maxLength={core.NAME_TAG_MAX + 2}
                        onChange={(event) => change({ text: event.target.value })}
                        className="w-28 uppercase"
                        aria-invalid={textIssue !== null}
                        required
                    />
                    <span className={cn("text-xs", textIssue ? "text-danger-ink" : "text-muted-foreground")}>
                        {textIssue ? t(`nameTags.errors.${nameTagErrorKey(textIssue)}`) : t("nameTags.editor.textHint")}
                    </span>
                </label>

                <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 text-sm font-medium">{t("nameTags.editor.emblem")}</legend>
                    <div role="radiogroup" className="flex flex-wrap gap-1.5">
                        {emblems.map((emblem) => {
                            const label =
                                emblem === core.NAME_TAG_AVATAR
                                    ? t("nameTags.editor.avatar")
                                    : t(`nameTags.emblems.${emblem as core.NameTagEmblem}`);
                            return (
                                <button
                                    key={emblem}
                                    type="button"
                                    role="radio"
                                    aria-checked={value.emblem === emblem}
                                    aria-label={label}
                                    title={label}
                                    onClick={() => change({ emblem })}
                                    className={cn(
                                        "border-border hover:border-border-strong flex size-8 items-center justify-center rounded-md border",
                                        value.emblem === emblem && "border-primary ring-primary ring-1"
                                    )}
                                >
                                    <NameTagEmblemMark emblem={emblem} color={value.color} image={image} className="size-4" />
                                </button>
                            );
                        })}
                    </div>
                </fieldset>

                <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 text-sm font-medium">{t("nameTags.editor.color")}</legend>
                    <div role="radiogroup" className="flex flex-wrap gap-1.5">
                        {core.NAME_TAG_COLORS.map((color) => (
                            <button
                                key={color}
                                type="button"
                                role="radio"
                                aria-checked={value.color === color}
                                aria-label={t(`nameTags.colors.${color}`)}
                                title={t(`nameTags.colors.${color}`)}
                                onClick={() => change({ color })}
                                className="border-border flex size-7 items-center justify-center rounded-full border"
                                style={{ background: NAME_TAG_HEX[color] }}
                            >
                                {value.color === color && <Check className="size-3.5 shrink-0 text-white" />}
                            </button>
                        ))}
                    </div>
                </fieldset>

                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-muted-foreground flex items-center gap-2 text-xs">
                        {t("nameTags.editor.preview")}
                        <NameTagLabel tag={preview} />
                    </span>
                    <div className="flex items-center gap-2">
                        {done && <span className="text-muted-foreground text-xs">{t("nameTags.editor.saved")}</span>}
                        <Button
                            size="sm"
                            onClick={save}
                            disabled={saving || !dirty}
                            aria-disabled={!checked.success}
                        >
                            {t("nameTags.editor.save")}
                        </Button>
                    </div>
                </div>
                {serverError && (
                    <p role="alert" className="bg-danger-soft text-danger-ink rounded-md px-3 py-2 text-sm">
                        {t(`nameTags.errors.${serverError as ErrorKey}`)}
                    </p>
                )}
            </CardBody>
        </Card>
    );
}
