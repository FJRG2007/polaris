"use client";

/**
 * Where you type.
 *
 * The same editor as every other writing surface in Polaris, so @ mentions a
 * person and # references a task here exactly as it does in a note or a comment,
 * and text pasted between them keeps its chips. Enter sends and shift-Enter
 * breaks the line - the shape people already have in their fingers.
 *
 * Editing reuses this rather than growing a second editor inside the message
 * row. One composer means one set of keys, one set of mention behaviour and one
 * place a bug can be; an inline editor means two of each.
 *
 * Typing is announced on an interval rather than per keystroke. The indicator is
 * a courtesy, and paying a request per character for it is not.
 *
 * Files are staged rather than uploaded as they are picked: nothing is written
 * until the message is sent, so changing your mind costs nothing and leaves
 * nothing behind. Dropping a file onto the conversation stages it too, which is
 * how most people expect to send a screenshot.
 */

import * as core from "@polaris/core";
import { Button, cn } from "@polaris/ui";
import { typingAction } from "./actions";
import { EmojiPicker } from "./emoji-picker";
import { useEffect, useRef, useState } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { CornerUpLeft, Paperclip, SendHorizontal, X } from "lucide-react";

/** How often, at most, the server is told somebody is typing. */
const TYPING_EVERY_MS = 2500;

/** How close to the length limit the counter appears. Showing it from the first
 *  character would put a number on a field nobody is near the end of. */
const COUNTER_WITHIN = 200;

