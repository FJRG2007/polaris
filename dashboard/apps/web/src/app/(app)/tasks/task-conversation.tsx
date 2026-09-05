"use client";

/**
 * The talking and the timing: one thread per task, and the time logged against it.
 *
 * Comments and history are one stream rather than two lists. Split apart, the
 * question "what happened to this?" needs both read side by side and mentally
 * interleaved by timestamp - and the answer is usually a status change followed
 * by somebody explaining it. Oldest at the top, newest above the composer, which
 * is where every chat client has trained people to look.
 *
 * Comments are threaded one level deep on purpose. A reply to a reply is how a
 * task turns into a forum, and the thing being discussed is right there in the
 * other column.
 *
 * The box is the one from Chat, not a second one that looks like it. Writing a
 * comment and writing a message are the same act - the same mentions, the same
 * emoji, the same Enter, the same screenshot pasted straight in - and this
 * screen had a plainer copy that quietly did less. What a task does not have is
 * a conversation, so nothing here announces that somebody is typing, and it does
 * not have chat's files either: a task's attachments live in its own panel, and
 * two places to put a file on one task is one too many.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { formatBytes } from "@polaris/core";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useState } from "react";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { RelativeTime } from "@/components/relative-time";
import { RichText } from "@/components/rich-text/rich-text";
import { cn, Input, Button, SegmentedControl } from "@polaris/ui";
import { Composer } from "@/app/(app)/chat/composer";
import { CheckCircle2, Paperclip, Play, Square, Trash2 } from "lucide-react";
import type { ActivityView, CommentView, TimeEntryView } from "@/lib/tasks/task-service";
import { describeActivity, mergeConversation, type ConversationFilter } from "./conversation";

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/**
 * What the comment box allows.
 *
 * Chat's own rules are an instance setting about conversations, and a task is
 * not one - so a comment answers to the comment schema's own ceiling, and to no
 * attachments at all. A task's files live in its own panel; a second place to
 * put one, with a different limit, is how two lists of the same attachments come
 * to disagree.
 */
const COMMENT_RULES: core.ChatRules = {
    ...core.DEFAULT_CHAT_RULES,
    maxMessageLength: core.COMMENT_BODY_MAX,
    // A task thread takes files, pictures, voice notes and screen clips - the
    // same things the chat composer already offers, because it is the same
    // composer. It was zero, which is why the buttons were not drawn at all.
    maxAttachments: core.DEFAULT_CHAT_RULES.maxAttachments
};

