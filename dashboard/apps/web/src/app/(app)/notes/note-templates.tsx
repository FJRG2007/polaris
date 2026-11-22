"use client";

/**
 * Note templates on screen: choosing one before a note is written, saving the
 * open note as one, and keeping a notebook's list in order.
 *
 * The picker opens only on a shelf that has templates - a shelf without any
 * makes a blank note at once, as it always did - and preselects the shelf's
 * default, so the common case stays one click.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { FileText, Star, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NoteTemplateSummary } from "@/lib/notes/template-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

/** Blank, as the picker keys it. */
const BLANK = "";

/**
 * Pick what a new note starts from. `onPick` receives the template id, or null
 * for a blank note.
 */
export function TemplatePickerDialog({
    open,
    onOpenChange,
    templates,
    onPick
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    templates: readonly NoteTemplateSummary[];
    onPick: (templateId: string | null) => Promise<void>;
}) {
    const t = useTranslations("notes");
    const [chosen, setChosen] = useState(BLANK);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) setChosen(templates.find((template) => template.isDefault)?.id ?? BLANK);
    }, [open, templates]);

    const options = [
        { id: BLANK, name: t("templates.blank") },
        ...templates.map((template) => ({ id: template.id, name: template.name }))
    ];

    const confirm = async () => {
        setBusy(true);
        await onPick(chosen || null);
        setBusy(false);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("templates.pickTitle")}</DialogTitle>
                    <DialogDescription>{t("templates.pickDescription")}</DialogDescription>
                </DialogHeader>
                <div role="radiogroup" aria-label={t("templates.pickTitle")} className="flex flex-col gap-1">
                    {options.map((option) => (
                        <button
                            key={option.id || "blank"}
                            type="button"
                            role="radio"
                            aria-checked={chosen === option.id}
                            onClick={() => setChosen(option.id)}
                            onDoubleClick={() => {
                                setChosen(option.id);
                                void onPick(option.id || null);
                            }}
                            className={`flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-start text-sm ${
                                chosen === option.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"
                            }`}
                        >
                            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0 flex-1 truncate" title={option.name}>
                                {option.name}
                            </span>
                            {templates.find((template) => template.id === option.id)?.isDefault && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t("templates.default")}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("templates.cancel")}
                    </Button>
                    <Button onClick={() => void confirm()} disabled={busy}>
                        {t("templates.create")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** "Use this note as a template": asks for a name, prefilled with the title. */
export function SaveAsTemplateDialog({
    open,
    onOpenChange,
    noteId,
    noteTitle
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    noteId: string;
    noteTitle: string;
}) {
    const t = useTranslations("notes");
    const router = useRouter();
    const [name, setName] = useState(noteTitle);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        if (open) {
            setName(noteTitle);
            setError("");
        }
    }, [open, noteTitle]);

    const save = async () => {
        setBusy(true);
        const result = await runAction(
            () => actions.templateFromNoteAction({ noteId, name: name.trim() }),
            setError
        );
        setBusy(false);
        if (result?.error) return;
        onOpenChange(false);
        router.refresh();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("templates.saveTitle")}</DialogTitle>
                    <DialogDescription>{t("templates.saveDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("templates.name")} <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            value={name}
                            autoFocus
                            maxLength={80}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && name.trim()) void save();
                            }}
                        />
                    </label>
                    {error && (
                        <p role="alert" className="text-sm text-danger-ink">
                            {error}
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        {t("templates.cancel")}
                    </Button>
                    <Button
                        onClick={() => void save()}
                        disabled={busy || !name.trim()}
                        aria-disabled={busy || !name.trim()}
                    >
                        {t("templates.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** A notebook's templates: rename, choose the default, delete. */
export function ManageTemplatesDialog({
    open,
    onOpenChange,
    templates,
    notebookName
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    templates: readonly NoteTemplateSummary[];
    notebookName: string;
}) {
    const t = useTranslations("notes");
    const router = useRouter();
    const [error, setError] = useState("");
    const [removing, setRemoving] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setError("");
            setRemoving(null);
        }
    }, [open]);

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error) router.refresh();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("templates.manageTitle", { name: notebookName })}</DialogTitle>
                    <DialogDescription>{t("templates.manageDescription")}</DialogDescription>
                </DialogHeader>
                {templates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("templates.empty")}</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {templates.map((template) => (
                            <li key={template.id} className="flex min-w-0 items-center gap-2">
                                <Input
                                    defaultValue={template.name}
                                    aria-label={t("templates.name")}
                                    maxLength={80}
                                    className="min-w-0 flex-1"
                                    onBlur={(event) => {
                                        const name = event.target.value.trim();
                                        if (name && name !== template.name)
                                            void act(() =>
                                                actions.updateTemplateAction({ templateId: template.id, name })
                                            );
                                        else event.target.value = template.name;
                                    }}
                                />
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-pressed={template.isDefault}
                                    aria-label={
                                        template.isDefault ? t("templates.unsetDefault") : t("templates.setDefault")
                                    }
                                    title={template.isDefault ? t("templates.unsetDefault") : t("templates.setDefault")}
                                    onClick={() =>
                                        void act(() =>
                                            actions.updateTemplateAction({
                                                templateId: template.id,
                                                isDefault: !template.isDefault
                                            })
                                        )
                                    }
                                >
                                    <Star
                                        className={`size-4 shrink-0 ${template.isDefault ? "fill-current text-warning" : ""}`}
                                    />
                                </Button>
                                {removing === template.id ? (
                                    <Button
                                        variant="danger"
                                        size="sm"
                                        className="shrink-0"
                                        onClick={() => {
                                            setRemoving(null);
                                            void act(() => actions.deleteTemplateAction(template.id));
                                        }}
                                    >
                                        {t("templates.confirmDelete")}
                                    </Button>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("templates.delete")}
                                        title={t("templates.delete")}
                                        onClick={() => setRemoving(template.id)}
                                    >
                                        <Trash2 className="size-4 shrink-0" />
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
                {error && (
                    <p role="alert" className="text-sm text-danger-ink">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)}>{t("templates.done")}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
