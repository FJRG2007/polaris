"use client";

/**
 * A poll, under the question that is the message itself.
 *
 * The card draws only the answers and what has become of them: the question is
 * the message body above it, rendered by the same code that renders every other
 * message, which is why a poll needs no special case in search, in a quote or in
 * the conversation list.
 *
 * A press votes immediately and the bars move under the finger, the same way a
 * reaction does - there is no second button to confirm with, because the one
 * thing worse than a mis-click on a poll is a vote somebody thought they had
 * cast and had not. It is put back if the server refuses, and the live frame
 * replaces the guess with the count a moment later either way.
 *
 * A poll that hides its results shows no bars and no numbers while it runs, only
 * which answer this reader picked. The count of people who have voted is still
 * shown, because that says how many have taken part rather than what any of them
 * chose, and it is the thing people actually want to know while one is open.
 */

import * as actions from "./actions";
import { Button, cn } from "@polaris/ui";
import { useChatStream } from "./use-chat-stream";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatPollView } from "@/lib/chat/polls";
import { RelativeTime } from "@/components/relative-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { BarChart3, Check, CircleSlash, Loader2 } from "lucide-react";

export function PollCard({
    message,
    poll,
    canPost,
    canEnd,
    onError
}: {
    message: ChatMessageView;
    poll: ChatPollView;
    /** Whether this reader may take part at all. A room they may read and not
     *  write in is a room they may read a poll in and not answer it. */
    canPost: boolean;
    /** Whether they may close it early: whoever asked it, and whoever moderates
     *  the room. */
    canEnd: boolean;
    onError: (message: string) => void;
}) {
    /**
     * What the card is drawing, which is the server's answer until somebody
     * presses something and this reader's guess for the moment after that.
     *
     * Replaced whenever the message reloads, so the guess never outlives the
     * real count: the live frame that follows a vote brings everybody's.
     */
    const [shown, setShown] = useState<ChatPollView>(poll);
    const [busy, setBusy] = useState(false);
    const [ending, setEnding] = useState(false);
    useEffect(() => setShown(poll), [poll]);

    const closed = shown.closed;

    /**
     * Somebody else voted.
     *
     * The conversation's own catch-up cannot bring this: it asks for what was
     * said after the newest line it holds, and a vote changes a message that is
     * already on screen. So the card listens for the frame itself and re-reads
     * its own poll - a handful of rows, and only while it is running, since a
     * closed poll's numbers cannot move again.
     *
     * Never while a vote of this reader's is in flight. The answer would be from
     * before their own write landed, and it would put the bars back for a moment
     * under the finger that had just moved them.
     */
    const voting = useRef(false);
    voting.current = busy;
    useChatStream(
        useCallback(
            (frame) => {
                if (frame.kind !== "posted" || !frame.channels.includes(message.channelId)) return;
                if (voting.current || closed) return;
                void actions.pollAction(message.id).then((result) => {
                    if (result.poll && !voting.current) setShown(result.poll);
                });
            },
            [message.channelId, message.id, closed]
        )
    );
    const mayVote = canPost && !closed && !message.deleted;
    /** What the bars are a share of. People rather than presses: on a poll that
     *  takes several answers the shares add up past a hundred, which is the
     *  honest reading - "seven of the nine can make Tuesday". */
    const denominator = Math.max(shown.voters, 1);
    const most = shown.results ? Math.max(0, ...shown.options.map((option) => option.votes)) : 0;

    /**
     * Press an answer.
     *
     * The whole selection goes each time rather than the one that changed, so
     * the request says what this person stands behind now and pressing the same
     * answer twice takes the vote back rather than casting it again.
     */
    const pick = async (optionId: string) => {
        if (!mayVote || busy) return;
        const before = shown;
        const on = shown.options.find((option) => option.id === optionId)?.mine ?? false;
        const wanted = shown.multiple
            ? shown.options
                  .filter((option) => (option.id === optionId ? !on : option.mine))
                  .map((option) => option.id)
            : on
              ? []
              : [optionId];

        setShown(guessed(shown, wanted));
        setBusy(true);
        const result = await actions.votePollAction({ messageId: message.id, optionIds: wanted });
        setBusy(false);
        if (result.error) {
            setShown(before);
            onError(result.error);
        }
    };

    const end = async () => {
        if (ending) return;
        setEnding(true);
        const result = await actions.endPollAction(message.id);
        setEnding(false);
        if (result.error) onError(result.error);
        else setShown((current) => ({ ...current, closed: true, endedEarly: true }));
    };

    return (
        <div className="mt-1 max-w-md rounded-md border border-border bg-card p-3">
            <p className="mb-2 flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                <BarChart3 className="size-3" />
                {closed ? "Poll closed" : shown.multiple ? "Pick as many as apply" : "Pick one"}
            </p>

            <ul className="flex flex-col gap-1">
                {shown.options.map((option) => {
                    const share = shown.results
                        ? Math.round((option.votes / denominator) * 100)
                        : 0;
                    // Only once it is over, and only when there is something to
                    // win: a leader halfway through is not a result, and marking
                    // one would be the card taking a side.
                    const won = closed && shown.results && option.votes > 0 && option.votes === most;
                    return (
                        <li key={option.id}>
                            <button
                                type="button"
                                disabled={!mayVote}
                                aria-pressed={option.mine}
                                onClick={() => void pick(option.id)}
                                className={cn(
                                    "relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-2 py-1.5 text-left text-sm transition-colors",
                                    option.mine ? "border-primary" : "border-border",
                                    mayVote ? "hover:bg-card-hover" : "cursor-default"
                                )}
                            >
                                {/* The bar is behind the row rather than under
                                    it: a separate track would double the height
                                    of every answer, and ten of those is a card
                                    nobody can see the end of. */}
                                {shown.results && (
                                    <span
                                        aria-hidden="true"
                                        style={{ width: `${Math.min(100, share)}%` }}
                                        className={cn(
                                            "absolute inset-y-0 left-0 transition-[width] duration-300",
                                            won ? "bg-primary/25" : "bg-primary/10"
                                        )}
                                    />
                                )}
                                <span
                                    className={cn(
                                        "relative flex size-4 shrink-0 items-center justify-center border",
                                        shown.multiple ? "rounded-[3px]" : "rounded-full",
                                        option.mine
                                            ? "border-primary bg-primary text-primary-foreground"
                                            : "border-border-strong"
                                    )}
                                >
                                    {option.mine && <Check className="size-3" />}
                                </span>
                                <span
                                    className={cn("relative min-w-0 flex-1 break-words", won && "font-medium")}
                                >
                                    {option.text}
                                </span>
                                {shown.results && (
                                    <span className="relative shrink-0 text-xs tabular-nums text-muted-foreground">
                                        {share}% ({option.votes})
                                    </span>
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                    {shown.voters === 1 ? "1 vote" : `${shown.voters} votes`}
                </span>
                <span aria-hidden="true">-</span>
                {closed ? (
                    <span>{shown.endedEarly ? "Closed early" : "Closed"}</span>
                ) : shown.closesAt ? (
                    <span>
                        Closes <RelativeTime iso={shown.closesAt} tense="future" />
                    </span>
                ) : (
                    <span>Open until it is closed</span>
                )}
                {!shown.results && !closed && (
                    <>
                        <span aria-hidden="true">-</span>
                        <span>Results show when it closes</span>
                    </>
                )}
                {busy && <Loader2 className="size-3 animate-spin" aria-label="Saving your vote" />}
                {canEnd && !closed && (
                    <Button
                        size="xs"
                        variant="ghost"
                        disabled={ending}
                        onClick={() => void end()}
                        className="ml-auto"
                    >
                        <CircleSlash />
                        {ending ? "Closing..." : "End poll"}
                    </Button>
                )}
            </div>
        </div>
    );
}

/**
 * What the card should look like a moment after a press, before the server has
 * answered.
 *
 * Only the reader's own row moves: their marks, the tallies their vote is part
 * of, and whether they now count among the voters. Everybody else's votes are
 * left exactly as they were, because this browser does not know what they have
 * done since the page was drawn - and a guess that touched them would flicker
 * back the moment the real count arrived.
 */
function guessed(poll: ChatPollView, wanted: readonly string[]): ChatPollView {
    const picked = new Set(wanted);
    const voted = picked.size > 0;
    return {
        ...poll,
        voters: poll.voters + (voted ? 1 : 0) - (poll.voted ? 1 : 0),
        voted,
        options: poll.options.map((option) => {
            const mine = picked.has(option.id);
            if (mine === option.mine) return option;
            return {
                ...option,
                mine,
                // Never below zero. A hidden poll carries no counts at all, so
                // taking one away from an answer this reader had picked would
                // otherwise draw a negative share the instant it closed.
                votes: Math.max(0, option.votes + (mine ? 1 : -1))
            };
        })
    };
}
