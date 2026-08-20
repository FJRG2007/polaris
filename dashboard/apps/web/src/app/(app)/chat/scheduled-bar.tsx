"use client";

/**
 * What this conversation has waiting, and the two things to do about it.
 *
 * A message scheduled and then forgotten is the failure this exists to prevent.
 * Nothing about it appears in the room - deliberately, since it is not a message
 * yet - so without a line above the box the only record of it is in the head of
 * the person who wrote it, and the first they hear of it again is somebody
 * answering it.
 *
 * So: a line when there is anything waiting, the count, and a list behind it
 * where each one can be sent now or taken back. Nothing at all when there is
 * nothing, which is nearly always - a bar that is permanently there is a bar
 * nobody reads.
 */

import { useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { ScheduledMessageView } from "@/lib/chat/scheduled";
import { CalendarClock, SendHorizontal, Trash2 } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

/** What a waiting message says it is, when it is only files. */
function summarize(entry: ScheduledMessageView): string {
    const text = entry.body.trim();
    if (text) return text;
    if (entry.files.length === 1) return entry.files[0]!.name;
    return `${entry.files.length} files`;
}

export function ScheduledBar({
    scheduled,
    onSendNow,
    onCancel
}: {
    scheduled: readonly ScheduledMessageView[];
    onSendNow: (id: string) => Promise<void>;
    onCancel: (id: string) => Promise<void>;
}) {
    const format = useDisplayFormat();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState("");

    if (scheduled.length === 0) return null;

    const next = scheduled[0]!;
    /** Anything that could not be sent, which is what the line leads with when
     *  there is one: "waiting" and "never went" are not the same news. */
    const failed = scheduled.filter((entry) => entry.failure !== null);

    const run = async (id: string, work: () => Promise<void>) => {
        setBusy(id);
        await work();
        setBusy("");
    };

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="flex w-full items-center gap-2 border-t border-border bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
                <CalendarClock className={failed.length > 0 ? "size-3.5 text-danger" : "size-3.5"} />
                {failed.length > 0 ? (
                    <span className="text-danger">
                        {failed.length === 1
                            ? "A scheduled message could not be sent"
                            : `${failed.length} scheduled messages could not be sent`}
                    </span>
                ) : (
                    <span>
                        {scheduled.length === 1
                            ? `Scheduled for ${format.dateTime(next.sendAt)}`
                            : `${scheduled.length} scheduled, next at ${format.dateTime(next.sendAt)}`}
                    </span>
                )}
                <span className="ml-auto underline-offset-2 hover:underline">See them</span>
            </button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>Waiting to be sent</DialogTitle>
                        <DialogDescription>
                            Only you can see these. Nothing is in the conversation until it goes.
                        </DialogDescription>
                    </DialogHeader>
                    <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto">
                        {scheduled.map((entry) => (
                            <li
                                key={entry.id}
                                className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3"
                            >
                                <p className="whitespace-pre-wrap break-words text-sm">
                                    {summarize(entry)}
                                </p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span
                                        className={
                                            entry.failure
                                                ? "text-xs text-danger"
                                                : "text-xs text-muted-foreground"
                                        }
                                    >
                                        {entry.failure ?? `Sends ${format.dateTime(entry.sendAt)}`}
                                    </span>
                                    <span className="ml-auto flex items-center gap-1">
                                        <Button
                                            size="xs"
                                            variant="ghost"
                                            disabled={busy === entry.id}
                                            onClick={() => void run(entry.id, () => onSendNow(entry.id))}
                                        >
                                            <SendHorizontal className="size-3.5" />
                                            Send now
                                        </Button>
                                        <Button
                                            size="xs"
                                            variant="ghost"
                                            disabled={busy === entry.id}
                                            onClick={() => void run(entry.id, () => onCancel(entry.id))}
                                        >
                                            <Trash2 className="size-3.5" />
                                            Delete
                                        </Button>
                                    </span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </DialogContent>
            </Dialog>
        </>
    );
}
