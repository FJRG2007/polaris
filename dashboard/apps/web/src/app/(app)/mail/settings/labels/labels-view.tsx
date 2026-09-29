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

import { useState } from "react";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { useRouter } from "next/navigation";
import { Plus, Tag, Trash2 } from "lucide-react";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { MailLabelView } from "@/lib/mailbox/labels";
import { Button, ColorPicker, Input, useToast } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { createLabelAction, deleteLabelAction } from "@/app/(app)/mail/actions";

/** What a new label is coloured until somebody changes it. */
const DEFAULT_COLOR = "#6366f1";

export function LabelsView({ labels }: { labels: MailLabelView[] }) {
    const router = useRouter();
    const toast = useToast();
    const t = useTranslations("mailSettings");
    const [name, setName] = useState("");
    const [color, setColor] = useState(DEFAULT_COLOR);
    const [problem, setProblem] = useState("");
    const [saving, startSaving] = useBusy();

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-[13px] font-medium">{t("nav.labels")}</h2>
                <p className="text-[12px] text-muted-foreground">{t("labels.hint")}</p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
                <label className="block">
                    <span className="mb-1 block text-[12px] text-muted-foreground">
                        {t("labels.name")} <span aria-hidden>*</span>
                    </span>
                    <Input
                        value={name}
                        placeholder={t("labels.placeholder")}
                        className="w-56"
                        onChange={(event) => {
                            setName(event.target.value);
                            setProblem("");
                        }}
                    />
                </label>
                <ColorPicker value={color} onChange={setColor} aria-label={t("labels.colour")} />
                <Button
                    disabled={saving || !name.trim()}
                    onClick={() =>
                        startSaving(async () => {
                            const answer = await createLabelAction({ name, color });
                            const said = refusalOf(answer);
                            if (said) {
                                setProblem(said);
                                return;
                            }
                            setName("");
                            setColor(DEFAULT_COLOR);
                            toast.show({ title: t("labels.made") });
                            router.refresh();
                        })
                    }
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    {t("labels.make")}
                </Button>
            </div>
            {problem ? <p className="text-[13px] text-danger">{problem}</p> : null}

            {labels.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground">
                    {t("labels.empty")}
                </p>
            ) : (
                <ul className="space-y-1">
                    {labels.map((label) => (
                        <li
                            key={label.id}
                            className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
                        >
                            <Tag className="size-4 shrink-0" style={{ color: label.color }} aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-[13px]" title={label.name}>
                                {label.name}
                            </span>
                            <span className="shrink-0 text-[12px] text-foreground-subtle">
                                {t("labels.count", { count: label.count })}
                            </span>
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
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
