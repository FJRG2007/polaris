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
import {
    RETENTION_DAYS,
    RETENTION_LABELS,
    RETENTION_SUBJECTS,
    RETENTION_SUBJECT_LABELS,
    RETENTION_SUBJECT_NOTES,
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
        setNote("Saved. The next pass will apply it.");
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
                ? "Nothing was due."
                : result.more
                  ? `Removed ${grouped(removed)} records. There is more to go - the schedule will keep taking it.`
                  : `Removed ${grouped(removed)} records. Nothing else is due.`
        );
    };

    return (
        <div className="flex flex-col gap-4">
            {RETENTION_SUBJECTS.map((subject) => {
                const counts = totals[subject];
                const keeping = policy[subject];
                return (
                    <Card key={subject}>
                        <CardBody className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <h2 className="text-sm font-medium">
                                        {RETENTION_SUBJECT_LABELS[subject]}
                                    </h2>
                                    <p className="text-muted-foreground text-xs">
                                        {RETENTION_SUBJECT_NOTES[subject]}
                                    </p>
                                </div>
                                <Select
                                    aria-label={`How long to keep ${RETENTION_SUBJECT_LABELS[subject]}`}
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
                                        label: RETENTION_LABELS[days]
                                    }))}
                                />
                            </div>

                            {/* What is in there now, against what is saved rather
                                than against what is on the selector - so the
                                number does not change while somebody is deciding. */}
                            <p className="text-muted-foreground border-t border-border pt-3 text-xs">
                                {grouped(counts.total)}{" "}
                                {counts.total === 1 ? "record" : "records"} kept.{" "}
                                {keeping === 0 ? (
                                    <>Nothing is ever removed.</>
                                ) : counts.due === 0 ? (
                                    <>None of them is older than {RETENTION_LABELS[keeping].toLowerCase()}.</>
                                ) : (
                                    <>
                                        {grouped(counts.due)} older than{" "}
                                        {RETENTION_LABELS[keeping].toLowerCase()}, waiting for the next
                                        pass.
                                    </>
                                )}
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
                    Save
                </Button>
                {/* For the operator who has just shortened a period and wants to
                    watch the number move, rather than wait an hour to find out
                    whether it worked. */}
                <Button
                    size="sm"
                    variant="outline"
                    disabled={sweeping || changed}
                    title={changed ? "Save first, so the pass uses what you chose" : undefined}
                    onClick={() => void sweepNow()}
                >
                    {sweeping ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Trash2 className="size-4" />
                    )}
                    Run a pass now
                </Button>
                <p className="text-muted-foreground text-xs">
                    A pass runs on its own every hour and takes a bounded bite, so a deployment with
                    years of history catches up over several rather than in one long lock.
                </p>
            </div>
        </div>
    );
}
