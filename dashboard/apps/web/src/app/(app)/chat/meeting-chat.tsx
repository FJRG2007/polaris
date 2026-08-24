"use client";

/**
 * The chat inside a meeting.
 *
 * A call cannot carry an address, a name spelled out, or the line of a document
 * everybody is looking for - somebody reads it aloud twice and it is still
 * wrong. Every client people already use answers this the same way, with a
 * column beside the room, and this is that column.
 *
 * It is the same box as everywhere else in Polaris, and that is the point. It
 * used to be a single-line field that took plain text and nothing else: an
 * address pasted into a call stayed a string, a screenshot had to go somewhere
 * that was not the call, and a question for the room had to be asked out loud
 * and counted by hand. So it is the composer now - the same editor, the same
 * emoji, the same files, the same polls - and the only things missing are the
 * ones that need an account half the room does not have.
 *
 * What is written here belongs to a seat - the same row the roster draws - which
 * is the only identity a meeting can promise for everybody in it, and it goes
 * when the meeting goes. Nobody should find out a year later that what they
 * typed into a call outlived the call, and that promise is kept on the server,
 * where the room is closed.
 *
 * It re-reads when the room says something rather than on a timer: the call's
 * own connection carries the nudge, so a quiet meeting costs nothing.
 */

import { Composer } from "./composer";
import { Avatar } from "@/components/avatar";
import type { CallState } from "./call-state";
import { useAppUrl } from "@/components/app-url";
import { MessageSquare, Download } from "lucide-react";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { RelativeTime } from "@/components/relative-time";
import { RichText } from "@/components/rich-text/rich-text";
import { MAX_MEETING_LINE } from "@/lib/chat/meeting-limits";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Skeleton, cn } from "@polaris/ui";
import { DEFAULT_CHAT_RULES } from "@polaris/core";
import type { MeetingFileView, MeetingLine, MeetingPollView } from "@/lib/chat/meeting-chat";
import {
    closePollInMeetingAction,
    mentionsInMeetingAction,
    pollInMeetingAction,
    saidInMeetingAction,
    sayInMeetingAction,
    voteInMeetingAction
} from "./meeting-actions";

/** How many files one line may carry, and how big one may be. The server's own
 *  limits; here so a file is refused while it is being picked rather than after
 *  it has been uploaded. */
const MEETING_FILES = 5;
const MEETING_FILE_MIB = 25;

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
    const baseUrl = useAppUrl();
    const [lines, setLines] = useState<readonly MeetingLine[] | null>(null);
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

    /**
     * What the composer is allowed to accept.
     *
     * A call is not under any conversation's rules - it is not in a space, it is
     * not a group and it is not a direct message - so it carries its own, and
     * they are the ones the server enforces. Everything about editing and
     * history is left at its default and never used: nothing here is edited.
     */
    const rules = useMemo(
        () => ({
            ...DEFAULT_CHAT_RULES,
            maxMessageLength: MAX_MEETING_LINE,
            maxAttachments: MEETING_FILES,
            maxAttachmentMib: MEETING_FILE_MIB
        }),
        []
    );

    /**
     * Who @ offers here: the people in this call.
     *
     * The editor's usual source asks who this account shares work with, which is
     * the wrong question twice over - half a meeting are guests who share
     * nothing, and a guest doing the asking has no account to be asked about.
     */
    const mentions = useCallback(
        async (_kinds: readonly string[], query: string) => {
            const result = await mentionsInMeetingAction(meetingId, query);
            return result.results;
        },
        [meetingId]
    );

    const send = async (body: string, files: readonly File[] = []): Promise<void> => {
        // Words alone go through the action; anything carrying a file goes
        // through the route that can write bytes, because the bytes have to be
        // on storage before the line exists.
        if (files.length === 0) {
            const result = await sayInMeetingAction(meetingId, body);
            if (result.error) {
                setError(result.error);
                return;
            }
        } else {
            const form = new FormData();
            form.set("body", body);
            for (const file of files) form.append("files", file);
            const response = await fetch(`/api/chat/meetings/${meetingId}/messages`, {
                method: "POST",
                body: form
            });
            if (!response.ok) {
                const answer: unknown = await response.json().catch(() => null);
                setError(
                    typeof answer === "object" && answer !== null && "error" in answer
                        ? String((answer as { error: unknown }).error)
                        : "That could not be sent"
                );
                return;
            }
        }
        setError("");
        await load();
    };

    const ask = async (draft: {
        question: string;
        options: string[];
        multiple: boolean;
        hideResults: boolean;
    }): Promise<{ error?: string }> => {
        const result = await pollInMeetingAction({
            meetingId,
            question: draft.question,
            options: draft.options,
            multiple: draft.multiple,
            hideResults: draft.hideResults
        });
        if (result.error) return result;
        await load();
        return {};
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
                                        // Null for a guest, deliberately. There
                                        // is no account behind them, so a face
                                        // would be one request per line that can
                                        // only ever be refused - the initials
                                        // and the colour come off the name.
                                        id: line.userId,
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
                                        {/* Said beside the name, because who is
                                            from outside decides how somebody
                                            answers them. */}
                                        {line.guest && (
                                            <span className="shrink-0 text-[10px] text-muted-foreground">
                                                guest
                                            </span>
                                        )}
                                        <span className="shrink-0 text-[10px] text-foreground-subtle">
                                            <RelativeTime iso={line.at} />
                                        </span>
                                    </span>

                                    {line.body && (
                                        <div className="text-sm">
                                            <RichText value={line.body} origin={baseUrl} />
                                        </div>
                                    )}

                                    {line.files.length > 0 && (
                                        <Files
                                            meetingId={meetingId}
                                            files={line.files}
                                        />
                                    )}

                                    {line.poll && (
                                        <Poll
                                            meetingId={meetingId}
                                            messageId={line.id}
                                            poll={line.poll}
                                            mine={line.participantId === call.participantId}
                                            onChanged={load}
                                            onError={setError}
                                        />
                                    )}
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

            <div className="shrink-0 border-t border-border">
                <Composer
                    inCall
                    channelId={meetingId}
                    rules={rules}
                    disabled={false}
                    mentionSource={mentions}
                    placeholder="Say something"
                    onSend={send}
                    onPoll={ask}
                />
            </div>
        </section>
    );
}

