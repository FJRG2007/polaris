"use client";

/**
 * Skills on Polar's settings: the person's own skills, each with its switch,
 * edit and delete, and the built-in catalog to try or add from. Try opens a
 * temporary chat with the skill attached and nothing saved; a draft from the
 * editor travels there through this tab's session storage and is checked by
 * the server again on every turn.
 *
 * Every change is optimistic and put back when the server refuses it.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    Textarea
} from "@polaris/ui";
import { SKILL_CATALOG } from "@/lib/polar/skills/catalog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    SKILL_DESCRIPTION_MAX,
    SKILL_INSTRUCTIONS_MAX,
    SKILL_NAME_MAX,
    TRIAL_SKILL_KEY,
    skillFieldError,
    skillInputSchema,
    type SkillInput,
    type SkillView,
    type TrialSkill
} from "@/lib/polar/skills/shared";
import {
    addTrialSkillAction,
    deleteSkillAction,
    saveSkillAction,
    setSkillEnabledAction
} from "./skills-actions";

/** A list this long is easier to search than to scroll. */
const SEARCH_FROM = 6;

/** Opens a temporary chat that tries `trial`. */
export function trySkillHref(trial: TrialSkill): string {
    if ("catalog" in trial) return `/polar?new=1&skill=${encodeURIComponent(trial.catalog)}`;
    try {
        window.sessionStorage.setItem(TRIAL_SKILL_KEY, JSON.stringify(trial.draft));
    } catch {
        // No storage: the chat opens without the draft and says nothing is tried.
    }
    return "/polar?new=1&skill=draft";
}

