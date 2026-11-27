"use client";

/**
 * Making and unmaking labels.
 *
 * Deleting one takes away the label and nothing else - the mail it was on is
 * untouched, because a label is something added here rather than something the
 * mail server knows about. The screen says so, since "delete label" reads like
 * "delete the mail in it" to anybody who has used a client where folders and
 * labels are the same thing.
 */

import { useState, type FormEvent } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { useRouter } from "next/navigation";
import { Plus, Tag, Trash2 } from "lucide-react";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailLabelView } from "@/lib/mailbox/labels";
import {
    Button,
    cn,
    ColorPicker,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    settingType,
    useToast
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createLabelAction, deleteLabelAction } from "@/app/(app)/mail/actions";

/** What a new label is coloured until somebody changes it. */
const DEFAULT_COLOR = "#6366f1";

export function LabelsView({ labels }: { labels: MailLabelView[] }) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [adding, setAdding] = useState(false);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-[13px] font-medium">{t("nav.labels")}</h2>
                    <p className={settingType.hint}>{t("labels.hint")}</p>
                </div>
                <Button size="sm" onClick={() => setAdding(true)}>
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("labels.addLabel")}
                </Button>
            </div>

            {labels.length === 0 ? (
                <p className={cn(settingType.body, "rounded-md border border-dashed border-border px-4 py-6 text-center text-muted-foreground")}>
                    {t("labels.empty")}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                    <table className={cn(settingType.body, "w-full")}>
                        <thead className={cn(settingType.small, "bg-surface/60 text-start text-muted-foreground")}>
                            <tr>
                                <th scope="col" className="w-full max-w-0 px-3 py-2 text-start font-medium">
                                    {t("labels.columns.name")}
                                </th>
                                <th scope="col" className="hidden px-3 py-2 text-start font-medium sm:table-cell">
                                    {t("labels.columns.messages")}
                                </th>
                                <th scope="col" className="px-3 py-2">
                                    <span className="sr-only">{t("labels.columns.actions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {labels.map((label) => (
                                <tr key={label.id} className="border-t border-border">
                                    <td className="max-w-0 px-3 py-2 align-middle">
                                        <span className="flex min-w-0 items-center gap-2">
                                            <Tag className="size-4 shrink-0" style={{ color: label.color }} aria-hidden />
                                            <span className={cn(settingType.body, "min-w-0 truncate")} title={label.name}>
                                                {label.name}
                                            </span>
                                        </span>
                                    </td>
                                    <td className={cn(settingType.hint, "hidden whitespace-nowrap px-3 py-2 align-middle sm:table-cell")}>
                                        {t("labels.count", { count: label.count })}
                                    </td>
                                    <td className="px-3 py-2 align-middle">
                                        <span className="flex justify-end">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("labels.deleteNamed", { name: label.name })}
                                                title={t("labels.deleteHint", { name: label.name })}
                                                onClick={() =>
                                                    void (async () => {
                                                        await deleteLabelAction(label.id);
                                                        toast.show({ title: t("labels.deleted", { name: label.name }) });
                                                        router.refresh();
                                                    })()
                                                }
                                            >
                                                <Trash2 className="size-4 shrink-0" aria-hidden />
                                            </Button>
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            <AddLabelDialog open={adding} onOpenChange={setAdding} />
        </div>
    );
}

/** The name and colour of a new label, in a dialog opened from the header. */
function AddLabelDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [name, setName] = useState("");
    const [color, setColor] = useState(DEFAULT_COLOR);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useBusy();
    const ready = name.trim().length > 0 && !saving;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!ready) return;
        startSaving(async () => {
            const answer = await createLabelAction({ name, color });
            const said = refusalOf(answer);
            if (said) {
                setProblem(said);
                return;
            }
            setName("");
            setColor(DEFAULT_COLOR);
            onOpenChange(false);
            toast.show({ title: t("labels.made") });
            router.refresh();
        });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("labels.addTitle")}</DialogTitle>
                    <DialogDescription>{t("labels.addDescription")}</DialogDescription>
                </DialogHeader>
                <form className="flex flex-col gap-3" onSubmit={submit}>
                    <div className="flex items-end gap-2">
                        <label className="block min-w-0 flex-1">
                            <span className={cn(settingType.hint, "mb-1 block")}>
                                {t("labels.name")} <span aria-hidden>*</span>
                            </span>
                            <Input
                                value={name}
                                autoFocus
                                required
                                placeholder={t("labels.placeholder")}
                                onChange={(event) => {
                                    setName(event.target.value);
                                    setProblem("");
                                }}
                            />
                        </label>
                        <ColorPicker value={color} onChange={setColor} aria-label={t("labels.colour")} />
                    </div>
                    {problem ? (
                        <p className={settingType.error} role="alert">
                            {problem}
                        </p>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" disabled={saving} onClick={() => onOpenChange(false)}>
                            {t("labels.cancel")}
                        </Button>
                        <Button type="submit" aria-disabled={!ready} disabled={saving} aria-busy={saving}>
                            {t("labels.make")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
