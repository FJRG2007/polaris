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
import { EmojiPicker } from "./emoji-picker";
import { ClipDialog } from "./clip-dialog";
import { MicSettings } from "./mic-settings";
import { VideoPreview } from "@/components/video-preview";
import { ScheduleDialog } from "./schedule-dialog";
import { PollDialog, type PollDraft } from "./poll-dialog";
import { canRecordClip } from "./clip-recorder";
import type { ChatMessageView } from "@/lib/chat/messages";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { isBlankMarkdown } from "@/components/rich-text/markdown";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { dropDraft, keepDraft, readDraft } from "./drafts";
import {
    canRecord,
    MAX_VOICE_SECONDS,
    spokenLength,
    useVoiceRecording,
    type RecordedSound
} from "./voice-recorder";
import {
    BarChart3,
    CalendarClock,
    Camera,
    ChevronDown,
    CornerUpLeft,
    Image as ImageIcon,
    Mic,
    MicOff,
    Paperclip,
    SendHorizontal,
    Trash2,
    Video,
    X
} from "lucide-react";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger
} from "@polaris/ui";

/** How often, at most, the server is told somebody is typing. */
const TYPING_EVERY_MS = 2500;

/** How close to the length limit the counter appears. Showing it from the first
 *  character would put a number on a field nobody is near the end of. */
const COUNTER_WITHIN = 200;

