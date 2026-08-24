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
                    <DialogTitle>Report this account</DialogTitle>
                    <DialogDescription>
                        {sent
                            ? "It has gone to whoever administers this Polaris. They decide what happens next."
                            : "This goes to whoever administers this Polaris. Reporting somebody does not block them - that is yours to do separately, and it works straight away."}
                    </DialogDescription>
                </DialogHeader>

                {sent ? (
                    <BlockAfterReport person={person} />
                ) : (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            What is wrong
                            <Select
                                value={reason}
                                aria-label="Why you are reporting them"
                                onValueChange={(value) => setReason(value as core.UserReportReason)}
                                options={core.USER_REPORT_REASONS.map((value) => ({
                                    value,
                                    label: core.USER_REPORT_REASON_LABELS[value]
                                }))}
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            What happened
                            <Textarea
                                rows={4}
                                value={note}
                                maxLength={core.MAX_REPORT_NOTE}
                                placeholder="Optional, and the most useful part. Where it happened and roughly when."
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
                        {sent ? "Done" : "Cancel"}
                    </Button>
                    {sent ? null : (
                        <Button variant="danger" disabled={busy} onClick={() => void send()}>
                            {busy && <Loader2 className="size-4 animate-spin" />}
                            Report
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
