"use client";

/**
 * The messages themselves.
 *
 * Grouped the way every chat client groups them: three messages from the same
 * person a minute apart are one block with one name and one face, not three
 * headers. That is not decoration - the repeated header is what makes a busy
 * channel unreadable, because the eye has to skip past the same name to reach
 * each new line.
 *
 * A day separator sits between days. Timestamps are relative ("4 minutes ago"),
 * which is what somebody reading a conversation wants; the exact time is on the
 * hover, which is what somebody quoting one wants.
 *
 * Deleted messages leave a line saying so rather than vanishing. A conversation
 * where replies suddenly answer nothing is worse than one that admits something
 * was taken back.
 */

import * as actions from "./actions";
import { VoiceNote } from "./voice-note";
import { Avatar } from "@/components/avatar";
import { MessageMenu } from "./message-menu";
import { ReportDialog } from "./report-dialog";
import { usableAccent } from "@/lib/chat/accent";
import { useEffect, useRef, useState } from "react";
import { autoplaying, embedFor } from "@/lib/chat/embeds";
import { EditHistoryDialog } from "./edit-history-dialog";
import { RelativeTime } from "@/components/relative-time";
import { MessageInfoDialog } from "./message-info-dialog";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { isPlayable, isVoiceMessage } from "./voice-recorder";
import { useDisplayFormat } from "@/components/display-format";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    keepFocusOnClose
} from "@polaris/ui";
import {
    Check,
    CheckCheck,
    CornerUpLeft,
    MessageSquare,
    Paperclip,
    Pencil,
    Play,
    SmilePlus,
    Star,
    Trash2
} from "lucide-react";

/** How close together two messages have to be to share a header. Long enough
 *  that a paused sentence stays one block, short enough that coming back an hour
 *  later starts a new one. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** The emoji the hover offers without opening anything. Six, because a row of
 *  six is read at a glance and a row of thirty is a menu with no lid. */
const QUICK_EMOJI = ["👍", "❤️", "😄", "🎉", "👀", "✅"] as const;

export interface MessageListProps {
    messages: readonly ChatMessageView[];
    viewerId: string;
    /** False in an archived conversation: everything is still readable, nothing
     *  is actionable. */
    canPost: boolean;
    /** True for somebody who moderates the channel, who may delete anybody's. */
    canModerate: boolean;
    /** Absent inside a thread, where a reply has nowhere further to go. */
    onOpenThread?: (message: ChatMessageView) => void;
    onReact: (messageId: string, emoji: string) => void;
    onStar: (message: ChatMessageView) => void;
    /**
     * Absent inside a thread, which is already the reply.
     *
     * Optional for the same reason `onOpenThread` is: a control that is drawn and
     * does nothing is worse than one that is not there. These three used to be
     * passed as empty functions by the thread panel, so it carried a Reply
     * button, a Forward item and an Edit item that all quietly did nothing.
     */
    onReply?: (message: ChatMessageView) => void;
    onForward?: (message: ChatMessageView) => void;
    onEdit?: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
    /** A message to point at, after arriving from a search result. It fades on
     *  its own: a highlight that stays is a highlight somebody has to dismiss. */
    highlightId?: string | null;
}

