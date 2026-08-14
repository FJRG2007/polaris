"use client";

/**
 * A thread on anything.
 *
 * Deliberately plainer than the one Tasks draws. That one carries replies,
 * resolving, handing a comment to somebody and the time logged against the task,
 * because a task is a unit of work people negotiate over. A server or a service
 * is a thing people leave notes on - "restarted this, the disk was full", "do
 * not redeploy until Friday" - and a thread with five affordances on every line
 * would be furniture around a sentence.
 *
 * Whoever renders this decides who may delete what and hands in `canModerate`;
 * the author can always remove their own.
 */

import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { Trash2, MessageSquare } from "lucide-react";
import { Button, EmptyState, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { CommentView } from "@/lib/comments/comments";
import { RichText } from "@/components/rich-text/rich-text";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";

export function Discussion({
    comments,
    currentUserId,
    canModerate = false,
    busy = false,
    placeholder = "Leave a note",
    onPost,
    onDelete,
    className
}: {
    comments: readonly CommentView[] | null;
    /** Who is reading, so they can remove what they said. Omitted where everybody
     *  who reaches the thread moderates it anyway - a service's notes are only
     *  reachable by its owner. */
    currentUserId?: string;
    canModerate?: boolean;
    busy?: boolean;
    placeholder?: string;
    onPost: (body: string) => Promise<void>;
    onDelete: (commentId: string) => Promise<void>;
    className?: string;
}) {
    const [body, setBody] = useState("");
    /** Bumped after each send, which is what clears the editor: it holds its own
     *  document and does not empty itself because the string behind it did. */
    const [sent, setSent] = useState(0);

    const submit = async (text = body) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        await onPost(trimmed);
        setBody("");
        setSent((count) => count + 1);
    };

    return (
        <div className={cn("flex flex-col gap-4", className)}>
            {comments === null ? null : comments.length === 0 ? (
                <EmptyState
                    bare
                    icon={<MessageSquare />}
                    title="Nothing said about this yet."
                    description="Notes here are for whoever looks after it next, including you."
                />
            ) : (
                <ol className="flex flex-col gap-4">
                    {comments.map((comment) => (
                        <li key={comment.id} className="flex gap-2.5">
                            {comment.author ? (
                                <Avatar person={comment.author} size={26} />
                            ) : (
                                <span className="inline-flex size-[26px] shrink-0 items-center justify-center rounded-full bg-muted text-[10px] text-foreground-subtle">
                                    AUT
                                </span>
                            )}
                            <div className="group min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <span className="text-[13px] font-medium">
                                        {comment.author?.name ?? "Polaris"}
                                    </span>
                                    <span className="text-[11px] text-foreground-subtle">
                                        <RelativeTime iso={comment.createdAt} />
                                    </span>
                                    {canModerate || comment.author?.id === currentUserId ? (
                                        <button
                                            type="button"
                                            title="Delete this note"
                                            aria-label="Delete this note"
                                            onClick={() => void onDelete(comment.id)}
                                            className="ml-auto text-foreground-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    ) : null}
                                </div>
                                <RichText value={comment.body} className="break-words text-[13px] text-foreground/90" />
                            </div>
                        </li>
                    ))}
                </ol>
            )}

            <div className="flex flex-col gap-2">
                <RichTextEditor
                    key={sent}
                    value={body}
                    bordered
                    placeholder={placeholder}
                    onChange={setBody}
                    // Enter sends, shift+enter breaks the line: the shape people
                    // already have in their fingers from every chat client.
                    onSubmit={(next) => void submit(next)}
                />
                <Button
                    size="sm"
                    className="self-start"
                    disabled={busy || !body.trim()}
                    onClick={() => void submit()}
                >
                    Post
                </Button>
            </div>
        </div>
    );
}
