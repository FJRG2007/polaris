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
import type { ChatMessageView } from "@/lib/chat/messages";
import { useEffect, useMemo, useRef, useState } from "react";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { isBlankMarkdown } from "@/components/rich-text/markdown";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import {
    canRecord,
    MAX_VOICE_SECONDS,
    spokenLength,
    useVoiceRecording,
    type RecordedSound
} from "./voice-recorder";
import {
    Camera,
    CornerUpLeft,
    Image as ImageIcon,
    Mic,
    MicOff,
    Paperclip,
    SendHorizontal,
    Trash2,
    X
} from "lucide-react";

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
     *  why the caller can still take the fast optimistic path when it is.
     *  `sounds` carries what the browser measured for each of them, which is
     *  only ever a recording. */
    onSend: (
        body: string,
        files: readonly File[],
        sounds?: readonly RecordedSound[]
    ) => void | Promise<void>;
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
    const gallery = useRef<HTMLInputElement>(null);
    const camera = useRef<HTMLInputElement>(null);
    // Whether this is something held in a hand, which is the only place a camera
    // button belongs: `capture` on a laptop opens the same file dialog as every
    // other picker, so the button would be a second paperclip wearing a camera.
    const [handheld, setHandheld] = useState(false);
    useEffect(() => {
        setHandheld(
            typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
        );
    }, []);
    // Bumped to rebuild the editor, which is how it is cleared: the editor owns
    // its document, and setting the value prop back to "" does not empty it.
    const [generation, setGeneration] = useState(0);
    const lastAnnounced = useRef(0);

    // Asked in the browser rather than while rendering: the server has no
    // MediaRecorder, and a button that appeared only after hydration would be a
    // button that moves under somebody's finger.
    const [recordable, setRecordable] = useState(false);
    useEffect(() => setRecordable(canRecord()), []);

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
     * The caret goes where the writing is about to happen.
     *
     * Pressing reply on a message and then having to click the box is a step
     * nobody means to take - the press was the decision to write. The same for
     * an edit, where the text is already there and the cursor was not.
     *
     * On the ids and nothing else. The objects are replaced whenever the
     * conversation reloads, and focusing on that would put the caret back at the
     * end of the line every time somebody else said something.
     */
    const replyingToId = replyingTo?.id ?? null;
    const [focusAt, setFocusAt] = useState(0);
    useEffect(() => {
        if (!editingId && !replyingToId) return;
        setFocusAt((current) => current + 1);
    }, [editingId, replyingToId]);

    /**
     * Opening a conversation puts the caret in the box.
     *
     * On anything with a pointer, where the next thing somebody does is type.
     * Never on a phone: focusing a field there throws the keyboard up over half
     * the conversation before anybody has asked to write anything, and the
     * messages somebody came to read are the half it covers.
     *
     * Asked of the browser here rather than read off state, because state
     * settles a tick later and by then the keyboard is already up.
     */
    useEffect(() => {
        if (disabled || editingId) return;
        if (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) return;
        setFocusAt((current) => current + 1);
    }, [channelId, disabled, editingId]);

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

    // Whether there is anything here to send, asked of the written text rather
    // than of the stored source. Spaces and line breaks alone are not a message,
    // and they do not always serialize to an empty string.
    const blank = useMemo(() => isBlankMarkdown(body), [body]);

    /**
     * A recording goes as soon as it is stopped.
     *
     * Not staged like a picked file: somebody who has just said the thing has
     * already decided to send it, and a recording sitting in a tray waiting for
     * a second press is the shape everybody gets wrong. Cancelling is the other
     * button, and it is next to it while the recording runs.
     */
    const voice = useVoiceRecording((file, sound) => {
        if (disabled) return;
        if (file.size > maxBytes) {
            setRefused(`A recording here can be up to ${rules.maxAttachmentMib} MB.`);
            return;
        }
        setRefused("");
        void onSend("", [file], [sound]);
    });

    const submit = async (value: string) => {
        const text = isBlankMarkdown(value) ? "" : value.trim();
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

    /** What every picker does with what came back. Cleared afterwards so
     *  choosing the same file twice in a row still fires a change. */
    const picked = (event: React.ChangeEvent<HTMLInputElement>): void => {
        stage(event.target.files);
        event.target.value = "";
    };

    const announce = () => {
        const now = Date.now();
        if (now - lastAnnounced.current < TYPING_EVERY_MS) return;
        lastAnnounced.current = now;
        void typingAction(channelId);
    };

    /**
     * A recording is announced the way typing is.
     *
     * Without it the other side gets half a minute of nothing - and no dots,
     * because nobody is typing - which is indistinguishable from having been
     * left mid-conversation. Repeated on the same interval because the indicator
     * lapses after a few seconds by design, and a recording runs for minutes.
     */
    useEffect(() => {
        if (!voice.recording || disabled) return;
        const say = () => {
            lastAnnounced.current = Date.now();
            void typingAction(channelId, "recording");
        };
        say();
        const timer = setInterval(say, TYPING_EVERY_MS);
        return () => clearInterval(timer);
    }, [voice.recording, disabled, channelId]);

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

            {(refused || voice.error) && (
                <p role="alert" className="mb-2 text-xs text-danger">
                    {refused || voice.error}
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

            {voice.recording && (
                <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-border bg-field px-3 py-2">
                    {/* Said while there is still time to do something about it.
                        A recording that turns out to be silence is only ever
                        discovered by the person it was sent to. */}
                    {voice.silent && (
                        <p role="status" className="flex items-center gap-1.5 text-xs text-danger">
                            <MicOff className="size-3.5 shrink-0" />
                            Polaris is not hearing anything. Check your microphone, or that it is
                            the one your browser is using.
                        </p>
                    )}
                    <div className="flex items-center gap-2">
                        <span
                            aria-hidden="true"
                            className="size-2 shrink-0 animate-pulse rounded-full bg-danger"
                        />
                        <span className="shrink-0 text-sm font-medium tabular-nums">
                            {spokenLength(voice.seconds)}
                        </span>
                        {/* What the microphone is hearing, now. The one thing
                            that tells somebody it is working without them
                            playing anything back. */}
                        <span
                            aria-hidden="true"
                            className="flex h-6 min-w-0 flex-1 items-center gap-px overflow-hidden"
                        >
                            {voice.levels.map((level, at) => (
                                <span
                                    key={at}
                                    style={{ height: `${Math.max(8, Math.min(100, level * 260))}%` }}
                                    className={cn(
                                        "w-1 shrink-0 rounded-full",
                                        voice.silent ? "bg-border" : "bg-primary"
                                    )}
                                />
                            ))}
                        </span>
                        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                            {spokenLength(MAX_VOICE_SECONDS - voice.seconds)} left
                        </span>
                        <button
                            type="button"
                            onClick={voice.cancel}
                            aria-label="Throw this recording away"
                            title="Throw it away"
                            className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                        >
                            <Trash2 className="size-4" />
                        </button>
                        <button
                            type="button"
                            onClick={voice.stop}
                            aria-label="Send this recording"
                            title="Send it"
                            className="shrink-0 rounded p-1.5 text-primary transition-colors hover:bg-muted"
                        >
                            <SendHorizontal className="size-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* One box: the text and the controls that act on it are the same
                field, the way every chat client draws it. Buttons in a row
                underneath read as a form somebody has to fill in and submit. */}
            <div className="rounded-md border border-border bg-field transition-colors focus-within:border-border-strong">
                <div className="px-3 pt-2">
                    <RichTextEditor
                        key={generation}
                        value={body}
                        focusAt={focusAt}
                        disabled={disabled}
                        placeholder={placeholder}
                        // @ offers the people in this conversation. Not the ones
                        // this account shares a Tasks space with, which is what
                        // it used to offer and is a different question entirely.
                        mentionsIn={channelId}
                        onChange={setBody}
                        // From the keys and not from the document changing. A
                        // document changes for reasons that are not a person
                        // writing - a chip resolving its name, an extension
                        // settling as the editor mounts - and every one of those
                        // told the other side somebody was typing when they had
                        // only opened the conversation.
                        onTyping={() => {
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
                            {/* A picture is most of what anybody sends, and
                                finding it through a file dialog that offers
                                every document on the device is the long way
                                round. Filtered to images and video, which is
                                what a phone answers with its gallery. */}
                            {rules.maxAttachments > 0 && (
                                <button
                                    type="button"
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onClick={() => gallery.current?.click()}
                                    aria-label="Send a photo or video"
                                    title="Photo or video"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <ImageIcon className="size-4" />
                                </button>
                            )}
                            {/* Straight to the camera, on the devices that have
                                one worth opening. The picture is staged like any
                                other so it can still be thought better of. */}
                            {rules.maxAttachments > 0 && handheld && (
                                <button
                                    type="button"
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onClick={() => camera.current?.click()}
                                    aria-label="Take a photo or video"
                                    title="Camera"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Camera className="size-4" />
                                </button>
                            )}
                            {/* Only where a file may be sent at all, since a
                                recording is one - and only in a browser that can
                                record, rather than as a button that apologises
                                when it is pressed. */}
                            {rules.maxAttachments > 0 && recordable && (
                                <button
                                    type="button"
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onClick={voice.start}
                                    aria-label="Record a voice message"
                                    title="Record a voice message"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Mic className="size-4" />
                                </button>
                            )}
                            <EmojiPicker
                                disabled={disabled}
                                // Back to the box, caret at the end. Picking an
                                // emoji is part of writing the message, and
                                // leaving the focus on the closed picker means
                                // the next thing typed goes nowhere.
                                onEmoji={(char) => {
                                    setBody((current) => `${current}${char}`);
                                    setFocusAt((current) => current + 1);
                                }}
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
                                <Button
                                    size="xs"
                                    disabled={tooLong || (blank && files.length === 0)}
                                    onClick={() => void submit(body)}
                                >
                                    Save
                                </Button>
                            </>
                        ) : (
                            <button
                                type="button"
                                disabled={disabled || tooLong || (blank && files.length === 0)}
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

            {/* Three pickers rather than one that is reconfigured: setting
                `accept` and `capture` on the way to a click is a change the
                browser is not obliged to have applied by the time the dialog
                opens, and on a phone that is the difference between the gallery
                and the camera. */}
            <input ref={picker} type="file" multiple className="hidden" onChange={picked} />
            <input
                ref={gallery}
                type="file"
                multiple
                accept="image/*,video/*"
                className="hidden"
                onChange={picked}
            />
            <input
                ref={camera}
                type="file"
                accept="image/*,video/*"
                capture="environment"
                className="hidden"
                onChange={picked}
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
