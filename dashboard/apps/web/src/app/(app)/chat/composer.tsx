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
 */

import { X } from "lucide-react";
import { Button } from "@polaris/ui";
import { typingAction } from "./actions";
import { useEffect, useRef, useState } from "react";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";

/** How often, at most, the server is told somebody is typing. */
const TYPING_EVERY_MS = 2500;

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
    onSend: (body: string) => void | Promise<void>;
    onSaveEdit?: (messageId: string, body: string) => void | Promise<void>;
    onCancelEdit?: () => void;
}) {
    const [body, setBody] = useState("");
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
        if (!text || disabled) return;
        setBody("");
        setGeneration((current) => current + 1);
        if (editing && onSaveEdit) await onSaveEdit(editing.id, text);
        else await onSend(text);
    };

    const announce = () => {
        const now = Date.now();
        if (now - lastAnnounced.current < TYPING_EVERY_MS) return;
        lastAnnounced.current = now;
        void typingAction(channelId);
    };

    return (
        <div className="shrink-0 border-t border-border p-3">
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