export function Composer({
    channelId,
    draftKey = null,
    rules,
    disabled,
    attachable = true,
    mentionSource = null,
    inCall = false,
    placeholder,
    editing,
    replyingTo,
    replyingFrom,
    insert,
    onCancelReply,
    onTyping,
    onSend,
    onSchedule,
    onPoll,
    onMedia,
    onSaved,
    onSaveEdit,
    onCancelEdit
}: {
    /**
     * The conversation this box belongs to, or null where it is not one.
     *
     * Null is a task's comment box: nobody is watching for typing dots and there
     * is no room whose people @ should offer, so the editor asks its usual
     * question instead. Everything else this composer does - the editor, the
     * keys, the staged files, the emoji - is the same wherever it is drawn,
     * which is the whole reason there is one of these rather than three.
     */
    channelId: string | null;
    /**
     * Where an unsent message is kept for next time, or null for a box whose
     * conversation does not outlive the sitting.
     *
     * The caller decides, because only the caller knows: a channel, a group and
     * a direct message are all still there tomorrow, and the chat inside a call
     * is not. What is typed into a room that is about to stop existing is a
     * message that was not sent, not a draft - see `drafts`.
     */
    draftKey?: string | null;
    /** What this kind of conversation allows: how long a message may be, how
     *  many files it may carry and how big one may be. Enforced again on the
     *  server; here so a limit is met while typing rather than after a
     *  40 MB upload somebody waited for. */
    rules: core.ChatRules;
    disabled: boolean;
    /** Whether this account may put files in a conversation at all - a grant,
     *  where the rules above are the instance's ceiling for everybody. Passed in
     *  rather than read from the chat's own context, because this composer is
     *  also the one under a task, where there is no such context. */
    attachable?: boolean;
    /** Where @ looks, for a surface whose roster is not a conversation's - a
     *  call, where half the room are guests. Left unset everywhere else, and the
     *  editor asks the usual question. */
    mentionSource?: React.ComponentProps<typeof RichTextEditor>["mentionSource"];
    /**
     * Whether this box is inside a call.
     *
     * Everything it changes is the same fact wearing different clothes. The picker
     * offers emoji and nothing else, because the GIF search and the kept pictures
     * belong to an account and half a call has none. A question asked here has no
     * clock of its own, because the call is the clock. Nothing announces that
     * somebody is typing, because there is nowhere in a call that would draw it
     * and no session for a guest to announce under. And neither the microphone
     * nor the screen recorder is offered, because both of those are already on
     * the table - the room is the recording.
     */
    inCall?: boolean;
    /**
     * Say that somebody is writing.
     *
     * Passed in rather than reached for, and for the same reason `attachable` is:
     * this box is also the one under a task, where there is no conversation to
     * announce into and nothing that would draw the answer. Reaching for the
     * chat's own actions here would put the chat's server module in the import
     * graph of every surface that draws this box.
     *
     * `kind` is "recording" while a voice note is being made, which the other
     * side reads differently to typing.
     */
    onTyping?: (kind?: "recording") => void;
    placeholder: string;
    /** The message being rewritten, if any. */
    editing?: ChatMessageView | null;
    /** The message being answered, if any. Shown above the field so nobody
     *  sends a reply having forgotten what it answers. */
    replyingTo?: ChatMessageView | null;
    /**
     * Where the message being answered was said, when that is not here.
     *
     * Only ever set for a private answer: somebody has been brought to a
     * conversation with one person in order to reply to something said in a room
     * of thirty, and without this the bar says a name and a line of text with no
     * hint of which of today's four channels it came out of.
     */
    replyingFrom?: { name: string; channel: boolean } | null;
    /**
     * Something to drop into the box, from outside it.
     *
     * A mention picked off the roster or off a name in the messages, which is how
     * every client does it: press a name and it lands in what you were writing
     * rather than opening something. The token is what says "again" - the same
     * text twice is two mentions, and comparing the text itself would silently
     * swallow the second.
     *
     * Handed straight to the editor rather than spliced into the text here. It
     * used to be appended to the end with the document rebuilt around it, which
     * threw away where somebody was in the middle of a sentence: the name landed
     * after the full stop and the caret went with it. The document is the only
     * thing that knows where the writer left off - see `RichTextEditor`.
     */
    insert?: { token: number; text: string } | null;
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
    /**
     * The same message, at an hour that has not happened yet.
     *
     * Absent where sending later makes no sense - a task's comment box, an edit -
     * and then the control is not drawn rather than drawn doing nothing. Answers
     * with a sentence when the server refuses, since the dialog is still open and
     * is the only place the person can read it.
     */
    onSchedule?: (
        sendAt: string,
        body: string,
        files: readonly File[]
    ) => Promise<{ error?: string }>;
    /**
     * Ask a question with answers under it.
     *
     * Absent where a poll makes no sense - a task's comment box, an edit - and
     * then the button is not drawn rather than drawn doing nothing. Answers with
     * a sentence when the server refuses, since the dialog is still open and is
     * the only place the person can read it.
     */
    onPoll?: (draft: PollDraft) => Promise<{ error?: string }>;
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
    /** Whether the "when" dialog is open, and what the server said about the
     *  last moment offered to it. */
    const [scheduling, setScheduling] = useState(false);
    const [scheduleBusy, setScheduleBusy] = useState(false);
    const [scheduleError, setScheduleError] = useState("");
    /** The same three for the poll dialog, which is the other thing this box
     *  sends that is not a line of text. */
    const [polling, setPolling] = useState(false);
    const [pollBusy, setPollBusy] = useState(false);
    const [pollError, setPollError] = useState("");
    // Two different noes with one answer on screen: the instance allows no files
    // in this kind of conversation, or this account may not send them anywhere.
    // Gone rather than disabled either way - a permanently dead button is a
    // promise the room cannot keep.
    const mayAttach = attachable && rules.maxAttachments > 0;
    const [dragging, setDragging] = useState(false);
    const picker = useRef<HTMLInputElement>(null);
    const gallery = useRef<HTMLInputElement>(null);
    const camera = useRef<HTMLInputElement>(null);
    // Whether this is something held in a hand, which is the only place a camera
    // button belongs: `capture` on a laptop opens the same file dialog as every
    // other picker, so the button would be a second paperclip wearing a camera.
    const [handheld, setHandheld] = useState(false);
    useEffect(() => {
        setHandheld(typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches);
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

    // The same question about the screen. Separate from the one above because
    // the answer is different on a phone, which records sound perfectly well and
    // cannot share a screen at all.
    const [clippable, setClippable] = useState(false);
    useEffect(() => setClippable(canRecordClip()), []);
    const [clipping, setClipping] = useState(false);

    /**
     * What was left in this box last time, put back.
     *
     * On the key rather than on mount: one composer serves whichever
     * conversation is on screen, so walking from one to another is this effect
     * running again with a different key - which is exactly when the box should
     * change what it is holding.
     *
     * Never over an edit. Rewriting a message puts that message in the box, and
     * a draft landing on top of it would replace what somebody is correcting
     * with something they wrote yesterday.
     */
    useEffect(() => {
        if (!draftKey || editing) return;
        const kept = readDraft(draftKey);
        if (!kept) return;
        setBody(kept);
        setGeneration((current) => current + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the key, and only on the key
    }, [draftKey]);

    /**
     * Everything that is typed, kept where the tab closing cannot take it.
     *
     * Written from the editor's own change rather than from an effect on the
     * body, and that is the whole of it: the body is also set by sending, by
     * clearing and by opening an edit, and a draft written on those would put
     * back what somebody had just got rid of. Blank throws the draft away - see
     * `keepDraft`.
     */
    const write = useCallback(
        (value: string) => {
            setBody(value);
            if (draftKey && !editing) keepDraft(draftKey, value);
        },
        [draftKey, editing]
    );

    // What is being written changes when the message being rewritten changes,
    // and not when the same message arrives again: a reload that replaced the
    // object would otherwise wipe what has been typed into it. Backing out of an
    // edit puts back whatever was in the box before it started - the draft, or
    // nothing - rather than leaving the message being corrected sitting there.
    const editingId = editing?.id ?? null;
    useEffect(() => {
        setBody(editing?.body ?? (draftKey ? readDraft(draftKey) : ""));
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
     * Where it lands is the difference between the two. An edit has just replaced
     * what is in the box, so the end of it is the only sensible place. A reply
     * happens to a box somebody may be halfway through a sentence in - the way
     * everybody uses it is to type, decide it should answer something, and press
     * reply - so the caret goes back exactly where they left it.
     *
     * On the ids and nothing else. The objects are replaced whenever the
     * conversation reloads, and focusing on that would put the caret back at the
     * end of the line every time somebody else said something.
     */
    const replyingToId = replyingTo?.id ?? null;
    const [focusAt, setFocusAt] = useState(0);
    const [focusWhere, setFocusWhere] = useState<"end" | "keep">("end");
    useEffect(() => {
        if (!editingId && !replyingToId) return;
        setFocusWhere(editingId ? "end" : "keep");
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
        setFocusWhere("end");
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
            if (
                document.querySelector(
                    "[data-state='open'][role='dialog'], [data-state='open'][role='menu']"
                )
            ) {
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
        // It is somewhere that is not a browser now.
        if (draftKey && !editing) dropDraft(draftKey);
        if (editing && onSaveEdit) await onSaveEdit(editing.id, text);
        else await onSend(text, sending);
    };

    /**
     * The same message, put down for later.
     *
     * Everything is emptied only once the server has taken it, unlike sending -
     * a message that goes now is gone whatever happens next, and one that is
     * refused at the moment it is scheduled has to be left where it was typed.
     */
    const schedule = async (sendAt: string) => {
        if (!onSchedule || disabled || tooLong) return;
        const text = isBlankMarkdown(body) ? "" : body.trim();
        if (!text && files.length === 0) return;
        setScheduleBusy(true);
        setScheduleError("");
        const result = await onSchedule(sendAt, text, files);
        setScheduleBusy(false);
        if (result.error) {
            setScheduleError(result.error);
            return;
        }
        setBody("");
        setFiles([]);
        setRefused("");
        setGeneration((current) => current + 1);
        if (draftKey) dropDraft(draftKey);
        setScheduling(false);
    };

    /**
     * Send the poll.
     *
     * Nothing in the box is touched either way. A poll is its own message and
     * carries none of what somebody was halfway through typing, so emptying the
     * field on the way out would throw away a sentence they never asked to send.
     */
    const askPoll = async (draft: PollDraft) => {
        if (!onPoll || disabled) return;
        setPollBusy(true);
        setPollError("");
        const result = await onPoll(draft);
        setPollBusy(false);
        if (result.error) {
            setPollError(result.error);
            return;
        }
        setPolling(false);
    };

    /**
     * Take what fits and say what did not.
     *
     * Silently dropping the eleventh file is how somebody sends ten of the
     * twelve screenshots they meant to and finds out later.
     *
     * Answers how many it took, which is what a paste needs: a clipboard that
     * carries a picture and text at once has to keep the text when the picture is
     * refused - no permission to send files, or a message already holding as many
     * as it may - or the paste is eaten and nothing at all appears.
     */
    const stage = (picked: ArrayLike<File> | null): number => {
        if (!picked || picked.length === 0) return 0;
        // Said rather than ignored: a file dropped onto a box that quietly does
        // nothing with it reads as a broken composer.
        if (!attachable) {
            setRefused("You are not allowed to send files here.");
            return 0;
        }
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
        return accepted.length;
    };

    /** What every picker does with what came back. Cleared afterwards so
     *  choosing the same file twice in a row still fires a change. */
    const picked = (event: React.ChangeEvent<HTMLInputElement>): void => {
        stage(event.target.files);
        event.target.value = "";
    };

    const announce = () => {
        // Nobody to tell, and nobody to tell them as. A call has no typing
        // indicator, and half the people in one have no session for an action
        // that starts with `requirePermission` to run under. A comment box has
        // no conversation at all, and hands in no way to announce one.
        if (inCall || !onTyping) return;
        const now = Date.now();
        if (now - lastAnnounced.current < TYPING_EVERY_MS) return;
        lastAnnounced.current = now;
        onTyping();
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
        if (!voice.recording || disabled || inCall || !onTyping) return;
        const say = () => {
            lastAnnounced.current = Date.now();
            onTyping("recording");
        };
        say();
        const timer = setInterval(say, TYPING_EVERY_MS);
        return () => clearInterval(timer);
    }, [voice.recording, disabled, inCall, onTyping]);

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
                    {replyingFrom && (
                        <span className="shrink-0 text-muted-foreground">
                            in {replyingFrom.channel ? `#${replyingFrom.name}` : replyingFrom.name}
                        </span>
                    )}
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
                <ul className="mb-2 flex flex-wrap items-end gap-2">
                    {files.map((file, index) => (
                        <StagedFile
                            key={`${file.name}:${file.lastModified}:${index}`}
                            file={file}
                            onRemove={() =>
                                setFiles((current) => current.filter((_, at) => at !== index))
                            }
                        />
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
                                    // A fraction of the loudest moment so far, so
                                    // this reads like the waveform the message
                                    // arrives with rather than like a microphone
                                    // that is barely picking anything up.
                                    style={{
                                        height: `${Math.max(8, Math.min(100, level * 100))}%`
                                    }}
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
                        insert={insert}
                        focusAt={focusAt}
                        disabled={disabled}
                        placeholder={placeholder}
                        // @ offers the people in this conversation. Not the ones
                        // this account shares a Tasks space with, which is what
                        // it used to offer and is a different question entirely.
                        mentionsIn={channelId}
                        mentionSource={mentionSource}
                        focusWhere={focusWhere}
                        // A screenshot on the clipboard is a screenshot somebody
                        // is sending: it is staged like a picked file, with the
                        // same limits and the same preview, and nothing about it
                        // goes into the text.
                        //
                        // Only claimed when something was actually staged. A
                        // clipboard filled by copying out of a page carries the
                        // picture and the words together, so a refused file that
                        // said it took the paste threw the words away too.
                        onPasteFiles={(pasted) => {
                            if (disabled) return false;
                            return stage(pasted) > 0;
                        }}
                        onChange={write}
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
                            {mayAttach && (
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
                            {mayAttach && (
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
                            {mayAttach && handheld && (
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
                            {mayAttach && recordable && !inCall && (
                                <MicButton
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onStart={voice.start}
                                />
                            )}
                            {/* Beside the microphone, because it is the same
                                offer one step further: some things are faster
                                said than typed, and some are faster shown than
                                said. Only where a file may be sent, since what
                                it makes is one, and only in a browser that can
                                share a screen - which is no phone. */}
                            {mayAttach && clippable && !inCall && (
                                <button
                                    type="button"
                                    disabled={disabled || files.length >= rules.maxAttachments}
                                    onClick={() => setClipping(true)}
                                    aria-label="Record a video clip"
                                    title="Record a clip"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Video className="size-4" />
                                </button>
                            )}
                            {/* A question with answers under it, which is a
                                message of its own rather than something that
                                goes with what is in the box - so it opens a
                                dialog and sends from there. Not drawn at all
                                where a poll has nowhere to go. */}
                            {onPoll && (
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => {
                                        setPollError("");
                                        setPolling(true);
                                    }}
                                    aria-label="Create a poll"
                                    title="Create a poll"
                                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <BarChart3 className="size-4" />
                                </button>
                            )}
                            <EmojiPicker
                                disabled={disabled}
                                // Emoji everywhere; pictures only where there is
                                // somewhere for one to go. A comment box takes no
                                // media, and a picker offering a GIF that lands
                                // nowhere is worse than one that does not offer.
                                media={!inCall && (onMedia !== undefined || onSaved !== undefined)}
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
                                    "text-[0.6875rem] tabular-nums",
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
                            <>
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
                                {/* Beside the send button, because it is the same
                                    act at a different hour - and dead until
                                    there is something to send, since "when" is
                                    not a question about nothing.

                                    A button rather than a menu holding one item:
                                    a press that only opens a list with a single
                                    thing on it is a press nobody wanted, and the
                                    dialog it leads to is where the choosing
                                    actually happens. */}
                                {onSchedule && (
                                    <button
                                        type="button"
                                        disabled={
                                            disabled || tooLong || (blank && files.length === 0)
                                        }
                                        onClick={() => {
                                            setScheduleError("");
                                            setScheduling(true);
                                        }}
                                        aria-label="Schedule this message"
                                        title="Send later"
                                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                                    >
                                        <CalendarClock className="size-4" />
                                    </button>
                                )}
                            </>
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

            {/* Mounted only while it is open, so the dialog reads the clock at
                the moment it is asked rather than at the moment the composer was
                drawn - "tomorrow at nine" is otherwise yesterday's tomorrow on a
                tab left open overnight. */}
            {/* Mounted only while it is open: it holds a screen share, a camera
                and a recorder, and none of that may outlive the dialog. */}
            {clipping && (
                <ClipDialog
                    open
                    maxBytes={maxBytes}
                    maxMib={rules.maxAttachmentMib}
                    onOpenChange={setClipping}
                    // Staged like any other file, so a clip can go with a line of
                    // text, with other files, or at nine tomorrow morning -
                    // none of which is a special case.
                    onReady={(clip) => stage([clip])}
                />
            )}

            {polling && onPoll && (
                <PollDialog
                    open
                    // A call is the clock its own questions run on, so the
                    // dialog does not offer a second one.
                    timed={!inCall}
                    busy={pollBusy}
                    error={pollError || undefined}
                    onOpenChange={(next) => !next && setPolling(false)}
                    onConfirm={(draft) => void askPoll(draft)}
                />
            )}

            {scheduling && onSchedule && (
                <ScheduleDialog
                    open
                    busy={scheduleBusy}
                    error={scheduleError || undefined}
                    onOpenChange={(next) => !next && setScheduling(false)}
                    onConfirm={(sendAt) => void schedule(sendAt)}
                />
            )}
        </div>
    );
}

/**
 * Record, and set up what records.
 *
 * The button starts the recording and the chevron beside it opens everything
 * about the microphone - which one, how much is done to what it hears, and how
 * loud it goes out. The same shape the call controls use, and for the same
 * reason: those are decided once, and they must not slow down the thing that is
 * decided every time.
 *
 * Always there, unlike before: it used to appear only where a second microphone
 * existed, which hid the noise and level settings from every laptop with one
 * built-in microphone - the machines that need them most.
 *
 * Every choice behind it is this browser's and is shared with calls and clips:
 * see `MicSettings`.
 */
function MicButton({ disabled, onStart }: { disabled: boolean; onStart: () => void }) {
    const many = true;

    return (
        <span className="flex items-center">
            <button
                type="button"
                disabled={disabled}
                onClick={onStart}
                aria-label="Record a voice message"
                title="Record a voice message"
                className={cn(
                    "rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
                    many && "rounded-r-none pr-1"
                )}
            >
                <Mic className="size-4" />
            </button>
            {many && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            disabled={disabled}
                            aria-label="Microphone settings"
                            title="Microphone settings"
                            className="rounded rounded-l-none py-1.5 pl-0.5 pr-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                            <ChevronDown className="size-3" />
                        </button>
                    </DropdownMenuTrigger>
                    {/* Upward: the composer is at the bottom of the screen.
                        The settings are drawn rather than listed as menu items,
                        because one of them is a slider and a menu that closes on
                        every press is no place for one - a plain button inside a
                        menu surface is not an option, so nothing closes when one
                        is pressed. */}
                    <DropdownMenuContent
                        align="start"
                        side="top"
                        className="w-72"
                    >
                        <MicSettings className="p-1" />
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </span>
    );
}

/**
 * One file waiting to be sent.
 *
 * A picture is shown as the picture. "screenshot-2026-08-17-at-13-42-08.png" is
 * not a description of anything, and pasting three screenshots in a row is three
 * lines of that - which is how somebody sends the wrong one. A video is shown as
 * the video, and for a stronger version of the same reason: it was very likely
 * just recorded, and the one question anybody has about it is whether it caught
 * the right thing. Everything else is a chip with its name and size, because
 * that is all there is to say about a spreadsheet.
 *
 * The preview is a blob address made here and given back when the file goes.
 * Leaking one holds the whole file in memory for as long as the tab is open.
 */
function StagedFile({ file, onRemove }: { file: File; onRemove: () => void }) {
    const [preview, setPreview] = useState<string | null>(null);
    const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
    const watchable = WATCHABLE.has(type);

    useEffect(() => {
        // Only what the browser will actually draw. An SVG is an image and is
        // deliberately not on this list - the same rule the conversation itself
        // applies to a picture somebody uploaded.
        if (!PREVIEWABLE.has(type) && !WATCHABLE.has(type)) return;
        const address = URL.createObjectURL(file);
        setPreview(address);
        return () => {
            URL.revokeObjectURL(address);
            setPreview(null);
        };
    }, [file, type]);

    const remove = (
        <button
            type="button"
            aria-label={`Remove ${file.name}`}
            title="Remove"
            onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
            <X className="size-3" />
        </button>
    );

    if (!preview) {
        return (
            <li className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                <span className="max-w-[12rem] truncate" title={file.name}>
                    {file.name}
                </span>
                <span className="text-muted-foreground">{readableSize(file.size)}</span>
                {remove}
            </li>
        );
    }

    return (
        <li className="relative">
            {watchable ? (
                // The same player the conversation will draw around it once it is
                // sent, drawn eagerly here: these bytes are already in this
                // browser, so there is no request to save by waiting, and
                // somebody who has just recorded something wants to watch it
                // back before anybody else does.
                <VideoPreview
                    eager
                    src={preview}
                    name={file.name}
                    size={file.size}
                    className="w-64"
                />
            ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob, no loader wanted
                <img
                    src={preview}
                    alt={file.name}
                    title={`${file.name} - ${readableSize(file.size)}`}
                    className="size-20 rounded-md border border-border object-cover"
                />
            )}
            <span className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-elevated shadow-sm">
                {remove}
            </span>
        </li>
    );
}

/** What a staged file is shown as itself, rather than as its name. The same list
 *  the conversation draws inline, for the same reason: these are the formats that
 *  are pictures and cannot carry script. */
const PREVIEWABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** What is shown as a video rather than as a name. The same three the
 *  conversation plays, so what is previewed here is exactly what will play
 *  there - a file that previewed and then arrived as a download would be worse
 *  than no preview at all. */
const WATCHABLE = new Set(["video/mp4", "video/webm", "video/ogg"]);

/** A size somebody can read at a glance. Not the display-format helper: that one
 *  writes dates and money, and a file size is neither. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
