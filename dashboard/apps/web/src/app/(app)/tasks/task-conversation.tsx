"use client";

/**
 * The talking and the timing: comments, tracked time, and the history trail.
 *
 * Comments are threaded one level deep on purpose. A reply to a reply is how a
 * task turns into a forum, and the thing being discussed is right there at the
 * top of the panel.
 */

import { useState } from "react";
import { Avatar } from "./pickers";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { Button, cn, Input } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { CheckCircle2, CornerDownRight, Play, Square, Trash2 } from "lucide-react";
import type { ActivityView, CommentView, TimeEntryView } from "@/lib/tasks/task-service";

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function CommentComposer({
    placeholder,
    busy,
    onSubmit,
    onCancel
}: {
    placeholder: string;
    busy: boolean;
    onSubmit: (body: string) => Promise<void>;
    onCancel?: () => void;
}) {
    const [body, setBody] = useState("");

    return (
        <div className="flex flex-col gap-2">
            <textarea
                value={body}
                rows={3}
                placeholder={placeholder}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                    // Enter sends, shift+enter breaks the line: the shape people
                    // already have in their fingers from every chat client.
                    if (event.key === "Enter" && !event.shiftKey && body.trim()) {
                        event.preventDefault();
                        void onSubmit(body.trim()).then(() => setBody(""));
                    }
                }}
                className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
            />
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    disabled={busy || !body.trim()}
                    onClick={async () => {
                        await onSubmit(body.trim());
                        setBody("");
                    }}
                >
                    Comment
                </Button>
                {onCancel && (
                    <Button size="sm" variant="ghost" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <span className="text-[11px] text-muted-foreground">Enter sends, shift+enter for a new line</span>
            </div>
        </div>
    );
}

export function CommentSection({
    taskId,
    comments,
    currentUserId,
    canModerate,
    onChanged,
    onError
}: {
    taskId: string;
    comments: readonly CommentView[];
    currentUserId: string;
    canModerate: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [replyTo, setReplyTo] = useState<string | null>(null);

    const post = async (body: string, parentId: string | null) => {
        setBusy(true);
        onError("");
        const result = await runAction(() => actions.addCommentAction({ taskId, body, parentId }), onError);
        if (result?.error) onError(result.error);
        setBusy(false);
        setReplyTo(null);
        onChanged();
    };

    const roots = comments.filter((comment) => !comment.parentId);
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
                <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{comment.body}</p>
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
                            className="hover:text-destructive"
                        >
                            Delete
                        </button>
                    )}
                </div>

                {replyTo === comment.id && (
                    <div className="mt-2">
                        <CommentComposer
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
        <section className="flex flex-col gap-4">
            <h3 className="text-sm font-medium">Comments</h3>
            <CommentComposer placeholder="Add a comment" busy={busy} onSubmit={(body) => post(body, null)} />

            {roots.length === 0 && <p className="text-xs text-muted-foreground">Nothing said about this yet.</p>}
            <div className="flex flex-col gap-4">
                {roots.map((comment) => (
                    <div key={comment.id} className="flex flex-col gap-3">
                        {bubble(comment, false)}
                        {repliesOf(comment.id).map((reply) => bubble(reply, true))}
                    </div>
                ))}
            </div>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function TimeSection({
    taskId,
    entries,
    estimate,
    timerRunningHere,
    currentUserId,
    canModerate,
    onChanged,
    onError
}: {
    taskId: string;
    entries: readonly TimeEntryView[];
    /** Minutes, so the panel can say how much of it has gone. */
    estimate: number | null;
    timerRunningHere: boolean;
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
                    {used !== null && (
                        <span className={cn(used > 100 && "text-amber-500")}>({used}%)</span>
                    )}
                </div>
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    variant={timerRunningHere ? "danger" : "secondary"}
                    onClick={async () => {
                        onError("");
                        await runAction(
                            () => (timerRunningHere ? actions.stopTimerAction() : actions.startTimerAction(taskId)),
                            onError
                        );
                        onChanged();
                    }}
                >
                    {timerRunningHere ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                    {timerRunningHere ? "Stop timer" : "Start timer"}
                </Button>

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
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
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

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** One history line in plain language. The stored values are already resolved to
 *  names, so this is a sentence rather than a second lookup. */
function describe(line: ActivityView): string {
    const who = line.authorName ?? "A rule";
    switch (line.action) {
        case "created":
            return `${who} created this task`;
        case "status":
            return line.fromValue
                ? `${who} moved it from ${line.fromValue} to ${line.toValue ?? "another status"}`
                : `${who} set the status to ${line.toValue ?? "another status"}`;
        case "priority":
            return `${who} changed the priority from ${line.fromValue} to ${line.toValue}`;
        case "due":
            return line.toValue ? `${who} set a due date` : `${who} cleared the due date`;
        case "assignee":
            return `${who} changed who is on it`;
        case "moved":
            return `${who} moved it to another list`;
        case "archived":
            return `${who} archived it`;
        case "recurred":
            return "It recurred and was rescheduled";
        case "automation":
            return `The rule "${line.toValue}" ran`;
        case "bulk":
            return `${who} changed it along with others`;
        default:
            return `${who} changed it`;
    }
}

export function ActivitySection({ activity }: { activity: readonly ActivityView[] }) {
    if (activity.length === 0) return null;
    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">History</h3>
            <ul className="flex flex-col gap-1.5">
                {activity.map((line) => (
                    <li key={line.id} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <CornerDownRight className="mt-0.5 size-3 shrink-0 opacity-50" />
                        <span className="flex-1">{describe(line)}</span>
                        <RelativeTime iso={line.createdAt} />
                    </li>
                ))}
            </ul>
        </section>
    );
}
