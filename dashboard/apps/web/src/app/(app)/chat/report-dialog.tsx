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
import { reportMessageAction } from "./actions";
import type { ChatReportReason } from "@polaris/core";
import { CHAT_REPORT_LABELS, CHAT_REPORT_REASONS, MAX_CHAT_REPORT_NOTE } from "@polaris/core";
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
    open,
    onOpenChange
}: {
    /** The message being reported, or null when nothing is. */
    messageId: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
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
                            : "It goes to whoever runs this instance. Nobody in the conversation is told you reported it."}
                    </DialogDescription>
                </DialogHeader>

                {!sent && (
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
                    <Button variant="ghost" onClick={() => close(false)}>
                        {sent ? "Close" : "Cancel"}
                    </Button>
                    {!sent && (
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
