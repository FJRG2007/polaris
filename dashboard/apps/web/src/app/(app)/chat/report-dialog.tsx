"use client";

/**
 * Saying something is wrong with a message.
 *
 * A reason and, optionally, a sentence. The reason is a short list because a
 * long one is a list nobody reads to the end of, and the sentence is optional
 * because making somebody write an essay is how a report does not get made.
 *
 * What comes back says the same thing whether it was the first report or the
 * fifth: pressing it twice updates the one report this person made rather than
 * stacking rows, and telling them "you already did" is telling them about
 * somebody else's queue.
 */

import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { BlockAfterReport } from "@/components/block-after-report";
import { reportMessageAction } from "./actions";
import type { ChatReportReason } from "@polaris/core";
import {
    CHAT_REPORT_LABELS,
    CHAT_REPORT_REASONS,
    MAX_CHAT_REPORT_NOTE,
    PLEASANTRY_REFUSAL,
    isPleasantry
} from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Select,
    Textarea,
    cn
} from "@polaris/ui";

export function ReportDialog({
    messageId,
    body = "",
    author = null,
    open,
    onOpenChange
}: {
    /** The message being reported, or null when nothing is. */
    messageId: string | null;
    /** What it said, so the dialog can say up front that there is nothing here
     *  to report. The server decides; this is the same rule, one step earlier,
     *  so nobody writes a note about a message that will be refused. */
    body?: string;
    /** Who wrote it, so blocking them is one press once the report has gone -
     *  the same moment, and the half that otherwise does not happen. Null where
     *  the account is not known, and then nothing is offered. */
    author?: { id: string; name: string } | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const nothingToReport = isPleasantry(body);
    const [reason, setReason] = useState<ChatReportReason>("spam");
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [sent, setSent] = useState(false);

    const send = async () => {
        if (!messageId) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => reportMessageAction({ messageId, reason, note }),
            setError
        );
        setBusy(false);
        if (!result || result.error) return;
        setSent(true);
    };

    const close = (next: boolean) => {
        onOpenChange(next);
        if (next) return;
        // Emptied on the way out rather than on the way in, so reopening it does
        // not flash the last reason before it clears.
        setSent(false);
        setNote("");
        setReason("spam");
        setError("");
    };

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Report this message</DialogTitle>
                    <DialogDescription>
                        {sent
                            ? "It has gone to whoever runs this instance. Nobody in the conversation is told."
                            : nothingToReport
                              ? "There is nothing here for a moderator to decide about."
                              : "It goes to whoever runs this instance. Nobody in the conversation is told you reported it."}
                    </DialogDescription>
                </DialogHeader>

                {sent && <BlockAfterReport person={author} />}

                {!sent && nothingToReport && (
                    <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                        {PLEASANTRY_REFUSAL}
                    </p>
                )}

                {!sent && !nothingToReport && (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">What is wrong with it</span>
                            <Select
                                value={reason}
                                onValueChange={(next) => setReason(next as ChatReportReason)}
                                options={CHAT_REPORT_REASONS.map((entry) => ({
                                    value: entry,
                                    label: CHAT_REPORT_LABELS[entry]
                                }))}
                                aria-label="What is wrong with it"
                            />
                        </label>

                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Anything else (optional)</span>
                            <Textarea
                                value={note}
                                rows={3}
                                maxLength={MAX_CHAT_REPORT_NOTE}
                                placeholder="What should whoever reads this know?"
                                onChange={(event) => setNote(event.target.value)}
                            />
                        </label>

                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button
                        variant={sent ? "primary" : "ghost"}
                        onClick={() => close(false)}
                    >
                        {sent ? "Done" : nothingToReport ? "Close" : "Cancel"}
                    </Button>
                    {!sent && !nothingToReport && (
                        <Button
                            variant="danger"
                            disabled={busy || !messageId}
                            onClick={() => void send()}
                            className={cn(busy && "opacity-70")}
                        >
                            Report
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