export function ActivityStream({
    taskId,
    comments,
    activity,
    currentUserId,
    canModerate,
    onChanged,
    onError
}: {
    taskId: string;
    comments: readonly CommentView[];
    activity: readonly ActivityView[];
    currentUserId: string;
    canModerate: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [filter, setFilter] = useState<ConversationFilter>("all");
    const [replyTo, setReplyTo] = useState<string | null>(null);
    const stream = useMemo(() => mergeConversation(comments, activity, filter), [comments, activity, filter]);

    // The newest line is the one worth reading, and it is at the bottom - so this
    // follows it, and stops following while somebody is reading back through what
    // was said. Another task starts again at its own bottom.
    const follow = useFollowBottom<HTMLDivElement>(stream.length);

    useEffect(() => follow.stick(), [taskId, follow]);

    /**
     * Say something, and send whatever came with it.
     *
     * The comment first and the files after, in that order and never the other
     * way round: a file attached to a comment that was then refused is a file on
     * the task nobody meant to add, and there is nothing on screen that would
     * explain where it came from.
     *
     * The upload is the same route the Files list uses, with the comment named -
     * so what is dropped in the conversation is on the task as well, which is
     * where somebody looks for it a month later.
     */
    const post = async (
        body: string,
        parentId: string | null,
        files: readonly File[] = []
    ) => {
        setBusy(true);
        onError("");
        const result = await runAction(
            () => actions.addCommentAction({ taskId, body, parentId }),
            onError
        );
        if (result?.error) {
            onError(result.error);
            setBusy(false);
            return;
        }

        for (const file of files) {
            try {
                const response = await fetch(
                    `/api/tasks/attachments?task=${encodeURIComponent(taskId)}&name=${encodeURIComponent(
                        file.name
                    )}${result?.commentId ? `&comment=${encodeURIComponent(result.commentId)}` : ""}`,
                    {
                        method: "POST",
                        // The File itself, not FormData: the route streams the
                        // body straight into storage, and FormData would make it
                        // a multipart document somebody has to parse in memory.
                        headers: { "Content-Type": file.type || "application/octet-stream" },
                        body: file
                    }
                );
                if (!response.ok) onError((await response.text()) || "Could not send that file");
            } catch {
                onError("Could not send that file");
            }
        }

        setBusy(false);
        setReplyTo(null);
        onChanged();
    };

    const repliesOf = (id: string) => comments.filter((comment) => comment.parentId === id);

    const bubble = (comment: CommentView, nested: boolean) => (
        <div key={comment.id} className={cn("flex gap-2", nested && "ml-8")}>
            {comment.author ? (
                <Avatar person={comment.author} size={28} />
            ) : (
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] text-muted-foreground ring-1 ring-border">
                    AUT
                </span>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{comment.author?.name ?? "Automation"}</span>
                    <span className="text-xs text-muted-foreground">
                        <RelativeTime iso={comment.createdAt} />
                    </span>
                    {comment.resolvedAt && (
                        <span className="inline-flex items-center gap-1 text-[0.6875rem] text-emerald-500">
                            <CheckCircle2 className="size-3" /> Resolved
                        </span>
                    )}
                </div>
                <RichText value={comment.body} className="break-words text-foreground/90" />
                {comment.files.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2">
                        {comment.files.map((file) =>
                            file.mime.startsWith("image/") ? (
                                // Drawn rather than listed. A screenshot in a
                                // conversation is the message; making somebody
                                // open it to find that out is the thing that
                                // makes a thread unreadable.
                                <a
                                    key={file.id}
                                    href={`/api/tasks/attachments/${file.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block max-w-[16rem] overflow-hidden rounded-md border border-border"
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element -- one attachment, no loader wanted */}
                                    <img
                                        src={`/api/tasks/attachments/${file.id}`}
                                        alt={file.name}
                                        className="h-auto w-full"
                                    />
                                </a>
                            ) : (
                                <a
                                    key={file.id}
                                    href={`/api/tasks/attachments/${file.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    title={file.name}
                                    className="flex max-w-[16rem] items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs transition-colors hover:bg-muted"
                                >
                                    <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                                        {formatBytes(BigInt(file.size))}
                                    </span>
                                </a>
                            )
                        )}
                    </div>
                )}
                <div className="mt-1 flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                    {!nested && (
                        <button type="button" onClick={() => setReplyTo(comment.id)} className="hover:text-foreground">
                            Reply
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={async () => {
                            await runAction(
                                () => actions.resolveCommentAction(taskId, comment.id, !comment.resolvedAt),
                                onError
                            );
                            onChanged();
                        }}
                        className="hover:text-foreground"
                    >
                        {comment.resolvedAt ? "Reopen" : "Resolve"}
                    </button>
                    {(canModerate || comment.author?.id === currentUserId) && (
                        <button
                            type="button"
                            onClick={async () => {
                                await runAction(() => actions.deleteCommentAction(taskId, comment.id), onError);
                                onChanged();
                            }}
                            className="hover:text-danger"
                        >
                            Delete
                        </button>
                    )}
                </div>

                {replyTo === comment.id && (
                    <div className="mt-2 flex flex-col gap-1">
                        <Composer
                            channelId={null}
                            rules={COMMENT_RULES}
                            disabled={busy}
                            placeholder="Write a reply"
                            onSend={(body, files) => post(body, comment.id, files)}
                        />
                        <button
                            type="button"
                            onClick={() => setReplyTo(null)}
                            className="self-start text-[0.6875rem] text-muted-foreground hover:text-foreground"
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </div>
    );

    return (
        // Its own scrolling column only where it is one: from `md` the thread sits
        // beside the task and holds its own bottom. Below that it is the last thing
        // on a single scrolling page, and a nested scroller there collapsed the
        // whole thread to the height of one line.
        <div className="flex flex-col md:min-h-0 md:flex-1">
            <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Activity</h2>
                <SegmentedControl
                    aria-label="What to show"
                    size="sm"
                    value={filter}
                    onValueChange={setFilter}
                    options={[
                        { value: "all", label: "Everything" },
                        { value: "comments", label: "Comments" }
                    ]}
                />
            </header>

            <div
                ref={follow.ref}
                onScroll={follow.onScroll}
                className="flex flex-col gap-4 p-4 md:min-h-0 md:flex-1 md:overflow-y-auto"
            >
                {stream.length === 0 && (
                    <p className="text-xs text-muted-foreground">Nothing has happened here yet.</p>
                )}
                {stream.map((item) =>
                    item.kind === "comment" ? (
                        <div key={item.comment.id} className="flex flex-col gap-3">
                            {bubble(item.comment, false)}
                            {repliesOf(item.comment.id).map((reply) => bubble(reply, true))}
                        </div>
                    ) : (
                        <div key={item.line.id} className="flex items-start gap-2 text-xs text-muted-foreground">
                            <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border" />
                            <span className="flex-1">{describeActivity(item.line)}</span>
                            <RelativeTime iso={item.line.createdAt} />
                        </div>
                    )
                )}
            </div>

            <div className="border-t border-border p-4">
                {/* Files, pictures, voice notes and screen clips, which is the
                    same composer the chat uses and therefore the same set of
                    affordances - a task thread is a conversation, and the one
                    thing it could not do was hand somebody the screenshot they
                    were describing. */}
                <Composer
                    channelId={null}
                    rules={COMMENT_RULES}
                    disabled={busy}
                    placeholder="Write a comment"
                    onSend={(body, files) => post(body, null, files)}
                />
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Start or stop the timer, with what has been logged so far. Lives in the
 *  properties block, where somebody about to start work is already looking. */
export function TimerControl({
    taskId,
    trackedSeconds,
    running,
    onChanged,
    onError
}: {
    taskId: string;
    trackedSeconds: number;
    running: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    return (
        <div className="flex items-center gap-2">
            <Button
                size="sm"
                variant={running ? "danger" : "ghost"}
                onClick={async () => {
                    onError("");
                    await runAction(
                        () => (running ? actions.stopTimerAction() : actions.startTimerAction(taskId)),
                        onError
                    );
                    onChanged();
                }}
            >
                {running ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                {running ? "Stop" : "Start"}
            </Button>
            {trackedSeconds > 0 && (
                <span className="text-xs text-muted-foreground">{core.formatTrackedSeconds(trackedSeconds)} logged</span>
            )}
        </div>
    );
}

export function TimeSection({
    taskId,
    entries,
    estimate,
    currentUserId,
    canModerate,
    onChanged,
    onError
}: {
    taskId: string;
    entries: readonly TimeEntryView[];
    /** Minutes, so the section can say how much of it has gone. */
    estimate: number | null;
    currentUserId: string;
    canModerate: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [manual, setManual] = useState("");
    const [note, setNote] = useState("");
    const [billable, setBillable] = useState(false);

    const tracked = entries.reduce((sum, entry) => sum + entry.seconds, 0);
    const used = estimate && estimate > 0 ? Math.round((tracked / 60 / estimate) * 100) : null;

    return (
        <section className="flex flex-col gap-3">
            <header className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">Time</h3>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{core.formatTrackedSeconds(tracked)} tracked</span>
                    {estimate ? <span>of {core.formatDurationMinutes(estimate)}</span> : null}
                    {used !== null && <span className={cn(used > 100 && "text-amber-500")}>({used}%)</span>}
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={manual}
                    placeholder="1h 30m"
                    aria-label="Time to log"
                    onChange={(event) => setManual(event.target.value)}
                    className="h-8 w-24 text-xs"
                />
                <Input
                    value={note}
                    placeholder="What was it for?"
                    aria-label="Note"
                    onChange={(event) => setNote(event.target.value)}
                    className="h-8 w-44 text-xs"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={billable} onChange={(event) => setBillable(event.target.checked)} />
                    Billable
                </label>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={!manual.trim()}
                    onClick={async () => {
                        onError("");
                        const result = await runAction(
                            () => actions.addTimeEntryAction(taskId, manual, note, billable),
                            onError
                        );
                        if (result?.error) onError(result.error);
                        else {
                            setManual("");
                            setNote("");
                        }
                        onChanged();
                    }}
                >
                    Log
                </Button>
            </div>

            {entries.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                    {entries.map((entry) => (
                        <li key={entry.id} className="flex items-center gap-2 px-3 py-2">
                            <span className="w-16 font-mono text-xs">
                                {entry.running ? "running" : core.formatTrackedSeconds(entry.seconds)}
                            </span>
                            <span className="flex-1 truncate text-xs text-muted-foreground">
                                {entry.userName}
                                {entry.note ? ` - ${entry.note}` : ""}
                            </span>
                            {entry.billable && <span className="text-[0.6875rem] text-emerald-500">billable</span>}
                            {(canModerate || entry.userId === currentUserId) && !entry.running && (
                                <button
                                    type="button"
                                    aria-label="Remove entry"
                                    title="Remove entry"
                                    onClick={async () => {
                                        await runAction(() => actions.deleteTimeEntryAction(taskId, entry.id), onError);
                                        onChanged();
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
