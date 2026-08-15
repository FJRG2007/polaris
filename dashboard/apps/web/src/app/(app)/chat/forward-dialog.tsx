"use client";

/**
 * Sending a message on to somewhere else.
 *
 * The list is the conversations this person is already in, because that is what
 * forwarding is: moving something you can read into somewhere you can write. It
 * is not a way to reach a room you are not in.
 *
 * The note on top is optional and usually the point - "look at this" is most of
 * what a forward says. The original travels as a quote rather than as copied
 * text, so who said it and when survives the move.
 */

import { useChat } from "./chat-context";
import { useMemo, useState } from "react";
import { forwardAction } from "./actions";
import { runAction } from "@/lib/run-action";
import type { ChatMessageView } from "@/lib/chat/messages";
import { Forward, Loader2, Hash, Users } from "lucide-react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

export function ForwardDialog({
    message,
    onOpenChange,
    onSent
}: {
    /** The message being forwarded. Null closes the dialog - one prop rather
     *  than a boolean beside it, so the two cannot disagree. */
    message: ChatMessageView | null;
    onOpenChange: (open: boolean) => void;
    onSent: () => void;
}) {
    const { channels } = useChat();
    const [target, setTarget] = useState<string | null>(null);
    const [note, setNote] = useState("");
    const [query, setQuery] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const options = useMemo(() => {
        const term = query.trim().toLowerCase();
        return channels
            .filter((channel) => !channel.archived)
            .filter((channel) => !term || channel.name.toLowerCase().includes(term));
    }, [channels, query]);

    const send = async () => {
        if (!message || !target) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () => forwardAction({ messageId: message.id, channelId: target, note }),
            setError
        );
        setBusy(false);
        if (result?.error) return;
        setTarget(null);
        setNote("");
        setQuery("");
        onOpenChange(false);
        onSent();
    };

    return (
        <Dialog open={message !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Forward this message</DialogTitle>
                    <DialogDescription>
                        It arrives quoted, so who said it and when goes with it.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <Input
                        value={query}
                        placeholder="Find a conversation"
                        aria-label="Find a conversation"
                        onChange={(event) => setQuery(event.target.value)}
                    />

                    <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
                        {options.length === 0 ? (
                            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                                Nothing matches that.
                            </li>
                        ) : (
                            options.map((channel) => (
                                <li key={channel.id}>
                                    <button
                                        type="button"
                                        onClick={() => setTarget(channel.id)}
                                        className={cn(
                                            "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                                            target === channel.id && "bg-card-hover"
                                        )}
                                    >
                                        {channel.spaceId ? (
                                            <Hash className="size-3.5 shrink-0 text-muted-foreground" />
                                        ) : (
                                            <Users className="size-3.5 shrink-0 text-muted-foreground" />
                                        )}
                                        <span className="truncate" title={channel.name}>
                                            {channel.name}
                                        </span>
                                    </button>
                                </li>
                            ))
                        )}
                    </ul>

                    <Input
                        value={note}
                        placeholder="Say something about it (optional)"
                        aria-label="Say something about it"
                        onChange={(event) => setNote(event.target.value)}
                    />

                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={busy || !target} onClick={() => void send()}>
                        {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                        ) : (
                            <Forward className="size-4" />
                        )}
                        Forward
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