export function MessageList({
    messages,
    viewerId,
    canPost,
    canModerate,
    highlightId,
    onOpenThread,
    onReact,
    onStar,
    onReply,
    onForward,
    onEdit,
    onDelete
}: MessageListProps) {
    useMessageKeys({ messages, viewerId, canPost, canModerate, onReply, onEdit, onDelete });

    // The picture being looked at, held here rather than in each message: one
    // viewer is open at a time, and it is drawn over the whole conversation.
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    const [reporting, setReporting] = useState<string | null>(null);
    const [explaining, setExplaining] = useState<ChatMessageView | null>(null);

    return (
        <ol className="flex flex-col">
            {messages.map((message, index) => {
                const previous = index > 0 ? messages[index - 1] : undefined;
                const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
                const grouped = sharesBlock(previous, message);

                return (
                    <li
                        key={message.id}
                        // Addressable, so a search result can be scrolled to.
                        id={`message-${message.id}`}
                        className={cn(
                            "transition-colors duration-500",
                            message.id === highlightId && "bg-primary/10"
                        )}
                    >
                        {newDay && <DaySeparator iso={message.createdAt} />}
                        <Message
                            message={message}
                            grouped={grouped}
                            // The ticks go under the last message of a block and
                            // nowhere else. Somebody who has read the newest of
                            // five messages in a row has read the other four,
                            // and five ticks say that five times.
                            lastOfBlock={!sharesBlock(message, messages[index + 1])}
                            mine={message.authorId === viewerId}
                            onOpenImage={setViewing}
                            onReport={(target) => setReporting(target.id)}
                            onExplain={setExplaining}
                            canPost={canPost}
                            canModerate={canModerate}
                            onOpenThread={onOpenThread}
                            onReact={onReact}
                            onStar={onStar}
                            onReply={onReply}
                            onForward={onForward}
                            onEdit={onEdit}
                            onDelete={onDelete}
                        />
                    </li>
                );
            })}

            <ImageViewer
                image={viewing}
                onClose={() => setViewing(null)}
                // Absent inside a thread, where forwarding is left to the
                // channel: the viewer draws no Forward item rather than one
                // that does nothing.
                onForward={
                    onForward &&
                    ((messageId) => {
                        const found = messages.find((entry) => entry.id === messageId);
                        if (!found) return;
                        setViewing(null);
                        onForward(found);
                    })
                }
                onReport={(messageId) => {
                    setViewing(null);
                    setReporting(messageId);
                }}
            />
            <ReportDialog
                messageId={reporting}
                body={messages.find((entry) => entry.id === reporting)?.body ?? ""}
                open={reporting !== null}
                onOpenChange={(next) => !next && setReporting(null)}
            />
            <MessageInfoDialog
                message={explaining}
                onOpenChange={(next) => !next && setExplaining(null)}
            />
        </ol>
    );
}

/**
 * Whether the second of two messages joins the first's block.
 *
 * The same question in both directions: the header and the face are dropped from
 * a message that joins the one above it, and the ticks are dropped from one the
 * next message joins. Neither a tombstone nor a line Polaris wrote itself joins
 * anything - a deleted message ends the block it was in.
 */
function sharesBlock(
    previous: ChatMessageView | undefined,
    next: ChatMessageView | undefined
): boolean {
    if (!previous || !next) return false;
    if (previous.authorId === null || previous.authorId !== next.authorId) return false;
    if (previous.deleted || next.deleted) return false;
    return (
        sameDay(previous.createdAt, next.createdAt) &&
        withinWindow(previous.createdAt, next.createdAt)
    );
}

/**
 * The keys that act on the message being pointed at.
 *
 * F2 rewrites it, Delete takes it back, and R answers it - the three things the
 * hover row already offers. The row lights up on hover and carries a pencil, a
 * bin and an arrow, so what is being aimed at is never in doubt: these are
 * shortcuts to controls that are visibly there, not hidden gestures. Focus counts
 * as well as hover, so the same keys reach the same message from a keyboard.
 *
 * Delete opens the confirmation rather than doing it, exactly as the menu item
 * does. A key that removed a message on a single press would be the one gesture
 * in a conversation with no undo, reachable by leaning on a keyboard.
 *
 * All of them are ignored while a field has focus. R is a letter, and somebody
 * typing "r" in the composer means the letter every time - which is also why
 * this only ever fires with the pointer or the focus on a message.
 */
