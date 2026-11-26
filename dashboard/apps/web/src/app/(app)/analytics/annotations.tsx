"use client";

/**
 * The notes pinned to the traffic chart, under it: each one with its moment,
 * removable by an editor, and a button that adds another in a dialog.
 */

import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { useConfirm } from "@/components/confirm-dialog";
import type { AnnotationView } from "@/lib/analytics-annotations";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { AnalyticsSiteView } from "@/lib/analytics-service";
import { createAnnotationAction, deleteAnnotationAction } from "./actions";

/** `datetime-local` wants the reader's own wall clock, without a zone. */
function localInput(at: number): string {
    const date = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
    return date.toISOString().slice(0, 16);
}

export function Annotations({
    site,
    notes,
    canEdit,
    onChange
}: {
    site: AnalyticsSiteView;
    notes: readonly AnnotationView[];
    canEdit: boolean;
    /** Ask for the overview again, so the chart and the list agree with the server. */
    onChange: () => void;
}) {
    const t = useTranslations("analytics");
    const format = useDisplayFormat();
    const [confirm, confirmDialog] = useConfirm();
    const [adding, setAdding] = useState(false);
    const [when, setWhen] = useState(() => localInput(Date.now()));
    const [text, setText] = useState("");
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const scope = { scopeType: site.scopeType, scopeId: site.scopeId };
    const at = Date.parse(when);
    const ready = text.trim().length > 0 && text.trim().length <= 200 && Number.isFinite(at);

    function add() {
        if (!ready) return;
        startTransition(async () => {
            const result = await createAnnotationAction({ ...scope, annotation: { at, text } });
            if (result.error) {
                setFailure(result.error);
                return;
            }
            setFailure(null);
            setText("");
            setAdding(false);
            onChange();
        });
    }

    async function remove(note: AnnotationView) {
        const ok = await confirm({
            title: t("annotations.deleteTitle"),
            description: note.text,
            confirmLabel: t("annotations.delete"),
            danger: true
        });
        if (!ok) return;
        // Gone from the list at once; back again only if the server says no.
        setHidden((current) => new Set(current).add(note.id));
        const result = await deleteAnnotationAction({ ...scope, id: note.id });
        if (result.error) {
            setFailure(result.error);
            setHidden((current) => {
                const next = new Set(current);
                next.delete(note.id);
                return next;
            });
            return;
        }
        onChange();
    }

    const shown = notes.filter((note) => !hidden.has(note.id));
    if (shown.length === 0 && !canEdit) return null;

    return (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
            {confirmDialog}
            {shown.length > 0 ? (
                <ul className="flex min-w-0 flex-wrap gap-2" aria-label={t("annotations.title")}>
                    {shown.map((note) => (
                        <li
                            key={note.id}
                            className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-warning-edge bg-warning-soft px-2 py-1 text-xs"
                        >
                            <span className="shrink-0 text-muted-foreground">{format.dateTime(note.at)}</span>
                            <span className="min-w-0 truncate" title={note.text}>
                                {note.text}
                            </span>
                            {canEdit ? (
                                <button
                                    type="button"
                                    className="shrink-0 text-muted-foreground hover:text-foreground"
                                    aria-label={t("annotations.delete")}
                                    onClick={() => void remove(note)}
                                >
                                    <X className="size-3.5" aria-hidden />
                                </button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
            {canEdit ? (
                <div>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(true)}>
                        <Plus className="size-3.5" aria-hidden /> {t("annotations.new")}
                    </Button>
                </div>
            ) : null}
            <Dialog open={canEdit && adding} onOpenChange={(open) => !pending && setAdding(open)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t("annotations.addTitle")}</DialogTitle>
                        <DialogDescription>{t("annotations.addDescription")}</DialogDescription>
                    </DialogHeader>
                    <form
                        className="flex min-w-0 flex-col gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            add();
                        }}
                    >
                        <Input
                            type="datetime-local"
                            value={when}
                            aria-label={t("annotations.when")}
                            onChange={(event) => setWhen(event.target.value)}
                        />
                        <Input
                            value={text}
                            maxLength={200}
                            autoFocus
                            aria-label={t("annotations.text")}
                            placeholder={t("annotations.placeholder")}
                            onChange={(event) => setText(event.target.value)}
                        />
                        {failure ? <p className="text-xs text-danger">{failure}</p> : null}
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
                                {t("annotations.cancel")}
                            </Button>
                            <Button type="submit" aria-disabled={!ready} disabled={pending} aria-busy={pending}>
                                {t("annotations.add")}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
            {failure && !adding ? <p className="text-xs text-danger">{failure}</p> : null}
        </div>
    );
}