export function PolarSkills({ initial, readOnly }: { initial: SkillView[]; readOnly: boolean }) {
    const t = useTranslations("polar");
    const router = useRouter();
    const [rows, setRows] = useState(initial);
    const [query, setQuery] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<SkillView | "new" | null>(null);
    const [removing, setRemoving] = useState<SkillView | null>(null);
    const [adding, setAdding] = useState<string | null>(null);

    const wanted = rows.length > SEARCH_FROM ? query.trim().toLowerCase() : "";
    const shown = rows.filter(
        (row) =>
            row.name.includes(wanted) || row.description.toLowerCase().includes(wanted)
    );
    const held = new Set(rows.map((row) => row.source));
    const heldNames = new Set(rows.map((row) => row.name));

    async function toggle(row: SkillView, enabled: boolean) {
        setError(null);
        setRows((current) => current.map((entry) => (entry.id === row.id ? { ...entry, enabled } : entry)));
        const answer = await setSkillEnabledAction({ id: row.id, enabled });
        if (!answer.ok) {
            setRows((current) => current.map((entry) => (entry.id === row.id ? row : entry)));
            setError(answer.error);
        }
    }

    async function remove(row: SkillView) {
        setError(null);
        setRemoving(null);
        setRows((current) => current.filter((entry) => entry.id !== row.id));
        const answer = await deleteSkillAction({ id: row.id });
        if (!answer.ok) {
            setRows((current) => [...current, row]);
            setError(answer.error);
        }
    }

    async function addFromCatalog(id: string) {
        setError(null);
        setAdding(id);
        const answer = await addTrialSkillAction({ catalog: id });
        setAdding(null);
        if (answer.ok) setRows((current) => [...current, answer.value]);
        else setError(answer.error);
    }

    return (
        <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-semibold">{t("settings.skills.title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("settings.skills.intro")}</p>
                    </div>
                    {!readOnly ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => setEditing("new")}
                        >
                            <Plus className="h-3.5 w-3.5 shrink-0" />
                            {t("settings.skills.create")}
                        </Button>
                    ) : null}
                </div>
                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : null}
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("settings.skills.mine")}
                </h3>
                {rows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("settings.skills.empty")}</p>
                ) : null}
                {rows.length > SEARCH_FROM ? (
                    <Input
                        type="search"
                        value={query}
                        aria-label={t("settings.skills.search")}
                        placeholder={t("settings.skills.search")}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                ) : null}
                {rows.length > 0 && shown.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("settings.skills.noMatch")}</p>
                ) : null}
                {shown.length > 0 ? (
                    <Card>
                        <CardBody className="flex flex-col divide-y divide-border p-0">
                            {shown.map((row) => (
                                <div key={row.id} className="flex items-center gap-3 px-4 py-3">
                                    <div className="min-w-0 flex-1">
                                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                            <span className="truncate font-mono" title={row.name}>
                                                {row.name}
                                            </span>
                                            {row.source !== "custom" ? (
                                                <Badge variant="neutral" className="shrink-0">
                                                    {t("settings.skills.fromCatalog")}
                                                </Badge>
                                            ) : null}
                                        </p>
                                        <p
                                            className="line-clamp-2 text-xs text-muted-foreground"
                                            title={row.description}
                                        >
                                            {row.description}
                                        </p>
                                    </div>
                                    {!readOnly ? (
                                        <>
                                            <Button
                                                type="button"
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={t("settings.skills.edit")}
                                                title={t("settings.skills.edit")}
                                                onClick={() => setEditing(row)}
                                            >
                                                <Pencil className="size-4 shrink-0" />
                                            </Button>
                                            <Button
                                                type="button"
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={t("settings.skills.delete")}
                                                title={t("settings.skills.delete")}
                                                onClick={() => setRemoving(row)}
                                            >
                                                <Trash2 className="size-4 shrink-0" />
                                            </Button>
                                        </>
                                    ) : null}
                                    <Switch
                                        checked={row.enabled}
                                        disabled={readOnly}
                                        aria-label={t("settings.skills.use")}
                                        onChange={(enabled) => void toggle(row, enabled)}
                                    />
                                </div>
                            ))}
                        </CardBody>
                    </Card>
                ) : null}
            </div>

            <div className="flex flex-col gap-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t("settings.skills.catalogTitle")}
                </h3>
                <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {SKILL_CATALOG.map((skill) => {
                        const added = held.has(skill.id) || heldNames.has(skill.name);
                        return (
                            <li key={skill.id} className="min-w-0">
                                <Card className="h-full">
                                    <CardBody className="flex h-full flex-col gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">
                                                {t(`settings.skills.catalog.${skill.id}.title` as never)}
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {t(`settings.skills.catalog.${skill.id}.description` as never)}
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Button
                                                type="button"
                                                size="sm"
                                                variant="outline"
                                                onClick={() =>
                                                    router.push(trySkillHref({ catalog: skill.id }))
                                                }
                                            >
                                                <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                                                {t("settings.skills.try")}
                                            </Button>
                                            {added ? (
                                                <Badge variant="success">
                                                    {t("settings.skills.added")}
                                                </Badge>
                                            ) : !readOnly ? (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    disabled={adding === skill.id}
                                                    onClick={() => void addFromCatalog(skill.id)}
                                                >
                                                    <Plus className="h-3.5 w-3.5 shrink-0" />
                                                    {t("settings.skills.add")}
                                                </Button>
                                            ) : null}
                                        </div>
                                    </CardBody>
                                </Card>
                            </li>
                        );
                    })}
                </ul>
            </div>

            <SkillEditor
                editing={editing}
                onClose={() => setEditing(null)}
                onTry={(draft) => router.push(trySkillHref({ draft }))}
                onSaved={(view) => {
                    setError(null);
                    setRows((current) =>
                        current.some((row) => row.id === view.id)
                            ? current.map((row) => (row.id === view.id ? view : row))
                            : [...current, view]
                    );
                    setEditing(null);
                }}
            />
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(next) => !next && setRemoving(null)}
                name={removing?.name ?? ""}
                kind={t("settings.skills.kind")}
                description={t("settings.skills.removeHint")}
                onConfirm={() => removing && void remove(removing)}
            />
        </section>
    );
}

const EMPTY: SkillInput = { name: "", description: "", instructions: "" };

