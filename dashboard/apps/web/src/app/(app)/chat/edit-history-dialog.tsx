"use client";

/**
 * What a message used to say.
 *
 * "(edited)" on its own asks the room to take the change on trust, which is
 * fine between two people and not fine in a channel somebody is going to quote
 * later. So the marker opens: the text as it stands now, then every version
 * before it, newest first.
 *
 * Anybody who can read the message can read this. The history is about a message
 * already in front of them, and one only the author could open would answer
 * nothing.
 *
 * An instance can turn the whole thing off, and then this says so rather than
 * showing an empty list - "no earlier versions are kept here" and "this was
 * edited once and we lost it" are very different sentences.
 */

import { useEffect, useState } from "react";
import { editHistoryAction } from "./actions";
import { History, Loader2 } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatEditHistory } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { useDisplayFormat } from "@/components/display-format";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export function EditHistoryDialog({
    message,
    onOpenChange
}: {
    /** The message whose history to show. Null closes it - one prop rather than
     *  a boolean beside it, so the two cannot disagree. */
    message: ChatMessageView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const format = useDisplayFormat();
    const [history, setHistory] = useState<ChatEditHistory | null>(null);
    const [error, setError] = useState("");

    // Fetched when it opens rather than with the message: a channel of two
    // hundred messages would otherwise carry two hundred histories nobody asked
    // for.
    useEffect(() => {
        if (!message) {
            setHistory(null);
            setError("");
            return;
        }
        let current = true;
        void editHistoryAction(message.id).then((result) => {
            if (!current) return;
            if (result.error) setError(result.error);
            else setHistory(result.history ?? null);
        });
        return () => {
            current = false;
        };
    }, [message]);

    return (
        <Dialog open={message !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Edit history</DialogTitle>
                    <DialogDescription>
                        What this message said before it was changed.
                    </DialogDescription>
                </DialogHeader>

                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : !history ? (
                    <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="size-4 animate-spin" />
                        Reading it back
                    </p>
                ) : (
                    <ol className="flex max-h-80 flex-col gap-3 overflow-y-auto">
                        <li className="rounded-md border border-border-strong bg-card p-3">
                            <p className="mb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                                Now
                            </p>
                            <div className="text-sm">
                                <RichText value={message?.body ?? ""} />
                            </div>
                        </li>

                        {history.versions.map((version) => (
                            <li
                                key={version.replacedAt}
                                className="rounded-md border border-border bg-muted/40 p-3"
                            >
                                <p
                                    className="mb-1 text-[0.6875rem] text-muted-foreground"
                                    title={format.dateTime(version.replacedAt)}
                                >
                                    Until <RelativeTime iso={version.replacedAt} />
                                </p>
                                <div className="text-sm text-muted-foreground">
                                    <RichText value={version.body} />
                                </div>
                            </li>
                        ))}

                        {history.versions.length === 0 && (
                            <li className="flex items-start gap-2 px-1 text-sm text-muted-foreground">
                                <History className="mt-0.5 size-4 shrink-0" />
                                {history.kept
                                    ? "Nothing earlier was recorded for this one."
                                    : "Earlier versions are not kept in this kind of conversation."}
                            </li>
                        )}
                    </ol>
                )}
            </DialogContent>
        </Dialog>
    );
}
