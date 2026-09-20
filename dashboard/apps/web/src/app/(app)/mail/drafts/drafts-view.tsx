"use client";

/**
 * The drafts, and the way back into one.
 *
 * A list rather than the conversation view every other screen uses, because a
 * draft is not a conversation: there is one of it, nobody has replied to it, and
 * the only thing anybody wants to do with it is carry on writing. Pressing one
 * reopens the composer exactly where it was left, which is the whole feature -
 * a draft that cannot be reopened is a draft that was never saved.
 *
 * A draft that is waiting to go says so and is not opened: it is in the send
 * queue, and the composer's own countdown is what takes it back.
 *
 * A message the outgoing server would not take is the third thing on this
 * screen, and it used to be indistinguishable from the second: it kept its hour,
 * so it drew as "Waiting to go out" at a time in the past, for ever, greyed out,
 * with no way to open it, throw it away or try it again. Somebody reading that
 * has been told their message is on its way when it is not going anywhere. It
 * now says it was not sent, says what the server said, and offers the two things
 * there are to do about it.
 */

import { refusalOf } from "../refusal";
import { useMail } from "../mail-shell";
import { useEffect, useState } from "react";
import type { MailDraftView } from "@/lib/mailbox/compose";
import { useDisplayFormat } from "@/components/display-format";
import { Button, EmptyState, cn, useToast } from "@polaris/ui";
import { discardDraftAction, retrySendAction } from "../actions";
import { Pencil, RotateCcw, Send, Trash2, TriangleAlert } from "lucide-react";

export function DraftsView({ drafts }: { drafts: MailDraftView[] }) {
    const toast = useToast();
    const format = useDisplayFormat();
    const { openComposer, reloadLists } = useMail();
    /**
     * Drafts thrown away here, before the server has said so.
     *
     * The row went when the answer came back and the whole screen was rendered
     * again for it, which on a list of drafts is a press that appears to do
     * nothing for a moment and then redraws everything. It goes now; it comes
     * back, with the reason, if the server refuses.
     */
    const [discarded, setDiscarded] = useState<string[]>([]);
    /** The ones whose Try again is in flight, so a second press cannot be a
     *  second message. The server refuses one anyway - the claim is on the row -
     *  and this is what stops the press looking like it did nothing. */
    const [retrying, setRetrying] = useState<string[]>([]);
    // The server's own list has moved: whatever this was standing in for is
    // either in it or gone from it.
    useEffect(() => setDiscarded([]), [drafts]);
    const shown = drafts.filter((draft) => !discarded.includes(draft.id));

    if (shown.length === 0) {
        return (
            <div className="p-6">
                <EmptyState
                    icon={<Pencil className="size-5 shrink-0" aria-hidden />}
                    title="Nothing half-written"
                    description="A message you start is saved here as you type, so you can close the composer and come back to it."
                />
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <header className="shrink-0 border-b border-border px-3 py-2">
                <h1 className="text-[17px] font-semibold tracking-tight">Drafts</h1>
                <p className="text-[12px] text-muted-foreground">
                    Saved as you write. Nothing here has been sent.
                </p>
            </header>

            <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                {shown.map((draft) => {
                    // Refused first: a message that failed may still carry the
                    // hour it was due at, and reading that as "waiting" is the
                    // whole bug this screen had.
                    const refused = draft.state === "failed";
                    const waiting = !refused && Boolean(draft.sendAt);
                    return (
                        <li key={draft.id} className="border-b border-border/60">
                            <div className="flex items-start gap-2 px-3 py-2">
                                <button
                                    type="button"
                                    className={cn(
                                        "min-w-0 flex-1 text-left",
                                        waiting && "cursor-default opacity-70"
                                    )}
                                    disabled={waiting}
                                    onClick={() =>
                                        openComposer({
                                            draftId: draft.id,
                                            accountId: draft.accountId,
                                            to: draft.to,
                                            cc: draft.cc,
                                            subject: draft.subject,
                                            body: draft.body,
                                            inReplyToId: draft.inReplyToId,
                                            forward: draft.forward
                                        })
                                    }
                                >
                                    <span className="flex items-baseline gap-2">
                                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                            {draft.subject || "(no subject)"}
                                        </span>
                                        <span className="shrink-0 text-[11px] text-foreground-subtle">
                                            {format.dateTime(new Date(draft.updatedAt))}
                                        </span>
                                    </span>
                                    <span className="mt-0.5 block text-[12px] text-foreground-subtle">
                                        {refused ? (
                                            <span className="flex items-start gap-1.5 text-warning">
                                                <TriangleAlert
                                                    className="mt-0.5 size-3 shrink-0"
                                                    aria-hidden
                                                />
                                                <span className="min-w-0">
                                                    {draft.failure ||
                                                        "It was not sent. Try it again."}
                                                </span>
                                            </span>
                                        ) : waiting ? (
                                            <span className="flex items-center gap-1.5">
                                                <Send className="size-3 shrink-0" aria-hidden />
                                                Waiting to go out
                                                {draft.sendAt
                                                    ? ` at ${format.dateTime(new Date(draft.sendAt))}`
                                                    : ""}
                                            </span>
                                        ) : (
                                            <span className="block truncate">
                                                {`To ${draft.to.map((one) => one.address).join(", ") || "nobody yet"}`}
                                            </span>
                                        )}
                                    </span>
                                </button>
                                {refused && !draft.willRetry ? (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label="Send this message again"
                                        title="Send this message again"
                                        disabled={retrying.includes(draft.id)}
                                        onClick={() => {
                                            setRetrying((held) => [...held, draft.id]);
                                            void (async () => {
                                                const answer = await retrySendAction(draft.id);
                                                setRetrying((held) =>
                                                    held.filter((id) => id !== draft.id)
                                                );
                                                const said = refusalOf(answer);
                                                if (said) {
                                                    toast.show({ title: said });
                                                    return;
                                                }
                                                toast.show({
                                                    title:
                                                        "queued" in answer && answer.queued
                                                            ? "Sending it again."
                                                            : "That message is no longer waiting to be sent."
                                                });
                                                reloadLists();
                                            })();
                                        }}
                                    >
                                        <RotateCcw className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Throw this draft away"
                                    title="Throw this draft away"
                                    disabled={waiting}
                                    onClick={() => {
                                        setDiscarded((held) => [...held, draft.id]);
                                        void (async () => {
                                            const answer = await discardDraftAction(draft.id);
                                            const said = refusalOf(answer);
                                            if (said) {
                                                setDiscarded((held) =>
                                                    held.filter((id) => id !== draft.id)
                                                );
                                                toast.show({ title: said });
                                                return;
                                            }
                                            // The list this screen draws is the
                                            // server's; asking for it again is
                                            // what makes the row's absence real.
                                            reloadLists();
                                        })();
                                    }}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </div>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
