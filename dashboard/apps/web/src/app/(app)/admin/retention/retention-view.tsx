"use client";

/**
 * The three periods, with what is actually in each table beside them.
 *
 * A period on its own is a number nobody can judge. "30 days" means something
 * once it sits next to "412,000 notifications, 380,000 of them older than that",
 * and that second line is the whole reason this screen is worth opening: it says
 * what the setting is about to do before it is saved.
 *
 * The counts are the ones the page arrived with, so they describe the period that
 * is saved rather than the one being considered. Said as much, rather than
 * recomputed as the selector moves: a number that changed as somebody scrolled a
 * menu would look like rows disappearing while they decided.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { grouped } from "@/app/(app)/apps/firewall/page-parts";
import { Loader2, Trash2 } from "lucide-react";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { saveRetentionAction, sweepRetentionAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    RETENTION_DAYS,
    RETENTION_SUBJECTS,
    type RetentionDays,
    type RetentionPolicy,
    type RetentionSubject
} from "@polaris/core";

export function RetentionView({
    policy,
    totals
}: {
    policy: RetentionPolicy;
    totals: Record<RetentionSubject, { total: number; due: number }>;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [draft, setDraft] = useState<RetentionPolicy>(policy);
    const [busy, setBusy] = useState(false);
    const [sweeping, setSweeping] = useState(false);
    const [error, setError] = useState("");
    const [note, setNote] = useState("");

    const changed = RETENTION_SUBJECTS.some((subject) => draft[subject] !== policy[subject]);

    const save = async () => {
        setBusy(true);
        setError("");
        setNote("");
        const result = await runAction(() => saveRetentionAction(draft), setError);
        setBusy(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        setNote(t("retention.saved"));
    };

    const sweepNow = async () => {
        setSweeping(true);
        setError("");
        setNote("");
        const result = await runAction(() => sweepRetentionAction(), setError);
        setSweeping(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return;
        }
        const removed = result.removed ?? 0;
        setNote(
            removed === 0
                ? t("retention.sweep.nothingDue")
                : result.more
                  ? t("retention.sweep.removedMore", { count: removed, removed: grouped(removed) })
                  : t("retention.sweep.removed", { count: removed, removed: grouped(removed) })
        );
    };

    return (
        <div className="flex flex-col gap-4">
            {RETENTION_SUBJECTS.map((subject) => {
                const counts = totals[subject];
                const keeping = policy[subject];
                const label = t(`retention.subjects.${subject}.label`);
                const record = { count: counts.total, total: grouped(counts.total) };
                return (
                    <Card key={subject}>
                        <CardBody className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <h2 className="text-sm font-medium">{label}</h2>
                                    <p className="text-muted-foreground text-xs">
                                        {t(`retention.subjects.${subject}.note`)}
                                    </p>
                                </div>
                                <Select
                                    aria-label={t("retention.howLong", { subject: label })}
                                    className="w-40 shrink-0"
                                    value={String(draft[subject])}
                                    onValueChange={(next) =>
                                        setDraft({
                                            ...draft,
                                            [subject]: Number(next) as RetentionDays
                                        })
                                    }
                                    options={RETENTION_DAYS.map((days) => ({
                                        value: String(days),
                                        label: t(`retention.periods.d${days}`)
                                    }))}
                                />
                            </div>

                            {/* What is in there now, against what is saved rather
                                than against what is on the selector - so the
                                number does not change while somebody is deciding. */}
                            <p className="text-muted-foreground border-t border-border pt-3 text-xs">
                                {keeping === 0
                                    ? t("retention.counts.forever", record)
                                    : counts.due === 0
                                      ? t("retention.counts.noneDue", {
                                            ...record,
                                            period: t(`retention.periodsInline.d${keeping}`)
                                        })
                                      : t("retention.counts.due", {
                                            ...record,
                                            due: grouped(counts.due),
                                            period: t(`retention.periodsInline.d${keeping}`)
                                        })}
                            </p>
                        </CardBody>
                    </Card>
                );
            })}

            {error ? <p className="text-danger text-sm">{error}</p> : null}
            {note ? <p className="text-muted-foreground text-sm">{note}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" disabled={busy || !changed} onClick={() => void save()}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {tc("actions.save")}
                </Button>
                {/* For the operator who has just shortened a period and wants to
                    watch the number move, rather than wait an hour to find out
                    whether it worked. */}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={sweeping || changed}
                    title={changed ? t("retention.sweep.saveFirst") : undefined}
                    onClick={() => void sweepNow()}
                >
                    {sweeping ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Trash2 className="size-4" />
                    )}
                    {t("retention.sweep.run")}
                </Button>
                <p className="text-muted-foreground text-xs">{t("retention.sweep.hint")}</p>
            </div>
        </div>
    );
}
