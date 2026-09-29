"use client";

/**
 * Reporting a person, rather than one thing they said.
 *
 * The message queue answers "was this message all right". This answers the other
 * question people actually have, which is about a pattern: somebody who is fine
 * in any one message and not fine over forty of them. Reporting each of the forty
 * is not the same report and does not read as one.
 *
 * It goes to the same place, and deliberately says so: a report nobody can see
 * the fate of is a report that stops being made.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { BlockAfterReport } from "@/components/block-after-report";
import { reportPersonAction } from "@/app/(app)/account/report-actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Textarea
} from "@polaris/ui";

export function ReportPersonDialog({
    open,
    person,
    onOpenChange,
    onReported
}: {
    open: boolean;
    person: { id: string; name: string };
    onOpenChange: (open: boolean) => void;
    onReported?: () => void;
}) {
    const [reason, setReason] = useState<core.UserReportReason>("abuse");
    const [note, setNote] = useState("");
    const t = useTranslations("components");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sent, setSent] = useState(false);

    async function send(): Promise<void> {
        setBusy(true);
        setError(null);
        const result = await runAction(
            () => reportPersonAction({ subjectId: person.id, reason, note }),
            setError
        );
        setBusy(false);
        if (!result || result.error) return;
        setSent(true);
        onReported?.();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setNote("");
                    setError(null);
                    setSent(false);
                }
            }}
        >
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("report.title")}</DialogTitle>
                    <DialogDescription>
                        {sent
                            ? t("report.sent")
                            : t("report.intro")}
                    </DialogDescription>
                </DialogHeader>

                {sent ? (
                    <BlockAfterReport person={person} />
                ) : (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {t("report.what")}
                            <Select
                                value={reason}
                                aria-label={t("report.why")}
                                onValueChange={(value) => setReason(value as core.UserReportReason)}
                                options={core.USER_REPORT_REASONS.map((value) => ({
                                    value,
                                    label: t(`report.reasons.${value}`)
                                }))}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            {t("report.happened")}
                            <Textarea
                                rows={4}
                                value={note}
                                maxLength={core.MAX_REPORT_NOTE}
                                placeholder={t("report.notePlaceholder")}
                                onChange={(event) => setNote(event.target.value)}
                            />
                        </label>
                        {error ? (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        ) : null}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant={sent ? "primary" : "ghost"}
                        onClick={() => onOpenChange(false)}
                    >
                        {sent ? t("report.done") : t("ui.cancel")}
                    </Button>
                    {sent ? null : (
                        <Button variant="danger" disabled={busy} onClick={() => void send()}>
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            {t("report.report")}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