export function Composer({
    channelId,
    rules,
    disabled,
    placeholder,
    editing,
    replyingTo,
    onCancelReply,
    onSend,
    onMedia,
    onSaved,
    onSaveEdit,
    onCancelEdit
}: {
    channelId: string;
    /** What this kind of conversation allows: how long a message may be, how
     *  many files it may carry and how big one may be. Enforced again on the
     *  server; here so a limit is met while typing rather than after a
     *  40 MB upload somebody waited for. */
    rules: core.ChatRules;
    disabled: boolean;
    placeholder: string;
    /** The message being rewritten, if any. */
    editing?: ChatMessageView | null;
    /** The message being answered, if any. Shown above the field so nobody
     *  sends a reply having forgotten what it answers. */
    replyingTo?: ChatMessageView | null;
    onCancelReply?: () => void;
    /** Files come back alongside the text. Empty for the ordinary case, which is
     *  why the caller can still take the fast optimistic path when it is. */
    onSend: (body: string, files: readonly File[]) => void | Promise<void>;
    /** A GIF or sticker chosen from the picker. Its own path rather than a
     *  staged file: it is already somewhere, and it is the whole message. */
    onMedia?: (address: string) => void | Promise<void>;
    /** One the reader kept, by its id. Its own path again, because a picture
     *  already stored here is copied rather than fetched back off Polaris. */
    onSaved?: (savedId: string) => void | Promise<void>;
    onSaveEdit?: (messageId: string, body: string) => void | Promise<void>;
    onCancelEdit?: () => void;
}) {
    const [body, setBody] = useState("");
    const [files, setFiles] = useState<readonly File[]>([]);
    const [refused, setRefused] = useState("");
    const [dragging, setDragging] = useState(false);
    const picker = useRef<HTMLInputElement>(null);
    // Bumped to rebuild the editor, which is how it is cleared: the editor owns
    // its document, and setting the value prop back to "" does not empty it.
    const [generation, setGeneration] = useState(0);
    const lastAnnounced = useRef(0);

    // What is being written changes when the message being rewritten changes,
    // and not when the same message arrives again: a reload that replaced the
    // object would otherwise wipe what has been typed into it. Backing out of an
    // edit empties the box rather than leaving the old text in it as a draft.
    const editingId = editing?.id ?? null;
    useEffect(() => {
        setBody(editing?.body ?? "");
        setGeneration((current) => current + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately the id
    }, [editingId]);

    /**
     * Escape backs out.
     *
     * The edit first, then the reply, because that is the order they were
     * entered. Bound to the page rather than to the box so it works wherever the
     * pointer went; a dialog or a menu that is open owns the key first, and
     * closing that is what somebody pressing it meant.
     */
    useEffect(() => {
        if (!editing && !replyingTo) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (document.querySelector("[data-state='open'][role='dialog'], [data-state='open'][role='menu']")) {
                return;
            }
            event.preventDefault();
            if (editing) onCancelEdit?.();
            else onCancelReply?.();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [editing, replyingTo, onCancelEdit, onCancelReply]);

    // Code points rather than length, so the count matches the one the server
    // makes: an emoji is one character to the person typing it and two to
    // JavaScript.
    const typed = [...body.trim()].length;
    const tooLong = typed > rules.maxMessageLength;
    const maxBytes = rules.maxAttachmentMib * 1024 * 1024;

    const submit = async (value: string) => {
        const text = value.trim();
        // A message that is only a file is a message. Making somebody type
        // "here" before they can send a screenshot is a tax on the common case.
        if (disabled || tooLong || (!text && files.length === 0)) return;
        const sending = files;
        setBody("");
        setFiles([]);
        setRefused("");
        setGeneration((current) => current + 1);
        if (editing && onSaveEdit) await onSaveEdit(editing.id, text);
        else await onSend(text, sending);
    };

    /**
     * Take what fits and say what did not.
     *
     * Silently dropping the eleventh file is how somebody sends ten of the
     * twelve screenshots they meant to and finds out later.
     */
    const stage = (picked: FileList | null): void => {
        if (!picked || picked.length === 0) return;
        const chosen = Array.from(picked);
        const room = Math.max(0, rules.maxAttachments - files.length);
        const small = chosen.filter((file) => file.size <= maxBytes);
        const accepted = small.slice(0, room);

        const notes: string[] = [];
        if (small.length < chosen.length) {
            notes.push(`Files here can be up to ${rules.maxAttachmentMib} MB.`);
        }
        if (accepted.length < small.length) {
            notes.push(
                rules.maxAttachments === 0
                    ? "Files cannot be sent here."
                    : `A message can carry ${rules.maxAttachments} files.`
            );
        }
        setRefused(notes.join(" "));
        if (accepted.length > 0) setFiles((current) => [...current, ...accepted]);
    };

    const announce = () => {
        const now = Date.now();
        if (now - lastAnnounced.current < TYPING_EVERY_MS) return;
        lastAnnounced.current = now;
        void typingAction(channelId);
    };

    return (
        <div
            onDragOver={(event) => {
                if (disabled) return;
                event.preventDefault();
                setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
                if (disabled) return;
                event.preventDefault();
                setDragging(false);
                stage(event.dataTransfer.files);
            }}
            className={cn(
                "shrink-0 border-t border-border p-3 transition-colors",
                dragging && "bg-primary/10"
            )}
        >
            {replyingTo && !editing && (
                <div className="mb-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    <CornerUpLeft className="size-3 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-muted-foreground">Replying to</span>
                    <span className="shrink-0 font-medium">
                        {replyingTo.authorName ?? "somebody who has left"}
                    </span>
                    {/* The words, not the Markdown. Answering a code block used
                        to fill this bar with backticks and a language tag. */}
                    <span
                        className="min-w-0 flex-1 truncate text-muted-foreground"
                        title={plainExcerpt(replyingTo.body, 200)}
                    >
                        {plainExcerpt(replyingTo.body, 200)}
                    </span>
                    <button
                        type="button"
                        aria-label="Stop replying"
                        onClick={onCancelReply}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}

            {editing && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    <span className="text-muted-foreground">
                        Editing a message
                        <span className="hidden text-foreground-subtle sm:inline">
                            {" - escape to cancel"}
                        </span>
                    </span>
                    <button
                        type="button"
                        aria-label="Stop editing"
                        onClick={onCancelEdit}
                        className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                        <X className="size-3.5" />
                    </button>
                </div>
            )}

            {refused && (
                <p role="alert" className="mb-2 text-xs text-danger">
                    {refused}
                </p>
            )}

            {files.length > 0 && (
                <ul className="mb-2 flex flex-wrap gap-1">
                    {files.map((file, index) => (
                        <li
                            key={`${file.name}:${index}`}
                            className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                        >
                            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                            <span className="max-w-[12rem] truncate" title={file.name}>
                                {file.name}
                            </span>
                            <span className="text-muted-foreground">{readableSize(file.size)}</span>
                            <button
                                type="button"
                                aria-label={`Remove ${file.name}`}
                                onClick={() =>
                                    setFiles((current) => current.filter((_, at) => at !== index))
                                }
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <X className="size-3" />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {/* One box: the text and the controls that act on it are the same
                field, the way every chat client draws it. Buttons in a row
                underneath read as a form somebody has to fill in and submit. */}
            <div className="rounded-md border border-border bg-field transition-colors focus-within:border-border-strong">
                <div className="px-3 pt-2">
                    <RichTextEditor
                        key={generation}
                        value={body}
                        disabled={disabled}
                        placeholder={placeholder}
                        onChange={(next) => {
                            setBody(next);
                            if (!disabled) announce();
                        }}
                        onSubmit={(next) => void submit(next)}
                    />
                </div>

                <div className="flex items-center gap-0.5 px-2 pb-1.5">
                    {!editing && (
                        <>
                            {/* Gone rather than disabled where the instance
                                allows no files at all: a permanently dead
                                button is a promise the room cannot keep. */}
                            {rules.maxAttachments > 0 && (
                                <button
                                    type="button"
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onClick={() => picker.current?.click()}
                                    aria-label="Attach a file"
                                    title="Attach a file"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Paperclip className="size-4" />
                                </button>
                            )}
                            <EmojiPicker
                                disabled={disabled}
                                onEmoji={(char) => setBody((current) => `${current}${char}`)}
                                onMedia={(address) => void onMedia?.(address)}
                                onSaved={(savedId) => void onSaved?.(savedId)}
                            />
                        </>
                    )}

                    <span className="ml-auto flex items-center gap-2">
                        {typed > rules.maxMessageLength - COUNTER_WITHIN && (
                            <span
                                className={cn(
                                    "text-[11px] tabular-nums",
                                    tooLong ? "text-danger" : "text-muted-foreground"
                                )}
                            >
                                {typed}/{rules.maxMessageLength}
                            </span>
                        )}
                        {editing ? (
                            <>
                                <Button size="xs" variant="ghost" onClick={onCancelEdit}>
                                    Cancel
                                </Button>
                                <Button size="xs" disabled={tooLong} onClick={() => void submit(body)}>
                                    Save
                                </Button>
                            </>
                        ) : (
                            <button
                                type="button"
                                disabled={disabled || tooLong || (!body.trim() && files.length === 0)}
                                onClick={() => void submit(body)}
                                aria-label="Send"
                                title="Send"
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                            >
                                <SendHorizontal className="size-4" />
                            </button>
                        )}
                    </span>
                </div>
            </div>

            <input
                ref={picker}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                    stage(event.target.files);
                    // Cleared so picking the same file twice in a row still
                    // fires a change.
                    event.target.value = "";
                }}
            />
        </div>
    );
}

/** A size somebody can read at a glance. Not the display-format helper: that one
 *  writes dates and money, and a file size is neither. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