/** What a picture may take up before the column it is in stops being a column. */
const PICTURE_MAX = "max-h-48";

/** Whether the browser may be asked to draw this as itself. The server's list,
 *  which is images that cannot carry script - hence no SVG. */
function isPicture(contentType: string): boolean {
    return ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(
        (contentType.split(";")[0] ?? "").trim().toLowerCase()
    );
}

/** A size somebody can read. */
function saidSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The files on one line.
 *
 * A picture is drawn and everything else is a row with a name on it, which is
 * the same decision the conversation makes: the point of sending a screenshot is
 * that nobody has to open it, and the point of sending a spreadsheet is that
 * they do.
 */
function Files({
    meetingId,
    files
}: {
    meetingId: string;
    files: readonly MeetingFileView[];
}) {
    return (
        <div className="mt-1 flex flex-col gap-1">
            {files.map((file) => {
                const href = `/api/chat/meetings/${meetingId}/files/${file.id}`;
                return isPicture(file.contentType) ? (
                    <a
                        key={file.id}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-fit overflow-hidden rounded border border-border"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={href}
                            alt={file.name}
                            className={cn("h-auto w-auto max-w-full object-contain", PICTURE_MAX)}
                        />
                    </a>
                ) : (
                    <a
                        key={file.id}
                        href={`${href}?download=1`}
                        className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-xs no-underline transition-colors hover:bg-muted"
                    >
                        <Download className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                        <span className="shrink-0 text-foreground-subtle">
                            {saidSize(file.size)}
                        </span>
                    </a>
                );
            })}
        </div>
    );
}

/**
 * A question asked of the room.
 *
 * Answered by a seat rather than by an account, which is what lets the guest who
 * joined on the link answer at all - and a poll in a call that half the room
 * cannot answer is a poll asked of the wrong people.
 *
 * The count is drawn from what the server said until somebody presses something,
 * and the press replaces it with this browser's guess for the moment after. The
 * reload that follows brings everybody's.
 */
function Poll({
    meetingId,
    messageId,
    poll,
    mine,
    onChanged,
    onError
}: {
    meetingId: string;
    messageId: string;
    poll: MeetingPollView;
    /** Whether the reader is the seat that asked it, which is who may close it. */
    mine: boolean;
    onChanged: () => void | Promise<void>;
    onError: (message: string) => void;
}) {
    const [busy, setBusy] = useState(false);

    const vote = async (optionId: string): Promise<void> => {
        if (busy || poll.closed) return;
        setBusy(true);
        const result = await voteInMeetingAction(meetingId, optionId);
        setBusy(false);
        if (result.error) {
            onError(result.error);
            return;
        }
        await onChanged();
    };

    return (
        <div className="mt-1 flex flex-col gap-1 rounded border border-border p-2">
            {poll.options.map((option) => {
                const share = poll.total > 0 ? Math.round((option.votes / poll.total) * 100) : 0;
                return (
                    <button
                        key={option.id}
                        type="button"
                        disabled={busy || poll.closed}
                        onClick={() => void vote(option.id)}
                        aria-pressed={option.mine}
                        className={cn(
                            "relative overflow-hidden rounded px-2 py-1 text-left text-xs transition-colors",
                            option.mine ? "bg-primary/15 font-medium" : "hover:bg-muted",
                            (busy || poll.closed) && "cursor-default"
                        )}
                    >
                        {/* The bar behind the words rather than beside them:
                            the column is narrow, and a bar in a lane of its own
                            takes the width the answer needs to be readable. */}
                        {!poll.hidden && (
                            <span
                                aria-hidden
                                style={{ width: `${share}%` }}
                                className="absolute inset-y-0 left-0 bg-primary/10"
                            />
                        )}
                        <span className="relative flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate" title={option.text}>{option.text}</span>
                            {!poll.hidden && (
                                <span className="shrink-0 tabular-nums text-foreground-subtle">
                                    {option.votes}
                                </span>
                            )}
                        </span>
                    </button>
                );
            })}
            <span className="flex items-center justify-between gap-2 pt-0.5 text-[10px] text-foreground-subtle">
                <span>
                    {poll.hidden
                        ? "The answers are hidden until it closes"
                        : poll.total === 1
                          ? "1 answer"
                          : `${poll.total} answers`}
                    {poll.closed && " - closed"}
                    {!poll.closed && poll.multiple && " - pick as many as you like"}
                </span>
                {mine && !poll.closed && (
                    <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                            const result = await closePollInMeetingAction(meetingId, messageId);
                            if (result.error) {
                                onError(result.error);
                                return;
                            }
                            await onChanged();
                        }}
                    >
                        Close it
                    </Button>
                )}
            </span>
        </div>
    );
}
