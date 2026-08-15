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

import { Button, cn } from "@polaris/ui";
import { typingAction } from "./actions";
import { Paperclip, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";

/** How often, at most, the server is told somebody is typing. */
const TYPING_EVERY_MS = 2500;

/** What the route accepts on one message. Repeated here so the field stops
 *  accepting them rather than letting somebody stage twelve and be refused. */
const MAX_FILES = 10;

export function Composer({
    channelId,
    disabled,
    placeholder,
    editing,
    onSend,
    onSaveEdit,
    onCancelEdit
}: {
    channelId: string;
    disabled: boolean;
    placeholder: string;
    /** The message being rewritten, if any. */
    editing?: ChatMessageView | null;
    /** Files come back alongside the text. Empty for the ordinary case, which is
     *  why the caller can still take the fast optimistic path when it is. */
    onSend: (body: string, files: readonly File[]) => void | Promise<void>;
    onSaveEdit?: (messageId: string, body: string) => void | Promise<void>;
    onCancelEdit?: () => void;
}) {
    const [body, setBody] = useState("");
    const [files, setFiles] = useState<readonly File[]>([]);
    const [dragging, setDragging] = useState(false);
    const picker = useRef<HTMLInputElement>(null);
    // Bumped to rebuild the editor, which is how it is cleared: the editor owns
    // its document, and setting the value prop back to "" does not empty it.
    const [generation, setGeneration] = useState(0);
    const lastAnnounced = useRef(0);

    useEffect(() => {
        if (!editing) return;
        setBody(editing.body);
        setGeneration((current) => current + 1);
    }, [editing]);

    const submit = async (value: string) => {
        const text = value.trim();
        // A message that is only a file is a message. Making somebody type
        // "here" before they can send a screenshot is a tax on the common case.
        if (disabled || (!text && files.length === 0)) return;
        const sending = files;
        setBody("");
        setFiles([]);
        setGeneration((current) => current + 1);
        if (editing && onSaveEdit) await onSaveEdit(editing.id, text);
        else await onSend(text, sending);
    };

    const stage = (picked: FileList | null): void => {
        if (!picked || picked.length === 0) return;
        setFiles((current) => [...current, ...Array.from(picked)].slice(0, MAX_FILES));
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
            {editing && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1 text-xs">
                    <span className="text-muted-foreground">Editing a message</span>
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

            <RichTextEditor
                key={generation}
                value={body}
                bordered
                disabled={disabled}
                placeholder={placeholder}
                onChange={(next) => {
                    setBody(next);
                    if (!disabled) announce();
                }}
                onSubmit={(next) => void submit(next)}
            />

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

            {!editing && (
                <div className="mt-2 flex items-center gap-2">
                    <button
                        type="button"
                        disabled={disabled || files.length >= MAX_FILES}
                        onClick={() => picker.current?.click()}
                        aria-label="Attach a file"
                        title="Attach a file"
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                        <Paperclip className="size-4" />
                    </button>
                    {files.length > 0 && (
                        <Button size="xs" onClick={() => void submit(body)}>
                            Send
                        </Button>
                    )}
                </div>
            )}

            {editing && (
                <div className="mt-2 flex gap-2">
                    <Button size="xs" onClick={() => void submit(body)}>
                        Save
                    </Button>
                    <Button size="xs" variant="ghost" onClick={onCancelEdit}>
                        Cancel
                    </Button>
                </div>
            )}
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
