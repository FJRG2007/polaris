"use client";

/**
 * The chat inside a meeting.
 *
 * A call cannot carry an address, a name spelled out, or the line of a document
 * everybody is looking for - somebody reads it aloud twice and it is still
 * wrong. Every client people already use answers this the same way, with a
 * column beside the room, and this is that column.
 *
 * It is not the conversation's chat and cannot be: half the room may have no
 * account at all. What is written here belongs to a seat - the same row the
 * roster draws - which is the only identity a meeting can promise for everybody
 * in it, and it goes when the meeting goes. Nobody should find out a year later
 * that what they typed into a call outlived the call, and this is the shape that
 * promise takes.
 *
 * It re-reads when the room says something rather than on a timer: the call's
 * own connection carries the nudge, so a quiet meeting costs nothing.
 */

import { Avatar } from "@/components/avatar";
import type { CallState } from "./call-state";
import { Send, MessageSquare } from "lucide-react";
import type { MeetingLine } from "@/lib/chat/meetings";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { RelativeTime } from "@/components/relative-time";
import { Button, Input, Skeleton, cn } from "@polaris/ui";
import { MAX_MEETING_LINE } from "@/lib/chat/meeting-limits";
import { useCallback, useEffect, useState } from "react";
import { saidInMeetingAction, sayInMeetingAction } from "./meeting-actions";

export function MeetingChat({
    meetingId,
    call,
    className
}: {
    meetingId: string;
    /** The call this belongs to, for the nudge that something was said and for
     *  knowing which line is the reader's own. */
    call: CallState;
    className?: string;
}) {
    const [lines, setLines] = useState<readonly MeetingLine[] | null>(null);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    // The newest line, kept in view. A chat beside a call is read at the bottom -
    // but somebody scrolling back through what was said stays where they put
    // themselves, and gets the tail again by returning to it.
    const follow = useFollowBottom<HTMLDivElement>(lines);

    const load = useCallback(async () => {
        const result = await saidInMeetingAction(meetingId);
        if (result.error) {
            setError(result.error);
            return;
        }
        setError("");
        setLines(result.lines ?? []);
    }, [meetingId]);

    // On arrival, and again whenever the room says something. `saidAt` is a
    // moment rather than the words themselves - the connection says that there
    // is something to read, and this is what goes and reads it.
    useEffect(() => {
        void load();
    }, [load, call.saidAt]);

    const send = async () => {
        const said = draft.trim();
        if (!said || sending) return;
        setSending(true);
        const result = await sayInMeetingAction(meetingId, said);
        setSending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        // Cleared on the way out rather than on the answer coming back: the box
        // is about what is being written, and this has left.
        setDraft("");
        await load();
    };

    return (
        <section
            aria-label="Meeting chat"
            className={cn("flex min-h-0 flex-col border-border", className)}
        >
            <div
                ref={follow.ref}
                onScroll={follow.onScroll}
                className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
            >
                {lines === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-4 w-2/3" />
                        <Skeleton className="h-4 w-1/2" />
                    </div>
                ) : lines.length === 0 ? (
                    <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                        <MessageSquare className="size-3.5 shrink-0" />
                        Nothing said here yet. Anything typed goes when the meeting does.
                    </p>
                ) : (
                    <ol className="flex flex-col gap-2">
                        {lines.map((line) => (
                            <li key={line.id} className="flex gap-2">
                                <Avatar
                                    size={22}
                                    person={{
                                        // A guest has no account to draw a face
                                        // from, so their seat is what colours
                                        // and letters the circle.
                                        id: line.guest ? line.participantId : line.name,
                                        name: line.name
                                    }}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="flex items-baseline gap-1.5">
                                        <span
                                            className={cn(
                                                "truncate text-xs font-medium",
                                                line.participantId === call.participantId &&
                                                    "text-primary"
                                            )}
                                        >
                                            {line.name}
                                        </span>
                                        <span className="shrink-0 text-[10px] text-foreground-subtle">
                                            <RelativeTime iso={line.at} />
                                        </span>
                                    </span>
                                    {/* Written text, drawn as text. A meeting's
                                        chat is a place to paste an address, and
                                        an address is one long unbreakable word. */}
                                    <span className="block whitespace-pre-wrap break-words text-sm">
                                        {line.body}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>

            {error && (
                <p role="alert" className="px-3 pb-1 text-xs text-danger">
                    {error}
                </p>
            )}

            <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
                <Input
                    value={draft}
                    maxLength={MAX_MEETING_LINE}
                    aria-label="Say something to the meeting"
                    placeholder="Say something"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                <Button
                    size="icon-sm"
                    variant="secondary"
                    title="Send"
                    aria-label="Send"
                    disabled={sending || !draft.trim()}
                    onClick={() => void send()}
                >
                    <Send className="size-3.5" />
                </Button>
            </div>
        </section>
    );
}