function useMessageKeys({
    messages,
    viewerId,
    canPost,
    canModerate,
    onReply,
    onEdit,
    onDelete
}: {
    messages: readonly ChatMessageView[];
    viewerId: string;
    canPost: boolean;
    canModerate: boolean;
    onReply?: (message: ChatMessageView) => void;
    onEdit?: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
}) {
    // Held in a ref so the listener is bound once rather than rebuilt on every
    // message that arrives.
    const latest = useRef({ messages, viewerId, canPost, canModerate, onReply, onEdit, onDelete });
    latest.current = { messages, viewerId, canPost, canModerate, onReply, onEdit, onDelete };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const wanted =
                event.key === "F2"
                    ? "edit"
                    : event.key === "Delete"
                      ? "delete"
                      : event.key === "r" || event.key === "R"
                        ? "reply"
                        : null;
            if (!wanted || event.metaKey || event.ctrlKey || event.altKey) return;
            const active = document.activeElement;
            if (
                active instanceof HTMLElement &&
                (active.isContentEditable ||
                    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))
            ) {
                return;
            }

            const shown = latest.current;
            if (!shown.canPost) return;
            const row =
                document.querySelector("li[id^='message-']:hover") ??
                active?.closest("li[id^='message-']");
            const id = row?.id.replace(/^message-/, "");
            const message = shown.messages.find((entry) => entry.id === id);
            if (!message || message.deleted) return;
            // A line Polaris wrote itself - somebody joined, a call started - is
            // not a message to answer, rewrite or take down.
            if (message.kind === "system") return;

            const mine = message.authorId === shown.viewerId;
            // The same rules the pencil, the bin and the arrow are drawn under,
            // so a key can never do something the screen does not offer: your own
            // to rewrite, your own or anybody's here to take down, and anything
            // at all to answer - wherever answering is offered.
            if (wanted === "edit" && (!mine || !shown.onEdit)) return;
            if (wanted === "delete" && !mine && !shown.canModerate) return;
            if (wanted === "reply" && !shown.onReply) return;
            event.preventDefault();
            if (wanted === "edit") shown.onEdit?.(message);
            else if (wanted === "reply") shown.onReply?.(message);
            else shown.onDelete(message);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, []);
}