function SkillEditor({
    editing,
    onClose,
    onSaved,
    onTry
}: {
    editing: SkillView | "new" | null;
    onClose: () => void;
    onSaved: (view: SkillView) => void;
    onTry: (draft: SkillInput) => void;
}) {
    const t = useTranslations("polar");
    const open = editing !== null;
    const [values, setValues] = useState<SkillInput>(EMPTY);
    const [loadedFor, setLoadedFor] = useState<SkillView | "new" | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // The form starts from the skill it was opened for, once per opening.
    if (editing !== loadedFor) {
        setLoadedFor(editing);
        setError(null);
        setValues(
            editing && editing !== "new"
                ? {
                      name: editing.name,
                      description: editing.description,
                      instructions: editing.instructions
                  }
                : EMPTY
        );
    }

    const checked = skillInputSchema.safeParse(values);
    const unchanged =
        editing !== null &&
        editing !== "new" &&
        values.name === editing.name &&
        values.description === editing.description &&
        values.instructions === editing.instructions;
    const complete = checked.success && !unchanged;
    const fieldError = (field: keyof SkillInput) => {
        const code = skillFieldError(field, values[field]);
        return code ? t(`settings.skills.errors.${code}`) : null;
    };
    const set = (field: keyof SkillInput) => (value: string) =>
        setValues((current) => ({ ...current, [field]: value }));

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!complete || pending || !checked.success) return;
        setPending(true);
        setError(null);
        const answer = await saveSkillAction({
            id: editing && editing !== "new" ? editing.id : null,
            skill: checked.data
        });
        setPending(false);
        if (answer.ok) onSaved(answer.value);
        else setError(answer.error);
    }

    const fields: {
        key: keyof SkillInput;
        label: string;
        hint: string;
        max: number;
        multiline: boolean;
    }[] = [
        {
            key: "name",
            label: t("settings.skills.editor.name"),
            hint: t("settings.skills.editor.nameHint"),
            max: SKILL_NAME_MAX,
            multiline: false
        },
        {
            key: "description",
            label: t("settings.skills.editor.description"),
            hint: t("settings.skills.editor.descriptionHint"),
            max: SKILL_DESCRIPTION_MAX,
            multiline: false
        },
        {
            key: "instructions",
            label: t("settings.skills.editor.instructions"),
            hint: t("settings.skills.editor.instructionsHint"),
            max: SKILL_INSTRUCTIONS_MAX,
            multiline: true
        }
    ];

    return (
        <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>
                        {editing === "new"
                            ? t("settings.skills.editor.titleNew")
                            : t("settings.skills.editor.titleEdit")}
                    </DialogTitle>
                    <DialogDescription>{t("settings.skills.editor.body")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)}>
                    {fields.map((field) => {
                        const problem = fieldError(field.key);
                        const id = `skill-${field.key}`;
                        return (
                            <div key={field.key} className="flex flex-col gap-1 text-sm">
                                <label htmlFor={id}>{field.label} *</label>
                                {field.multiline ? (
                                    <Textarea
                                        id={id}
                                        rows={10}
                                        value={values[field.key]}
                                        maxLength={field.max}
                                        aria-invalid={problem ? true : undefined}
                                        onChange={(event) => set(field.key)(event.target.value)}
                                        className="font-mono text-xs"
                                    />
                                ) : (
                                    <Input
                                        id={id}
                                        value={values[field.key]}
                                        maxLength={field.max}
                                        autoFocus={field.key === "name"}
                                        aria-invalid={problem ? true : undefined}
                                        onChange={(event) => set(field.key)(event.target.value)}
                                    />
                                )}
                                <span
                                    className={
                                        problem ? "text-xs text-danger" : "text-xs text-muted-foreground"
                                    }
                                >
                                    {problem ?? field.hint}
                                </span>
                            </div>
                        );
                    })}
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                            {t("settings.skills.cancel")}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            aria-disabled={!checked.success}
                            onClick={() => checked.success && onTry(checked.data)}
                        >
                            <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                            {t("settings.skills.try")}
                        </Button>
                        <Button type="submit" aria-disabled={!complete || pending} disabled={pending}>
                            {t("settings.skills.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
