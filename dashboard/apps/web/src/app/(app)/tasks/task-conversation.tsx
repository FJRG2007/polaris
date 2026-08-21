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
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { cn, Input, Button, SegmentedControl } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { RichText } from "@/components/rich-text/rich-text";
import { useEffect, useMemo, useState } from "react";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { CheckCircle2, Play, SendHorizontal, Square, Trash2 } from "lucide-react";
import type { ActivityView, CommentView, TimeEntryView } from "@/lib/tasks/task-service";
import { describeActivity, mergeConversation, type ConversationFilter } from "./conversation";

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

function Composer({
    placeholder,
    busy,
    compact,
    onSubmit,
    onCancel
}: {
    placeholder: string;
    busy: boolean;
    /** The reply box, which sits inside a bubble and has no send affordance of
     *  its own beyond the two buttons. */
    compact?: boolean;
    onSubmit: (body: string) => Promise<void>;
    onCancel?: () => void;
}) {
    const [body, setBody] = useState("");
    /** Bumped after each send, to give the editor a fresh one to draw. */
    const [sent, setSent] = useState(0);

    const submit = async (text = body) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        await onSubmit(trimmed);
        setBody("");
        setSent((count) => count + 1);
    };

    return (
        <div className="flex flex-col gap-2">
            <RichTextEditor
                // Remounted after a send, which is what clears the surface: the
                // editor holds its own document and does not empty itself
                // because the string behind it did.
                key={sent}
                value={body}
                bordered
                placeholder={placeholder}
                onChange={setBody}
                // Enter sends, shift+enter breaks the line: the shape people
                // already have in their fingers from every chat client.
                onSubmit={(next) => void submit(next)}
            />
            <div className="flex items-center gap-2">
                <Button size="sm" disabled={busy || !body.trim()} onClick={() => void submit()}>
                    <SendHorizontal className="size-3.5" />
                    Send
                </Button>
                {onCancel && (
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                {!compact && (
                    <span className="text-[11px] text-muted-foreground">Enter sends, shift+enter for a new line</span>
                )}
            </div>
        </div>
    );
}

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

    const post = async (body: string, parentId: string | null) => {
        setBusy(true);
        onError("");
        const result = await runAction(() => actions.addCommentAction({ taskId, body, parentId }), onError);
        if (result?.error) onError(result.error);
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
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground ring-1 ring-border">
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
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500">
                            <CheckCircle2 className="size-3" /> Resolved
                        </span>
                    )}
                </div>
                <RichText value={comment.body} className="break-words text-foreground/90" />
                <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
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
                    <div className="mt-2">
                        <Composer
                            compact
                            placeholder="Write a reply"
                            busy={busy}
                            onSubmit={(body) => post(body, comment.id)}
                            onCancel={() => setReplyTo(null)}
                        />
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
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
                className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
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
                <Composer placeholder="Write a comment" busy={busy} onSubmit={(body) => post(body, null)} />
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
                            {entry.billable && <span className="text-[11px] text-emerald-500">billable</span>}
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