function Message({
    message,
    grouped,
    lastOfBlock,
    mine,
    canPost,
    canModerate,
    onOpenThread,
    onReact,
    onStar,
    onReply,
    onForward,
    onEdit,
    onDelete,
    onOpenImage,
    onReport,
    onExplain
}: {
    message: ChatMessageView;
    grouped: boolean;
    /** Whether the next message starts a new block, which is where the ticks go. */
    lastOfBlock: boolean;
    mine: boolean;
    canPost: boolean;
    canModerate: boolean;
    onOpenThread?: (message: ChatMessageView) => void;
    onReact: (messageId: string, emoji: string) => void;
    onStar: (message: ChatMessageView) => void;
    onReply?: (message: ChatMessageView) => void;
    onForward?: (message: ChatMessageView) => void;
    onEdit?: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
    /** A picture on this message was pressed. Opened over the conversation
     *  rather than in a tab: a tab is the browser's viewer, with no way back and
     *  nothing to do with the picture but look at it. */
    onOpenImage: (image: ViewedImage) => void;
    onReport: (message: ChatMessageView) => void;
    /** Open the three moments behind the ticks. */
    onExplain: (message: ChatMessageView) => void;
}) {
    const format = useDisplayFormat();
    const [showingHistory, setShowingHistory] = useState(false);
    const author = message.authorName ?? "Somebody who has left";

    // Something Polaris said rather than somebody: joined, left, was added.
    // Indented to where message text starts rather than to the avatar gutter,
    // so a room reads as one column of sentences with the occasional quiet one
    // among them - the gutter is for faces, and this line has none.
    if (message.kind === "system") {
        return (
            <p className="py-1 pl-14 pr-4 text-xs text-muted-foreground">
                {message.body} <RelativeTime iso={message.createdAt} />
            </p>
        );
    }

    return (
        <MessageMenu
            actions={{
                message,
                mine,
                canPost,
                canModerate,
                onReply,
                onForward,
                onOpenThread,
                onStar,
                onEdit,
                onDelete,
                onReport,
                onExplain
            }}
        >
            {/* `data-state` arrives from the right-click menu's trigger, which this
            is. A menu opened over a dense list has to say which line it is about
            - the pointer has left the row to reach the menu, so the hover that
            told you is gone by the time you are reading the options. It is lit
            harder than a hover for the same reason: one row is picked out, and
            the pointer is somewhere else. */}
            <div
                className={cn(
                    "group relative flex gap-2 px-4 transition-colors hover:bg-card-hover/60 data-[state=open]:bg-card-hover",
                    grouped ? "py-0.5" : "pb-0.5 pt-3"
                )}
            >
                <span className="w-8 shrink-0">
                    {grouped ? (
                        <span
                            className="hidden pt-1 text-[10px] leading-4 text-foreground-subtle group-hover:block group-data-[state=open]:block"
                            title={format.dateTime(message.createdAt)}
                        >
                            {format.time(message.createdAt)}
                        </span>
                    ) : message.authorId ? (
                        <Avatar
                            openable
                            person={{ id: message.authorId, name: author }}
                            size={28}
                        />
                    ) : (
                        <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                            ?
                        </span>
                    )}
                </span>

                <div className="min-w-0 flex-1 pb-0.5">
                    {!grouped && (
                        <p className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">{author}</span>
                            <span
                                className="text-[11px] text-foreground-subtle"
                                title={format.dateTime(message.createdAt)}
                            >
                                <RelativeTime iso={message.createdAt} />
                            </span>
                        </p>
                    )}

                    {message.quote && (
                        <p className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <CornerUpLeft className="size-3 shrink-0" />
                            {message.quote.forwarded && (
                                <span className="shrink-0 font-medium">Forwarded from</span>
                            )}
                            <span className="shrink-0 font-medium text-foreground">
                                {message.quote.authorName ?? "somebody who has left"}
                            </span>
                            <span className="min-w-0 truncate" title={message.quote.excerpt}>
                                {message.quote.deleted
                                    ? "message deleted"
                                    : message.quote.excerpt || "attachment"}
                            </span>
                        </p>
                    )}

                    {message.deleted ? (
                        <p className="text-sm italic text-foreground-subtle">
                            This message was deleted.
                        </p>
                    ) : (
                        <div className="text-sm">
                            <RichText value={message.body} />
                            {/* Under the last message of a block only. Five ticks
                            down a run of five messages say the same thing five
                            times, and seeing the newest is seeing the rest. */}
                            {message.receipt && lastOfBlock && (
                                <Ticks
                                    receipt={message.receipt}
                                    onOpen={() => onExplain(message)}
                                />
                            )}
                            {message.edited && (
                                // A button, not a label: "(edited)" that cannot be
                                // opened asks the room to take the change on trust.
                                <button
                                    type="button"
                                    onClick={() => setShowingHistory(true)}
                                    title="See what it said before"
                                    className="ml-1 rounded text-[11px] text-foreground-subtle underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                                >
                                    (edited)
                                </button>
                            )}
                        </div>
                    )}

                    <LinkArea message={message} />

                    {message.attachments.length > 0 && (
                        <ul className="mt-1 flex flex-col gap-1">
                            {message.attachments.map((file) => (
                                <li key={file.id}>
                                    {file.inline ? (
                                        <KeepableImage
                                            href={`/api/chat/attachments/${file.id}`}
                                            alt={file.name}
                                            source={`attachment:${file.id}`}
                                            name={file.name}
                                            onOpen={() =>
                                                onOpenImage({
                                                    url: `/api/chat/attachments/${file.id}`,
                                                    name: file.name,
                                                    messageId: message.id,
                                                    forwardable: message.forwardable
                                                })
                                            }
                                        />
                                    ) : isPlayable(file.contentType) ? (
                                        <VoiceNote
                                            href={`/api/chat/attachments/${file.id}`}
                                            name={file.name}
                                            recorded={isVoiceMessage(file.name, file.contentType)}
                                            waveform={file.waveform}
                                            durationMs={file.durationMs}
                                        />
                                    ) : (
                                        <a
                                            href={`/api/chat/attachments/${file.id}`}
                                            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:bg-card-hover"
                                        >
                                            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                                            <span
                                                className="max-w-[16rem] truncate"
                                                title={file.name}
                                            >
                                                {file.name}
                                            </span>
                                            <span className="shrink-0 text-muted-foreground">
                                                {readableSize(file.size)}
                                            </span>
                                        </a>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}

                    {message.reactions.length > 0 && (
                        <ul className="mt-1 flex flex-wrap gap-1">
                            {message.reactions.map((reaction) => (
                                <li key={reaction.emoji}>
                                    <button
                                        type="button"
                                        disabled={!canPost}
                                        onClick={() => onReact(message.id, reaction.emoji)}
                                        aria-pressed={reaction.mine}
                                        className={cn(
                                            "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors disabled:opacity-60",
                                            reaction.mine
                                                ? "border-primary/60 bg-primary/15 text-foreground"
                                                : "border-border bg-muted text-muted-foreground hover:border-border-strong"
                                        )}
                                    >
                                        <span>{reaction.emoji}</span>
                                        <span>{reaction.count}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    {message.replyCount > 0 && onOpenThread && (
                        <button
                            type="button"
                            onClick={() => onOpenThread(message)}
                            className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                        >
                            <MessageSquare className="size-3" />
                            {message.replyCount === 1 ? "1 reply" : `${message.replyCount} replies`}
                            {message.lastReplyAt && (
                                <span className="font-normal text-muted-foreground">
                                    <RelativeTime iso={message.lastReplyAt} />
                                </span>
                            )}
                        </button>
                    )}
                </div>

                {canPost && !message.deleted && (
                    <div className="absolute right-3 top-0 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border bg-elevated p-0.5 shadow-popover group-focus-within:flex group-hover:flex group-data-[state=open]:flex">
                        {QUICK_EMOJI.map((emoji) => (
                            <button
                                key={emoji}
                                type="button"
                                aria-label={`React with ${emoji}`}
                                onClick={() => onReact(message.id, emoji)}
                                className="rounded px-1 py-0.5 text-sm transition-colors hover:bg-muted"
                            >
                                {emoji}
                            </button>
                        ))}
                        <button
                            type="button"
                            aria-label={message.starred ? "Remove from saved" : "Save this message"}
                            title={message.starred ? "Remove from saved" : "Save"}
                            onClick={() => onStar(message)}
                            className={cn(
                                "rounded p-1 transition-colors hover:bg-muted",
                                message.starred
                                    ? "text-primary"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            <Star className={cn("size-3.5", message.starred && "fill-current")} />
                        </button>
                        {onReply && (
                            <button
                                type="button"
                                aria-label="Reply"
                                title="Reply - or press R"
                                onClick={() => onReply(message)}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <CornerUpLeft className="size-3.5" />
                            </button>
                        )}
                        {onOpenThread && (
                            <button
                                type="button"
                                aria-label="Reply in a thread"
                                title="Reply in a thread"
                                onClick={() => onOpenThread(message)}
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <MessageSquare className="size-3.5" />
                            </button>
                        )}
                        {(mine || canModerate) && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label="More for this message"
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <SmilePlus className="size-3.5 rotate-90" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    onCloseAutoFocus={keepFocusOnClose}
                                >
                                    {mine && onEdit && (
                                        <DropdownMenuItem onSelect={() => onEdit(message)}>
                                            <Pencil className="size-3.5" />
                                            Edit
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                        variant="danger"
                                        onSelect={() => onDelete(message)}
                                    >
                                        <Trash2 className="size-3.5" />
                                        Delete
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </div>
                )}

                <EditHistoryDialog
                    message={showingHistory ? message : null}
                    onOpenChange={(open) => setShowingHistory(open)}
                />
            </div>
        </MessageMenu>
    );
}

/**
 * A picture, with a star in the corner for keeping it.
 *
 * The star appears on hover and on focus, in the corner, where every client that
 * has this puts it - and pressing it puts the picture in the emoji picker beside
 * the search that would otherwise have to find it again.
 *
 * Whether it is already kept is asked once when the star is first pressed rather
 * than for every picture on screen: a channel of forty GIFs would otherwise be
 * forty questions on every render, to draw a control nobody has looked at.
 */
function KeepableImage({
    href,
    alt,
    source,
    name,
    onOpen
}: {
    href: string;
    alt: string;
    /** What is stored: `attachment:<id>`, or the address for a remote one. */
    source: string;
    name: string;
    /** Pressed. Absent for a picture that has nowhere to open - a link preview's
     *  thumbnail, whose whole job is the link under it. */
    onOpen?: () => void;
}) {
    const [kept, setKept] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);

    const toggle = async () => {
        setBusy(true);
        // Unknown means it has not been asked about. Pressing the star is the
        // moment somebody wants it kept, so that is what it does; pressing it
        // again takes it back off.
        const next = kept !== true;
        const result = next
            ? await actions.saveMediaAction(source, name)
            : await actions.unsaveMediaAction(source);
        setBusy(false);
        if (!("error" in result) || !result.error) setKept(next);
    };

    return (
        <span className="group/pic relative inline-block max-w-full">
            <button
                type="button"
                onClick={onOpen}
                aria-label={`Open ${name}`}
                className="block cursor-zoom-in"
            >
                {/* eslint-disable-next-line @next/next/no-img-element -- one image per attachment, no loader wanted */}
                <img
                    src={href}
                    alt={alt}
                    className="max-h-72 max-w-full rounded-md border border-border object-contain"
                />
            </button>
            <button
                type="button"
                disabled={busy}
                aria-pressed={kept === true}
                aria-label={kept ? "Stop keeping this picture" : "Keep this picture"}
                title={kept ? "Kept. It is in your picker." : "Keep this"}
                onClick={() => void toggle()}
                className={cn(
                    "absolute right-1 top-1 rounded-md border border-border bg-background/80 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/pic:opacity-100",
                    kept === true && "text-primary opacity-100"
                )}
            >
                <Star className={cn("size-3.5", kept === true && "fill-current")} />
            </button>
        </span>
    );
}

/**
 * How far a message got.
 *
 * One tick for sent, two for delivered, two in colour for read - the shape
 * everybody already reads without being taught. It only ever appears on your own
 * messages in a one-to-one conversation, and only when both people allow it, so
 * its absence is not a state to be explained.
 *
 * Pressable, because "did they actually see this, and when" is a real question
 * and the glyph is where somebody asks it. The same three moments are in the
 * right-click menu, for anybody who does not think to press a tick.
 */
function Ticks({
    receipt,
    onOpen
}: {
    receipt: NonNullable<ChatMessageView["receipt"]>;
    onOpen: () => void;
}) {
    const label = {
        sent: "Sent",
        delivered: "Delivered",
        read: "Read"
    }[receipt];

    return (
        <button
            type="button"
            title={`${label}. Press for when.`}
            aria-label={`${label}. Open message information`}
            onClick={onOpen}
            className={cn(
                "ml-1 inline-flex rounded align-middle transition-colors hover:text-foreground",
                receipt === "read" ? "text-primary" : "text-foreground-subtle"
            )}
        >
            {receipt === "sent" ? <Check className="size-3" /> : <CheckCheck className="size-3" />}
        </button>
    );
}

/**
 * The card under a message with a link in it, once there is one to draw.
 *
 * Three states, and the middle one is the reason this exists. Polaris may
 * already know what the link is; it may never have looked, in which case this
 * asks and the card appears a moment later; or the site may have refused to
 * describe itself, which for most links means no card - but not for a video
 * Polaris knows how to play, which plays regardless of what the page said.
 *
 * Asking from here rather than waiting to be told is deliberate. A background
 * look-up finishes just after the conversation has reloaded, and nothing reloads
 * it again until somebody speaks - so the last message in a conversation, the
 * one actually being read, never got its card.
 */
function LinkArea({ message }: { message: ChatMessageView }) {
    const [found, setFound] = useState(message.preview);

    useEffect(() => {
        setFound(message.preview);
        if (!message.previewPending) return;

        // The card already on screen stays on screen while this runs. A stale
        // one is asked about too - a look that came back with nothing, or one
        // taken before Polaris knew to read the channel and the colour - and
        // blanking it first would make a refresh look like a failure.
        let live = true;
        void actions.linkPreviewAction(message.id).then((result) => {
            if (live && result.preview) setFound(result.preview);
        });
        return () => {
            live = false;
        };
    }, [message.id, message.preview, message.previewPending]);

    if (found) return <LinkCard preview={found} />;

    // Nothing came back, but this is something with a player. YouTube and its
    // like routinely refuse to describe themselves to anything that is not a
    // browser, and "the site said nothing" is no reason not to offer the video
    // somebody posted.
    if (message.link && embedFor(message.link)) {
        return (
            <LinkCard
                preview={{
                    id: "",
                    url: message.link,
                    title: "",
                    author: "",
                    accent: null,
                    siteName: hostOf(message.link),
                    hasImage: false,
                    description: ""
                }}
            />
        );
    }
    return null;
}

/** The site a link is on, for a card that has nothing else to say about it. */
function hostOf(address: string): string {
    try {
        return new URL(address).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

/**
 * What a link in a message turned out to be.
 *
 * Under the message rather than replacing it: the sentence somebody wrote about
 * the link is usually the point, and a card that swallowed it would lose that.
 *
 * The picture comes from Polaris rather than from the site, so scrolling past a
 * card does not announce the reader to whoever runs the page.
 */
function LinkCard({ preview }: { preview: NonNullable<ChatMessageView["preview"]> }) {
    const embed = embedFor(preview.url);
    const [playing, setPlaying] = useState(false);

    // The edge takes the site's own colour when it has published a usable one,
    // so a video reads as YouTube at a glance. Everything else keeps Polaris'
    // accent.
    const accent = usableAccent(preview.accent);
    const edge = accent ? { borderLeftColor: accent } : undefined;

    const details = (
        <span className="flex min-w-0 flex-col gap-0.5">
            {(preview.siteName || preview.author) && (
                <span className="truncate text-[11px] text-muted-foreground">
                    {[preview.siteName, preview.author].filter(Boolean).join(" - ")}
                </span>
            )}
            <span className="truncate text-xs font-medium text-foreground">
                {preview.title || preview.url}
            </span>
            {/* A video's own description is a wall of links and sponsorships,
                and the card already says the three things somebody wants: the
                site, who made it, and what it is called. */}
            {preview.description && !embed && (
                <span className="line-clamp-2 text-xs text-muted-foreground">
                    {preview.description}
                </span>
            )}
        </span>
    );

    // Something Polaris can play. The frame is built only once somebody presses
    // play: until then nothing has been requested from the site, which is the
    // same promise the picture already keeps.
    if (embed) {
        return (
            <div
                style={edge}
                className="mt-1 flex max-w-lg flex-col gap-2 rounded-md border border-border border-l-2 border-l-primary bg-card p-2"
            >
                <a
                    href={preview.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="min-w-0 no-underline"
                >
                    {details}
                </a>
                {playing ? (
                    <iframe
                        // Starts on its own. Pressing play in Polaris and then
                        // having to press play again in somebody else's player
                        // is one press too many, and the press that has already
                        // happened is what the site needs to allow the sound.
                        src={autoplaying(embed.url)}
                        title={preview.title || embed.provider}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                        allowFullScreen
                        referrerPolicy="strict-origin-when-cross-origin"
                        className={cn(
                            "w-full rounded border-0 bg-black",
                            embed.shape === "audio" ? "h-20" : "aspect-video"
                        )}
                    />
                ) : (
                    <button
                        type="button"
                        onClick={() => setPlaying(true)}
                        aria-label={`Play this on ${embed.provider}, here`}
                        title={`Plays here. ${embed.provider} sees you once you press it.`}
                        className={cn(
                            "group/play relative w-full overflow-hidden rounded bg-muted transition-colors hover:bg-card-hover",
                            embed.shape === "audio" ? "h-20" : "aspect-video"
                        )}
                    >
                        {preview.hasImage && (
                            // eslint-disable-next-line @next/next/no-img-element -- fetched through Polaris, no loader wanted
                            <img
                                src={`/api/chat/links/${preview.id}/image`}
                                alt=""
                                loading="lazy"
                                className="size-full object-cover"
                            />
                        )}
                        <span className="absolute inset-0 flex items-center justify-center">
                            <span className="flex size-11 items-center justify-center rounded-full bg-background/80 text-foreground transition-transform group-hover/play:scale-110">
                                <Play className="size-5 fill-current" />
                            </span>
                        </span>
                    </button>
                )}
            </div>
        );
    }

    return (
        <a
            href={preview.url}
            style={edge}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 flex max-w-lg gap-3 rounded-md border border-border border-l-2 border-l-primary bg-card p-2 transition-colors hover:bg-card-hover"
        >
            {preview.hasImage && (
                // eslint-disable-next-line @next/next/no-img-element -- one thumbnail, fetched through Polaris, no loader wanted
                <img
                    src={`/api/chat/links/${preview.id}/image`}
                    alt=""
                    loading="lazy"
                    className="size-16 shrink-0 rounded object-cover"
                />
            )}
            {details}
        </a>
    );
}

function DaySeparator({ iso }: { iso: string }) {
    const format = useDisplayFormat();
    return (
        <div className="flex items-center gap-3 px-4 pt-4">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] font-medium text-foreground-subtle">
                {format.date(iso)}
            </span>
            <span className="h-px flex-1 bg-border" />
        </div>
    );
}

function sameDay(left: string, right: string): boolean {
    return new Date(left).toDateString() === new Date(right).toDateString();
}

function withinWindow(left: string, right: string): boolean {
    return new Date(right).getTime() - new Date(left).getTime() < GROUP_WINDOW_MS;
}

/** A size somebody can read at a glance. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
