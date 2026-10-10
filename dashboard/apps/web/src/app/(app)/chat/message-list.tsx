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
 * A day separator sits between days. Timestamps are the clock time ("14:05",
 * "Yesterday at 14:05", a date before that), which is how somebody reading back
 * places a line; the full date and time is on the hover. See `message-time`.
 *
 * Deleted messages leave a line saying so rather than vanishing. A conversation
 * where replies suddenly answer nothing is worse than one that admits something
 * was taken back.
 */

import Link from "next/link";
import { useTranslations } from "@/components/i18n/i18n-provider";
import * as actions from "./actions";
import { VoiceNote } from "./voice-note";
import { useChat } from "./chat-context";
import { useHeldCall } from "./call-hold";
import { Avatar } from "@/components/avatar";
import { PersonName } from "@/components/person-name";
import { Spoiler } from "./spoiler";
import { MessageMenu } from "./message-menu";
import { copyText } from "./links";
import { plainText } from "@/components/rich-text/excerpt";
import { PollCard } from "./poll-card";
import { hasCard, referenced } from "./message-references";
import { ReportDialog } from "./report-dialog";
import { NicknameDialog } from "./nickname-dialog";
import { useAppUrl } from "@/components/app-url";
import { useOpenDirect } from "./use-open-direct";
import { MemberMenu, type MenuPerson } from "./member-menu";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from "react";
import { recentEmoji, rememberEmoji } from "./recents";
import * as core from "@polaris/core";
import { EmojiPicker } from "./emoji-picker";
import type { SpaceEmojiScope } from "./space-emoji";
import { EmojiFace } from "@/components/rich-text/custom-emoji";
import { embedFor } from "@/lib/chat/embeds";
import { LinkCard } from "./link-card";
import { EditHistoryDialog } from "./edit-history-dialog";
import { RelativeTime } from "@/components/relative-time";
import { MessageTime } from "@/components/message-time";
import { MessageInfoDialog } from "./message-info-dialog";
import type { VoicePresence } from "@/lib/chat/meetings";
import type { ChatMessageView, ChatQuoteView } from "@/lib/chat/messages";
import type { ChatReferenceView } from "@/lib/chat/references";
import { RichText } from "@/components/rich-text/rich-text";
import { VideoPreview } from "@/components/video-preview";
import { isPlayable, isVoiceMessage } from "./voice-recorder";
import { AttachmentViewer, previewableAs, type ViewedFile } from "./attachment-viewer";
import { usePersonPress } from "@/components/person-press";
import { NoticeText } from "./notice-line";
import { useSwipeReply } from "./swipe-reply";

/**
 * A file on a message that is not a picture, a recording or a clip.
 *
 * Two things can be done with one and they are not the same thing: read it, and
 * keep it. Reading is the common one by a distance - an invoice, a form, a
 * report, a spreadsheet somebody wants an answer about - and until now it was
 * the one that took four steps and left a copy in a downloads folder.
 *
 * So the chip opens it. Downloading is still one click, as its own control with
 * its own label, because a chip whose only action is "save" and a chip whose
 * only action is "open" cannot both be one click on the same rectangle.
 *
 * A file with no view worth offering - an archive, an installer - stays exactly
 * what it was: a link that saves it.
 */
function SentFile({
    file,
    at,
    onOpen
}: {
    file: ChatMessageView["attachments"][number];
    at: string;
    onOpen: (file: ViewedFile) => void;
}) {
    const t = useTranslations("chat");
    const readable = previewableAs(file.name, file.contentType);
    const chip =
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-left text-xs transition-colors hover:bg-card-hover";

    if (!readable) {
        return (
            <a
                href={`/api/chat/attachments/${file.id}?download=1`}
                download={file.name}
                className={chip}
            >
                {file.borrowed ? (
                    <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                    <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[16rem] truncate" title={file.name}>
                    {file.name}
                </span>
                <span className="shrink-0 text-muted-foreground">{readableSize(file.size)}</span>
                {file.borrowed && <DriveMark />}
            </a>
        );
    }

    return (
        <span className="inline-flex items-center gap-1">
            <button
                type="button"
                className={chip}
                title={t("messageList.openNamed", { name: file.name })}
                onClick={() =>
                    onOpen({ id: file.id, name: file.name, size: file.size, sentAt: at })
                }
            >
                {file.borrowed ? (
                    <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="max-w-[16rem] truncate">{file.name}</span>
                <span className="shrink-0 text-muted-foreground">{readableSize(file.size)}</span>
                {file.borrowed && <DriveMark />}
            </button>
            <a
                href={`/api/chat/attachments/${file.id}?download=1`}
                download={file.name}
                aria-label={t("messageList.downloadNamed", { name: file.name })}
                title={t("messageList.download")}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
            >
                <Download className="size-3.5 shrink-0" />
            </a>
        </span>
    );
}

/** Whether an attachment is a video Polaris will draw a player for. The same
 *  fixed list the download route serves as itself - anything else stays an
 *  opaque download, because the type came from an upload. */
function isWatchable(contentType: string): boolean {
    const base = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    return base === "video/mp4" || base === "video/webm" || base === "video/ogg";
}
import { useDisplayFormat } from "@/components/display-format";
import { ImageViewer, type ViewedImage } from "@/components/image-viewer";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    keepFocusOnClose,
    useToast,
    matchShortcut
} from "@polaris/ui";
import {
    Check,
    CheckCheck,
    CornerUpLeft,
    Download,
    FileText,
    HardDrive,
    MessageSquare,
    MoreHorizontal,
    Paperclip,
    Pencil,
    Pin,
    SmilePlus,
    Star,
    Trash2,
    Volume2,
    Webhook
} from "lucide-react";

/**
 * Whether every picture, video and link card in this conversation starts
 * covered - a channel whose settings say its content is spoilers. A context
 * rather than a prop down every message, because only the attachment and the
 * card read it.
 */
const CoverMedia = createContext(false);

/** How close together two messages have to be to share a header. Long enough
 *  that a paused sentence stays one block, short enough that coming back an hour
 *  later starts a new one. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * The emoji the hover offers without opening anything.
 *
 * Three, and the three this person last reached for. Nine emoji out of two
 * thousand are most of what anybody sends and they are not the same nine for any
 * two people - so a fixed row is a row that is right for whoever chose it, and a
 * row of six of them is most of the width of the bar spent on guesses.
 *
 * The defaults below fill in behind: a browser that has never reacted still
 * offers something, and it stops offering it as soon as there is a habit to show
 * instead.
 */
const DEFAULT_QUICK_EMOJI = ["👍", "❤️", "😄"] as const;

/** How many the bar shows. Discord shows three and so does everything else that
 *  put them on the hover rather than behind a picker. */
const QUICK_COUNT = 3;

/**
 * The last few, padded from the defaults so there are always three.
 *
 * A space's own emoji is one of them only inside that space while it still
 * exists: anywhere else it cannot be reacted with, and the server would refuse
 * the press.
 */
function quickEmoji(recent: readonly string[], scope: SpaceEmojiScope | null): string[] {
    const usable = recent.filter((emoji) => {
        const ref = core.parseCustomEmojiToken(emoji);
        return ref === null || (scope?.set.entries.has(ref.id) ?? false);
    });
    const chosen = [...usable.slice(0, QUICK_COUNT)];
    for (const fallback of DEFAULT_QUICK_EMOJI) {
        if (chosen.length >= QUICK_COUNT) break;
        if (!chosen.includes(fallback)) chosen.push(fallback);
    }
    return chosen;
}

export interface MessageListProps {
    messages: readonly ChatMessageView[];
    /** Cover every picture, video and link card until it is pressed - the
     *  channel's content setting, not the sender's. */
    coverMedia?: boolean;
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
    /** The messages pinned for everybody here, to mark them and to offer Unpin
     *  rather than Pin. Absent inside a thread, where nothing is pinned. */
    pinnedIds?: ReadonlySet<string>;
    /** Pin or unpin for everybody. Absent where this reader may not, and then
     *  the item is not drawn. */
    onPin?: (message: ChatMessageView, pinned: boolean) => void;
    /** Pick the conversation up again from a message. Absent inside a thread,
     *  whose unread is counted separately from the channel's. */
    onMarkUnread?: (message: ChatMessageView) => void;
    /**
     * Absent inside a thread, which is already the reply.
     *
     * Optional for the same reason `onOpenThread` is: a control that is drawn and
     * does nothing is worse than one that is not there. These three used to be
     * passed as empty functions by the thread panel, so it carried a Reply
     * button, a Forward item and an Edit item that all quietly did nothing.
     */
    onReply?: (message: ChatMessageView) => void;
    /** Answer the author where the room cannot read it. Absent inside a thread
     *  and inside a direct message, for the reasons `MessageActions` gives. */
    onReplyPrivately?: (message: ChatMessageView) => void;
    onForward?: (message: ChatMessageView) => void;
    onEdit?: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
    /** Put somebody into what is being written, for the mention a name offers.
     *  Absent where there is no composer under the list, and then that one item
     *  is not drawn rather than drawn doing nothing. */
    onMention?: (text: string) => void;
    /** A message to point at, after arriving from a search result. It fades on
     *  its own: a highlight that stays is a highlight somebody has to dismiss. */
    highlightId?: string | null;
    /**
     * Walk to a message in this same conversation, rather than navigating to it.
     *
     * A link to a message is an address, and following an address is a page
     * load: the conversation it names is the one already open, so the route
     * change fetches and redraws every line of it to end up where scrolling gets
     * in one frame - and the reader watches the room they were reading blink
     * away and come back. Given by the screen that owns the list and can scroll
     * it; absent inside a thread, where the link still navigates.
     */
    onJumpTo?: (messageId: string) => void;
    /** The space's own emoji, to draw in the text and offer for reactions.
     *  Null outside a space, where every token reads as its name. */
    emoji?: SpaceEmojiScope | null;
}

export function MessageList({
    messages,
    viewerId,
    canPost,
    canModerate,
    highlightId,
    onJumpTo,
    onOpenThread,
    onReact,
    onStar,
    pinnedIds,
    onPin,
    onMarkUnread,
    onReply,
    onReplyPrivately,
    onForward,
    onEdit,
    onDelete,
    onMention,
    emoji = null,
    coverMedia = false
}: MessageListProps) {
    useMessageKeys({ messages, viewerId, canPost, canModerate, onReply, onEdit, onDelete });
    const { refresh } = useChat();

    // The picture being looked at, held here rather than in each message: one
    // viewer is open at a time, and it is drawn over the whole conversation.
    const [viewing, setViewing] = useState<ViewedImage | null>(null);
    /** The file being read, held here for the same reason as the picture: one is
     *  open at a time and it covers the whole conversation. */
    const [reading, setReading] = useState<ViewedFile | null>(null);
    const [reporting, setReporting] = useState<string | null>(null);
    const [explaining, setExplaining] = useState<ChatMessageView | null>(null);
    /** Whose nickname is being changed. Up here with the other dialogs, and for
     *  the same reason: the menu that asks for it is unmounted the moment an
     *  item is chosen, and a dialog opened by something that is about to
     *  disappear never appears. */
    const [naming, setNaming] = useState<MenuPerson | null>(null);

    /**
     * The three the hover offers.
     *
     * Read on mount rather than at render: the habit lives in this browser's
     * storage, which the server has no copy of, so reading it while the markup is
     * being built server-side would hand back the defaults and then change them
     * under the reader on the first frame. Re-read on every press, so a reaction
     * sent from the picker is at the front of the row on the next message.
     */
    const [recent, setRecent] = useState<readonly string[]>([]);
    useEffect(() => setRecent(recentEmoji()), []);
    const quick = useMemo(() => quickEmoji(recent, emoji), [recent, emoji]);

    /** React, and remember it. The picker records what is chosen through it; the
     *  hover row did not, so pressing the same emoji forty times never made it
     *  one of the three on offer. */
    const react = useCallback(
        (messageId: string, emoji: string) => {
            rememberEmoji(emoji);
            setRecent(recentEmoji());
            onReact(messageId, emoji);
        },
        [onReact]
    );

    const toast = useToast();
    /** A refusal from a name's menu has nowhere in the stream to sit, so it is
     *  said over the conversation. The empty string is the hook clearing a
     *  previous failure and has nothing to say. */
    const say = (message: string) => {
        if (message) toast.show({ title: message });
    };

    /**
     * Who is sitting in each voice room this conversation points at.
     *
     * Asked when the page of messages is read, which is the whole point: a
     * message pasting a voice room is worth nothing if it lists whoever was in
     * there when it was sent. Asked once for the page rather than once per card,
     * and only while a card exists to want it - a conversation naming no voice
     * room asks nothing at all.
     */
    const voiceIds = useMemo(
        () =>
            [
                ...new Set(
                    messages.flatMap((message) =>
                        message.references
                            .filter(
                                (found) =>
                                    found.reachable &&
                                    found.kind === "channel" &&
                                    found.channelKind === "voice"
                            )
                            .map((found) => found.id)
                    )
                )
            ].sort(),
        [messages]
    );
    const asked = voiceIds.join(",");
    const [inVoice, setInVoice] = useState<ReadonlyMap<string, readonly VoicePresence[]>>(
        new Map()
    );

    useEffect(() => {
        if (!asked) {
            setInVoice(new Map());
            return;
        }
        let live = true;
        void actions.voicePresenceAction(asked.split(",")).then((result) => {
            if (live) setInVoice(new Map(Object.entries(result.inRoom)));
        });
        return () => {
            live = false;
        };
    }, [asked]);

    return (
        <CoverMedia.Provider value={coverMedia}>
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
                                // Only the person named sees this. To everybody else
                                // it is an ordinary message with an ordinary mention
                                // in it, which is exactly what it is to them - and a
                                // room where every mention of anybody was highlighted
                                // for everybody would be a room of highlights.
                                message.mentionsYou && "border-l-2 border-warning bg-warning-soft",
                                message.id === highlightId && "bg-primary/10"
                            )}
                        >
                            {newDay && <DaySeparator iso={message.createdAt} />}
                            <Message
                                quick={quick}
                                emoji={emoji}
                                message={message}
                                grouped={grouped}
                                // The ticks go under the last message of a block and
                                // nowhere else. Somebody who has read the newest of
                                // five messages in a row has read the other four,
                                // and five ticks say that five times.
                                lastOfBlock={!sharesBlock(message, messages[index + 1])}
                                mine={message.authorId === viewerId}
                                viewerId={viewerId}
                                onMention={onMention}
                                onNickname={setNaming}
                                onError={say}
                                onOpenImage={setViewing}
                                onOpenFile={setReading}
                                onReport={(target) => setReporting(target.id)}
                                onExplain={setExplaining}
                                canPost={canPost}
                                canModerate={canModerate}
                                onOpenThread={onOpenThread}
                                onReact={react}
                                onStar={onStar}
                                pinned={pinnedIds?.has(message.id) ?? false}
                                onPin={onPin}
                                onMarkUnread={onMarkUnread}
                                inVoice={inVoice}
                                onJumpTo={onJumpTo}
                                onReply={onReply}
                                onReplyPrivately={onReplyPrivately}
                                onForward={onForward}
                                onEdit={onEdit}
                                onDelete={onDelete}
                            />
                        </li>
                    );
                })}

                <AttachmentViewer file={reading} onClose={() => setReading(null)} />

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
                    // Whoever wrote it, so blocking them is one press once the
                    // report has gone. Null for a message whose author has left,
                    // and then the offer is not made rather than made and refused.
                    author={(() => {
                        const said = messages.find((entry) => entry.id === reporting);
                        return said?.authorId && said.authorName
                            ? { id: said.authorId, name: said.authorName }
                            : null;
                    })()}
                    open={reporting !== null}
                    onOpenChange={(next) => !next && setReporting(null)}
                />
                <MessageInfoDialog
                    message={explaining}
                    onOpenChange={(next) => !next && setExplaining(null)}
                />
                <NicknameDialog
                    open={naming !== null}
                    person={naming ? { id: naming.userId, name: naming.name } : null}
                    onOpenChange={(open) => !open && setNaming(null)}
                    onSaved={refresh}
                />
            </ol>
        </CoverMedia.Provider>
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
 * F2 rewrites it, Delete takes it back, R answers it and Ctrl+C copies what it
 * says - the four things the hover row and the menu already offer. The row lights
 * up on hover and carries a pencil, a bin and an arrow, so what is being aimed at
 * is never in doubt: these are shortcuts to controls that are visibly there, not
 * hidden gestures. Focus counts as well as hover, so the same keys reach the same
 * message from a keyboard.
 *
 * Delete opens the confirmation rather than doing it, exactly as the menu item
 * does. A key that removed a message on a single press would be the one gesture
 * in a conversation with no undo, reachable by leaning on a keyboard.
 *
 * Copy is the one that is not about writing, and it behaves differently in two
 * ways that both matter. It works for a reader who cannot post - reading a
 * conversation and copying a line out of it is the same act - and it stands aside
 * the moment there is a selection on the page, because Ctrl+C over highlighted
 * text means that text, always. A shortcut that quietly replaced what somebody
 * had just selected with something else would be worse than not having one.
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
            // Which key is which is the shared table's `chat.*`. A press matches
            // only with exactly its modifiers, which is what keeps AltGr+C (Ctrl+Alt
            // on Windows) typing its character and Ctrl+Shift+C opening the
            // developer tools instead of copying a message.
            const matched = matchShortcut(event, [
                "chat.copy",
                "chat.edit",
                "chat.delete",
                "chat.reply"
            ]);
            const wanted = matched
                ? (matched.slice("chat.".length) as "copy" | "edit" | "delete" | "reply")
                : null;
            if (!wanted) return;
            // Highlighted text is what Ctrl+C is for. The browser's own copy is
            // left to do exactly what the person asked for.
            if (wanted === "copy" && !window.getSelection()?.isCollapsed) return;
            const active = document.activeElement;
            if (
                active instanceof HTMLElement &&
                (active.isContentEditable ||
                    ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))
            ) {
                return;
            }

            const shown = latest.current;
            // Everything except copying is a way of writing, and a reader who
            // cannot post is offered none of them. Copying a line out of a
            // conversation is reading it.
            if (!shown.canPost && wanted !== "copy") return;
            const row =
                document.querySelector("li[id^='message-']:hover") ??
                active?.closest("li[id^='message-']");
            const id = row?.id.replace(/^message-/, "");
            const message = shown.messages.find((entry) => entry.id === id);
            if (!message || message.deleted) return;
            // A line Polaris wrote itself - somebody joined, a call started - is
            // not a message to answer, rewrite or take down.
            if (message.kind === "system") return;

            if (wanted === "copy") {
                // The same text the menu's "Copy text" hands over: what the
                // message says, not the markup it is stored as.
                const text = plainText(message.body);
                // A message can be a picture and nothing else - the composer
                // allows it - and its body is then empty. Writing that to the
                // clipboard destroys whatever was on it, which is the worst
                // thing a shortcut can do: silent, and it takes something that
                // was not ours. The press is left to the browser instead.
                if (!text) return;
                event.preventDefault();
                void copyText(text);
                return;
            }

            const mine = message.authorId === shown.viewerId;
            // The same rules the pencil, the bin and the arrow are drawn under,
            // so a key can never do something the screen does not offer: your own
            // to rewrite, your own or anybody's here to take down, and anything
            // at all to answer - wherever answering is offered.
            // A poll is not rewritten - see `rewrite` in `Message`. The key
            // follows the pencil rather than reaching past it.
            if (wanted === "edit" && (message.kind === "poll" || !mine || !shown.onEdit)) return;
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
    pinned,
    onPin,
    onMarkUnread,
    inVoice,
    onJumpTo,
    onReply,
    onReplyPrivately,
    onForward,
    onEdit,
    onDelete,
    onOpenImage,
    onOpenFile,
    onReport,
    onExplain,
    viewerId,
    onMention,
    onNickname,
    onError,
    quick,
    emoji
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
    pinned: boolean;
    onPin?: (message: ChatMessageView, pinned: boolean) => void;
    onMarkUnread?: (message: ChatMessageView) => void;
    /** Who is in each voice room this page of messages points at, gathered once
     *  by the list. Empty until the answer arrives, which draws a card saying
     *  the room is empty for a moment rather than no card at all. */
    inVoice: ReadonlyMap<string, readonly VoicePresence[]>;
    /** Scroll to a message quoted in this one instead of navigating to it - see
     *  `MessageListProps`. */
    onJumpTo?: (messageId: string) => void;
    onReply?: (message: ChatMessageView) => void;
    onReplyPrivately?: (message: ChatMessageView) => void;
    onForward?: (message: ChatMessageView) => void;
    onEdit?: (message: ChatMessageView) => void;
    onDelete: (message: ChatMessageView) => void;
    /** A picture on this message was pressed. Opened over the conversation
     *  rather than in a tab: a tab is the browser's viewer, with no way back and
     *  nothing to do with the picture but look at it. */
    onOpenImage: (image: ViewedImage) => void;
    /** Open a sent file in the reader rather than saving it. */
    onOpenFile: (file: ViewedFile) => void;
    onReport: (message: ChatMessageView) => void;
    /** Open the three moments behind the ticks. */
    onExplain: (message: ChatMessageView) => void;
    /** Who is reading, which is what decides that their own name is a name
     *  rather than somebody to act on - see `Writer`. */
    viewerId: string;
    onMention?: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onError: (message: string) => void;
    /** The three the hover offers, decided once by the list so every row's bar
     *  shows the same ones and they all change together. */
    quick: readonly string[];
    /** The space's own emoji - see `MessageListProps`. */
    emoji: SpaceEmojiScope | null;
}) {
    const t = useTranslations("chat");
    const format = useDisplayFormat();
    const emojiSet = emoji?.set ?? null;
    const baseUrl = useAppUrl();
    const [showingHistory, setShowingHistory] = useState(false);
    // Per message and not remembered. Looking at one thing somebody blocked said
    // is not a decision to start reading them again, and a reveal that outlived
    // the scroll would quietly undo the block one line at a time.
    const [revealed, setRevealed] = useState(false);
    const direct = useOpenDirect(onError);
    const author = message.authorName ?? "Somebody who has left";
    /** What pressing a name or a face does here: their card, where the screen
     *  draws cards - see `PersonCardProvider`. Where it does not, a name still
     *  opens the conversation with them and a face still opens its photo. */
    const press = usePersonPress();
    /**
     * Rewriting this one, when it is a thing that can be rewritten.
     *
     * A poll's body is the question people answered, and changing it would leave
     * every vote already cast standing behind something nobody agreed to - so
     * the service refuses it and the pencil is not offered. Taking it down and
     * asking again is the way to change a poll.
     */
    const rewrite = message.kind === "poll" ? undefined : onEdit;
    /** Who wrote it, when that is somebody other than the reader. Read out here
     *  so the name and the face can both ask about them without narrowing it
     *  again in two places. */
    const writer = message.authorId && !mine ? message.authorId : null;
    /** Swiping the line to the right answers it, on a phone - the same reply the
     *  menu and the hover bar offer, so only where those offer it. */
    const swipe = useSwipeReply(
        onReply && canPost && !message.deleted && message.kind !== "system"
            ? () => onReply(message)
            : undefined
    );
    const coverAll = useContext(CoverMedia);

    // Something Polaris said rather than somebody: joined, left, was added.
    // Indented to where message text starts rather than to the avatar gutter,
    // so a room reads as one column of sentences with the occasional quiet one
    // among them - the gutter is for faces, and this line has none.
    if (message.kind === "system") {
        return (
            <p className="py-1 pl-14 pr-4 text-xs text-muted-foreground">
                <NoticeText message={message} /> <MessageTime iso={message.createdAt} />
            </p>
        );
    }

    // Somebody this reader has blocked. Folded away rather than dropped: a
    // conversation with gaps in it reads as messages that failed to load, and
    // the replies underneath one would be answering nothing. Drawn at the same
    // indent as a line Polaris wrote, because that is what it now is - a note
    // saying something happened here, not the thing itself.
    if (message.blocked && !revealed) {
        return (
            <p className="flex items-baseline gap-2 py-1 pl-14 pr-4 text-xs text-muted-foreground">
                <span>{t("messageList.blockedMessage")}</span>
                <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className="rounded underline-offset-2 hover:underline focus-visible:underline"
                >
                    {t("messageList.show")}
                </button>
                <MessageTime iso={message.createdAt} />
            </p>
        );
    }

    return (
        // Clipped sideways only, so a line pulled to the right never gives the
        // conversation a horizontal scrollbar while the hover bar, which sits
        // half above the row, is still drawn whole.
        <div className="relative overflow-x-clip">
            {swipe.enabled && (
                <span
                    ref={swipe.cue}
                    aria-hidden
                    data-armed="false"
                    className="pointer-events-none absolute left-4 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-muted text-muted-foreground opacity-0 data-[armed=true]:bg-primary data-[armed=true]:text-primary-foreground"
                >
                    <CornerUpLeft className="size-4" />
                </span>
            )}
            <MessageMenu
                actions={{
                    message,
                    mine,
                    canPost,
                    canModerate,
                    onReply,
                    onReplyPrivately,
                    onForward,
                    onOpenThread,
                    onStar,
                    pinned,
                    onPin,
                    onMarkUnread,
                    onEdit: rewrite,
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
                    ref={swipe.line}
                    className={cn(
                        "group relative flex gap-2 px-4 transition-colors hover:bg-card-hover/60 data-[state=open]:bg-card-hover",
                        grouped ? "py-0.5" : "pb-0.5 pt-3",
                        swipe.enabled && "touch-pan-y touch-pinch-zoom"
                    )}
                >
                    <span className="w-8 shrink-0">
                        {grouped ? (
                            <>
                                <span
                                    className="hidden pt-1 text-[0.625rem] leading-4 text-foreground-subtle group-hover:block group-data-[state=open]:block"
                                    title={format.dateTime(message.createdAt)}
                                >
                                    {format.time(message.createdAt)}
                                </span>
                                {/* Without a header there is nowhere else to say it, so
                                the marks sit in the gutter until the hover takes
                                it for the time. */}
                                {(pinned || message.starred) && (
                                    <span className="flex items-center gap-0.5 pt-1 group-hover:hidden group-data-[state=open]:hidden">
                                        <Marks pinned={pinned} starred={message.starred} />
                                    </span>
                                )}
                            </>
                        ) : message.authorId ? (
                            // Right-clicking a face asks about the person, the way it
                            // does in the roster. Pressing it still opens their photo,
                            // which is what a face has always done here.
                            <Writer
                                person={{ userId: message.authorId, name: author }}
                                channelId={message.channelId}
                                viewerId={viewerId}
                                onMention={onMention}
                                onNickname={onNickname}
                                onError={onError}
                            >
                                {press ? (
                                    // The face opens the card, like the name beside
                                    // it. The photo is one press further, on the
                                    // card's own face.
                                    <button
                                        type="button"
                                        aria-label={t("messageList.viewProfile", { name: author })}
                                        title={author}
                                        onClick={(event) =>
                                            press(
                                                { id: message.authorId!, name: author },
                                                event.currentTarget
                                            )
                                        }
                                        className="inline-flex rounded-full"
                                    >
                                        <Avatar
                                            decorated
                                            person={{ id: message.authorId, name: author }}
                                            size={28}
                                        />
                                    </button>
                                ) : (
                                    <span className="inline-flex">
                                        <Avatar
                                            openable
                                            decorated
                                            person={{ id: message.authorId, name: author }}
                                            size={28}
                                        />
                                    </span>
                                )}
                            </Writer>
                        ) : message.fromWebhook ? (
                            <span
                                className="inline-flex size-7 items-center justify-center rounded-full bg-primary/15 text-primary"
                                aria-hidden="true"
                            >
                                <Webhook className="size-4 shrink-0" />
                            </span>
                        ) : (
                            <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[0.625rem] text-muted-foreground">
                                ?
                            </span>
                        )}
                    </span>

                    <div className="min-w-0 flex-1 pb-0.5">
                        {!grouped && (
                            <p className="flex items-baseline gap-2">
                                {press && message.authorId ? (
                                    <Writer
                                        person={{ userId: message.authorId, name: author }}
                                        channelId={message.channelId}
                                        viewerId={viewerId}
                                        onMention={onMention}
                                        onNickname={onNickname}
                                        onError={onError}
                                    >
                                        {/* Your own name too: the card is how anybody
                                        sees what they look like to everybody else. */}
                                        <button
                                            type="button"
                                            title={t("messageList.viewProfile", { name: author })}
                                            onClick={(event) =>
                                                press(
                                                    { id: message.authorId!, name: author },
                                                    event.currentTarget
                                                )
                                            }
                                            className="rounded text-left text-sm font-medium underline-offset-2 hover:underline focus-visible:underline"
                                        >
                                            <PersonName id={message.authorId} name={author} />
                                        </button>
                                    </Writer>
                                ) : writer ? (
                                    <Writer
                                        person={{ userId: writer, name: author }}
                                        channelId={message.channelId}
                                        viewerId={viewerId}
                                        onMention={onMention}
                                        onNickname={onNickname}
                                        onError={onError}
                                    >
                                        {/* Underlined on the hover and nothing else:
                                        a name that grows a background or a border
                                        moves every line under it by a pixel, and a
                                        conversation that shifts as the pointer
                                        crosses it is unreadable. */}
                                        <button
                                            type="button"
                                            disabled={direct.busy}
                                            title={t("messageList.messageNamed", { name: author })}
                                            onClick={() => void direct.open(writer)}
                                            className="rounded text-left text-sm font-medium underline-offset-2 hover:underline focus-visible:underline"
                                        >
                                            <PersonName id={message.authorId} name={author} />
                                        </button>
                                    </Writer>
                                ) : (
                                    <span className="text-sm font-medium">
                                        <PersonName id={message.authorId} name={author} />
                                    </span>
                                )}
                                {/* Not a person: something outside Polaris posting
                                through one of the channel's webhooks, under a name
                                it chose. Discord's APP tag says the same. */}
                                {message.fromWebhook && (
                                    <span
                                        className="shrink-0 self-center rounded bg-primary px-1 text-[0.625rem] font-semibold uppercase leading-4 text-primary-foreground"
                                        title={t("messageList.webhookHint")}
                                    >
                                        {t("messageList.app")}
                                    </span>
                                )}
                                <MessageTime
                                    iso={message.createdAt}
                                    className="whitespace-nowrap text-[0.6875rem] text-foreground-subtle"
                                />
                                <Marks pinned={pinned} starred={message.starred} />
                            </p>
                        )}

                        {message.quote && (
                            <QuoteLine
                                quote={message.quote}
                                here={message.channelId}
                                onJumpTo={onJumpTo}
                            />
                        )}

                        {message.deleted ? (
                            <p className="text-sm italic text-foreground-subtle">
                                {t("messageList.thisMessageWasDeleted")}
                            </p>
                        ) : (
                            <div className="text-sm">
                                <RichText
                                    value={message.body}
                                    origin={baseUrl}
                                    references={referenced(message)}
                                    customEmoji={emojiSet}
                                    jumboEmoji
                                />
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
                                        title={t("messageList.seeWhatItSaidBefore")}
                                        className="ml-1 rounded text-[0.6875rem] text-foreground-subtle underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
                                    >
                                        (edited)
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Under the question rather than in place of it: the
                        message body IS the question, so the card carries only
                        the answers and what has become of them. */}
                        {message.poll && !message.deleted && (
                            <PollCard
                                message={message}
                                poll={message.poll}
                                canPost={canPost}
                                // Whoever asked it, and whoever moderates the room.
                                // The two reasons to stop one early are different:
                                // the asker has their answer, and the moderator has
                                // a poll that should not be running.
                                canEnd={mine || canModerate}
                                onError={onError}
                            />
                        )}

                        <Spoiler kind="link" covered={coverAll}>
                            <LinkArea message={message} />
                        </Spoiler>
                        <ReferenceCards message={message} inRoom={inVoice} onJumpTo={onJumpTo} />

                        {message.attachments.length > 0 && (
                            <ul className="mt-1 flex flex-col gap-1">
                                {message.attachments.map((file) => (
                                    <li key={file.id}>
                                        {/* Covered where the sender said so. The
                                        file is drawn underneath either way, so
                                        uncovering it is the cover coming off
                                        rather than a second load. */}
                                        <Spoiler
                                            kind={
                                                file.inline
                                                    ? "picture"
                                                    : isWatchable(file.contentType)
                                                      ? "video"
                                                      : "file"
                                            }
                                            className={
                                                file.spoiler || coverAll ? undefined : "contents"
                                            }
                                            covered={file.spoiler || coverAll}
                                        >
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
                                                    recorded={isVoiceMessage(
                                                        file.name,
                                                        file.contentType
                                                    )}
                                                    waveform={file.waveform}
                                                    durationMs={file.durationMs}
                                                />
                                            ) : isWatchable(file.contentType) ? (
                                                // Watched where it was sent, and not a
                                                // byte of it fetched until somebody
                                                // presses play: a room with four clips
                                                // in it would otherwise pull four files
                                                // off the disk to draw the text above
                                                // them. See `VideoPreview`.
                                                <VideoPreview
                                                    name={file.name}
                                                    size={file.size}
                                                    src={`/api/chat/attachments/${file.id}`}
                                                    // A frame of the video itself, taken
                                                    // by the browser that sent it. A few
                                                    // kilobytes, and the difference
                                                    // between a list of black rectangles
                                                    // and a list somebody can read.
                                                    poster={
                                                        file.hasPoster
                                                            ? `/api/chat/attachments/${file.id}?poster=1`
                                                            : undefined
                                                    }
                                                    download={`/api/chat/attachments/${file.id}?download=1`}
                                                />
                                            ) : (
                                                <SentFile
                                                    file={file}
                                                    at={message.createdAt}
                                                    onOpen={onOpenFile}
                                                />
                                            )}
                                        </Spoiler>
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
                                            <EmojiFace value={reaction.emoji} set={emojiSet} />
                                            <span>{reaction.count}</span>
                                        </button>
                                    </li>
                                ))}
                                {/* One more, beside the ones already there, as every
                                    chat has it: adding a reaction to a message that
                                    has some is where the eye already is, rather than
                                    up in the toolbar. Shown while the message is
                                    hovered or focused, so a column of reacted
                                    messages is not a column of empty faces. */}
                                {canPost && !message.deleted && (
                                    <li className="hidden group-focus-within:block group-hover:block group-data-[state=open]:block has-[[aria-expanded=true]]:block">
                                        <EmojiPicker
                                            disabled={false}
                                            media={false}
                                            custom={
                                                emoji
                                                    ? {
                                                          spaceName: emoji.spaceName,
                                                          entries: emoji.entries,
                                                          manageHref: null
                                                      }
                                                    : null
                                            }
                                            label={t("messageList.addReaction")}
                                            icon={<SmilePlus className="size-3.5" />}
                                            triggerClassName="flex h-full items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                                            onEmoji={(choice) => onReact(message.id, choice)}
                                        />
                                    </li>
                                )}
                            </ul>
                        )}

                        {message.replyCount > 0 && onOpenThread && (
                            <button
                                type="button"
                                onClick={() => onOpenThread(message)}
                                className="mt-1 flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                            >
                                <MessageSquare className="size-3" />
                                {t("messageList.replies", { count: message.replyCount })}
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
                            {quick.map((choice) => {
                                const ref = core.parseCustomEmojiToken(choice);
                                const named = ref ? core.customEmojiFallback(ref) : choice;
                                return (
                                    <button
                                        key={choice}
                                        type="button"
                                        aria-label={t("messageList.reactWith", { emoji: named })}
                                        title={t("messageList.reactWith", { emoji: named })}
                                        onClick={() => onReact(message.id, choice)}
                                        className="flex items-center rounded px-1 py-0.5 text-sm transition-colors hover:bg-muted"
                                    >
                                        <EmojiFace value={choice} set={emojiSet} />
                                    </button>
                                );
                            })}
                            <EmojiPicker
                                disabled={false}
                                media={false}
                                custom={
                                    emoji
                                        ? {
                                              spaceName: emoji.spaceName,
                                              entries: emoji.entries,
                                              manageHref: null
                                          }
                                        : null
                                }
                                label={t("messageList.addReaction")}
                                icon={<SmilePlus className="size-3.5" />}
                                onEmoji={(choice) => onReact(message.id, choice)}
                            />
                            {/* The reactions are one kind of thing and everything to
                            the right of this is another. Without the rule they
                            read as one row of seven controls where three of them
                            happen to be pictures. */}
                            <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                            <button
                                type="button"
                                aria-label={
                                    message.starred
                                        ? t("messageList.removeFromSaved")
                                        : t("messageList.saveThisMessage")
                                }
                                title={
                                    message.starred
                                        ? t("messageList.removeFromSaved")
                                        : t("messageList.save")
                                }
                                onClick={() => onStar(message)}
                                className={cn(
                                    "rounded p-1 transition-colors hover:bg-muted",
                                    message.starred
                                        ? "text-primary"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Star
                                    className={cn("size-3.5", message.starred && "fill-current")}
                                />
                            </button>
                            {onReply && (
                                <button
                                    type="button"
                                    aria-label={t("messageList.reply")}
                                    title={t("messageList.replyOrPressR")}
                                    onClick={() => onReply(message)}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <CornerUpLeft className="size-3.5" />
                                </button>
                            )}
                            {onOpenThread && (
                                <button
                                    type="button"
                                    aria-label={t("messageList.replyInAThread")}
                                    title={t("messageList.replyInAThread")}
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
                                            aria-label={t("messageList.moreForThisMessage")}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            {/* Three dots, as "more" is drawn everywhere else. It was a
                                                sideways smiley, which read as a second
                                                emoji button. */}
                                            <MoreHorizontal className="size-3.5" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="end"
                                        onCloseAutoFocus={keepFocusOnClose}
                                    >
                                        {mine && rewrite && (
                                            <DropdownMenuItem onSelect={() => rewrite(message)}>
                                                <Pencil className="size-3.5" />
                                                {t("messageList.edit")}
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem
                                            variant="danger"
                                            onSelect={() => onDelete(message)}
                                        >
                                            <Trash2 className="size-3.5" />
                                            {t("messageList.delete")}
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </div>
                    )}

                    <EditHistoryDialog
                        emoji={emojiSet}
                        message={showingHistory ? message : null}
                        onOpenChange={(open) => setShowingHistory(open)}
                    />
                </div>
            </MessageMenu>
        </div>
    );
}

/**
 * Whether a message is pinned for the room and whether this reader starred it:
 * the two small marks WhatsApp draws beside a message's time. The pin is
 * everybody's; the star only ever shows to the reader who set it.
 */
function Marks({ pinned, starred }: { pinned: boolean; starred: boolean }) {
    const t = useTranslations("chat");
    if (!pinned && !starred) return null;
    return (
        <span className="inline-flex shrink-0 items-center gap-0.5 self-center text-foreground-subtle">
            {pinned && (
                <span title={t("messageList.pinnedHere")} className="inline-flex">
                    <Pin className="size-3" aria-hidden />
                    <span className="sr-only">{t("messageList.pinnedHere")}</span>
                </span>
            )}
            {starred && (
                <span title={t("messageList.starred")} className="inline-flex">
                    <Star className="size-3 fill-current" aria-hidden />
                    <span className="sr-only">{t("messageList.starred")}</span>
                </span>
            )}
        </span>
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
    const t = useTranslations("chat");
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
                aria-label={t("messageList.openNamed", { name })}
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
                aria-label={
                    kept
                        ? t("messageList.stopKeepingThisPicture")
                        : t("messageList.keepThisPicture")
                }
                title={kept ? t("messageList.keptItIsInYour") : t("messageList.keepThis")}
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
 * Somebody's name or face, in the middle of what they said.
 *
 * The same menu the roster opens, in the place people actually reach for it:
 * every client with rooms in it answers a right-click on a name with what can be
 * done about that person, and a reader looking at a message is already pointing
 * at the name they mean. The roster is a column somebody has to open first, and
 * in a busy channel the person who needs muting is the one on screen, not the
 * one being scrolled to in a list of two hundred.
 *
 * Nothing about yourself, and nothing when the conversation is not one this
 * reader has open - who may do what to whom is decided from the room, and a room
 * that cannot be found is not one to guess about.
 */
function Writer({
    person,
    channelId,
    viewerId,
    onMention,
    onNickname,
    onError,
    children
}: {
    person: MenuPerson;
    /** The conversation the name was read in. The room decides the menu. */
    channelId: string;
    viewerId: string;
    onMention?: (text: string) => void;
    onNickname: (person: MenuPerson) => void;
    onError: (message: string) => void;
    children: React.ReactNode;
}) {
    const { channels, refresh } = useChat();
    const channel = channels.find((entry) => entry.id === channelId);
    if (person.userId === viewerId || !channel) return <>{children}</>;
    return (
        <MemberMenu
            member={person}
            channel={channel}
            viewerId={viewerId}
            onMention={onMention}
            onNickname={onNickname}
            onChanged={refresh}
            onError={onError}
        >
            {children}
        </MemberMenu>
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
    const t = useTranslations("chat");
    const label = t(`messageList.receipt.${receipt}`);

    return (
        <button
            type="button"
            title={t("messageList.stateHint", { label })}
            aria-label={t("messageList.stateInfo", { label })}
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

/** How many cards one message may draw. A message that pastes six rooms is a
 *  message, not six cards: the rest stay the chips they already are in the
 *  sentence. */
const MOST_CARDS = 2;

/**
 * The things a message pointed at that are worth more than a name in the line.
 *
 * Two of them are. A voice room is somewhere to go, and the useful question
 * about one is never its name but who is in it - which is why the card carries
 * the people who are in it **now**, at the moment somebody reads the message,
 * rather than whoever happened to be there when it was pasted. A message
 * somewhere else is worth quoting, for the same reason a reply is: the point of
 * pasting one is what it said.
 *
 * Everything else stays inline. A text channel is a name in a sentence, and a
 * card repeating that name under it would be the sentence twice.
 */
function ReferenceCards({
    message,
    inRoom,
    onJumpTo
}: {
    message: ChatMessageView;
    /** Who is sitting in each voice room right now, gathered once for the whole
     *  conversation by the list above. */
    inRoom: ReadonlyMap<string, readonly VoicePresence[]>;
    /** Scroll to a quoted message rather than navigating to it - see
     *  `MessageListProps`. */
    onJumpTo?: (messageId: string) => void;
}) {
    const cards = message.references.filter(hasCard).slice(0, MOST_CARDS);
    // Called before the early return, which is where a hook has to be.
    const { channels } = useChat();
    const room = channels.find((channel) => channel.id === message.channelId);
    const here = room ? { channelId: room.id, spaceId: room.spaceId } : null;
    if (cards.length === 0) return null;

    return (
        <ul className="mt-1 flex flex-col gap-1">
            {cards.map((found) => (
                <li key={`${found.kind}/${found.id}`}>
                    {found.kind === "channel" ? (
                        <VoiceCard reference={found} inRoom={inRoom.get(found.id) ?? []} />
                    ) : (
                        <QuotedMessageCard reference={found} here={here} onJumpTo={onJumpTo} />
                    )}
                </li>
            ))}
        </ul>
    );
}

/**
 * A voice room somebody pasted: what it is called, who is in it, and the way in.
 *
 * Pressing it walks into the room, which is what opening a voice channel does
 * everywhere else in Chat.
 *
 * Except when the reader is already standing in it, and then there is nothing to
 * press: the card says so and the button is spent. A green Join on the room
 * whose call is on screen behind it is an invitation to do the thing that has
 * already happened, and pressing it looked to everybody like nothing at all.
 */
function VoiceCard({
    reference,
    inRoom
}: {
    reference: ChatReferenceView;
    inRoom: readonly VoicePresence[];
}) {
    const t = useTranslations("chat");
    // The nullable one: a card can be drawn on the guest page, which has no
    // dashboard around it and so no hold above it.
    const held = useHeldCall();
    const joined = held?.session?.channelId === reference.id;

    return (
        <div className="flex max-w-md flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border bg-surface px-3 py-2">
            <Volume2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium" title={reference.name}>
                    {reference.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                    {inRoom.length === 0
                        ? t("messageList.nobodyInHere")
                        : inRoom.map((person) => person.name).join(", ")}
                </span>
            </span>
            {joined ? (
                <span
                    aria-disabled="true"
                    className="pointer-events-none shrink-0 rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground"
                >
                    {t("messageList.joined")}
                </span>
            ) : (
                <Link
                    href={`/chat/c/${reference.id}?join=1`}
                    className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground no-underline hover:bg-primary/90"
                >
                    {t("messageList.join")}
                </Link>
            )}
        </div>
    );
}

/**
 * A link to one message that scrolls when the message is in the conversation
 * on screen, and travels when it is not.
 *
 * Scrolling only for this conversation: one somewhere else is a real journey,
 * which is also what keeps this from rewriting the address to a room the reader
 * is not in. A list with nowhere to scroll - the thread panel - keeps the plain
 * link, whose page opens the message wherever it is.
 */
function MessageLink({
    messageId,
    channelId,
    here,
    onJumpTo,
    className,
    title,
    children
}: {
    messageId: string;
    channelId: string;
    /** The conversation this link is drawn in. */
    here: string | null;
    onJumpTo?: (messageId: string) => void;
    className: string;
    title?: string;
    children: React.ReactNode;
}) {
    const jump = onJumpTo && here === channelId ? onJumpTo : null;

    return (
        <Link
            href={`/chat/c/${channelId}/${messageId}`}
            title={title}
            onClick={
                jump
                    ? (event) => {
                          // A click held with a modifier is somebody asking for
                          // a tab or a window. That is the browser's to answer,
                          // and it needs the address left alone.
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                              return;
                          event.preventDefault();
                          jump(messageId);
                      }
                    : undefined
            }
            className={className}
        >
            {children}
        </Link>
    );
}

/**
 * The line over a reply or a forward naming what it answers.
 *
 * Pressing it lands on the original, the way a quoted message card does. A
 * deleted original has nowhere to land, so its line stays text.
 */
function QuoteLine({
    quote,
    here,
    onJumpTo
}: {
    quote: ChatQuoteView;
    here: string;
    onJumpTo?: (messageId: string) => void;
}) {
    const t = useTranslations("chat");
    const body = (
        <>
            <CornerUpLeft className="size-3 shrink-0" />
            {quote.forwarded && (
                <span className="shrink-0 font-medium">{t("messageList.forwardedFrom")}</span>
            )}
            <span className="shrink-0 font-medium text-foreground">
                {quote.authorName ?? t("messageList.somebodyWhoHasLeft")}
            </span>
            <span className="min-w-0 truncate" title={quote.excerpt}>
                {quote.deleted ? t("messageList.messageDeleted") : quote.excerpt || "attachment"}
            </span>
        </>
    );
    const shape = "mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground";
    if (quote.deleted || !quote.channelId) return <p className={shape}>{body}</p>;

    return (
        <MessageLink
            messageId={quote.id}
            channelId={quote.channelId}
            here={here}
            onJumpTo={onJumpTo}
            title={t("messageList.goToTheOriginalMessage")}
            className={cn(
                shape,
                "w-fit max-w-full rounded no-underline transition-colors hover:text-foreground focus-visible:text-foreground"
            )}
        >
            {body}
        </MessageLink>
    );
}

/**
 * Where a quoted message is, said only where it is not obvious.
 *
 * Every part that matches where the reader already is comes out. Somebody
 * reading a quote of a message from the same conversation does not need to be
 * told the name of the conversation they are looking at, and being told the
 * server they are already in is a breadcrumb that says nothing. What is left is
 * exactly the part that is news: the channel, when it is another one; the
 * server, when it is another server; nothing at all, when it is right here.
 */
function whereFrom(
    reference: ChatReferenceView,
    here: { channelId: string; spaceId: string | null } | null
): string {
    if (here && reference.channelId === here.channelId) return "";
    const parts: string[] = [];
    if (reference.spaceName && reference.spaceId !== (here?.spaceId ?? "")) {
        parts.push(reference.spaceName);
    }
    if (reference.name) {
        parts.push(reference.channelKind === "text" ? `#${reference.name}` : reference.name);
    }
    return parts.join(" / ");
}

/** What a message with no words in it is. A picture is a message, and "No text"
 *  under somebody's name describes nothing anybody wanted to know. */
function saidWhat(reference: ChatReferenceView): string {
    if (reference.excerpt) return reference.excerpt;
    if (reference.attachments === 1) return "1 attachment";
    if (reference.attachments > 1) return `${reference.attachments} attachments`;
    return "No text";
}

/**
 * A message from somewhere else, quoted where it was pasted.
 *
 * Drawn as the message rather than as a link to it, which is the whole point:
 * the address said nothing, and this says what was said. It stays a link, so
 * pressing it lands on the line itself - by scrolling when the line is in the
 * conversation on screen, and by travelling when it is not.
 *
 * What it shows is resolved every time it is read, never stored - so a message
 * edited after somebody pasted it reads as it is now, not as it was when the
 * link was made.
 */
function QuotedMessageCard({
    reference,
    here,
    onJumpTo
}: {
    reference: ChatReferenceView;
    /** The conversation this card is being drawn in, which is what decides how
     *  much of the breadcrumb is worth saying. */
    here: { channelId: string; spaceId: string | null } | null;
    /** Scroll to it rather than navigating - see `MessageListProps`. */
    onJumpTo?: (messageId: string) => void;
}) {
    const t = useTranslations("chat");
    const from = whereFrom(reference, here);

    return (
        <MessageLink
            messageId={reference.id}
            channelId={reference.channelId}
            here={here?.channelId ?? null}
            onJumpTo={onJumpTo}
            className="block max-w-md rounded-md border-l-2 border-primary bg-primary/5 px-3 py-2 no-underline transition-colors hover:bg-primary/10"
        >
            {from && (
                <span className="mb-0.5 block truncate text-[0.6875rem] text-foreground-subtle">
                    {from}
                </span>
            )}
            <span className="flex items-baseline gap-2">
                <span className="truncate text-xs font-medium">
                    {reference.authorName || t("messageList.somebodyWhoHasLeft2")}
                </span>
                {reference.at && (
                    <span className="shrink-0 text-[0.6875rem] text-foreground-subtle">
                        <MessageTime iso={reference.at} />
                    </span>
                )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {saidWhat(reference)}
            </span>
        </MessageLink>
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
                    target: null,
                    title: "",
                    author: "",
                    accent: null,
                    siteName: hostOf(message.link),
                    hasImage: false,
                    description: "",
                    steam: null
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

function DaySeparator({ iso }: { iso: string }) {
    const format = useDisplayFormat();
    return (
        <div className="flex items-center gap-3 px-4 pt-4">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[0.6875rem] font-medium text-foreground-subtle">
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
/**
 * That this file is not the conversation's own.
 *
 * It lives in whoever sent it's Drive, so it is one thing a copy never is:
 * changeable. The owner can edit it and everybody then reads the new one under
 * the old sentence, or delete it and leave the message pointing at nothing. Two
 * words on the chip, because the alternative is a reader discovering it from a
 * download that fails.
 */
function DriveMark() {
    const t = useTranslations("chat");
    return (
        <span
            className="shrink-0 text-muted-foreground"
            title={t("messageList.thisFileLivesInThe")}
        >
            {t("messageList.inDrive")}
        </span>
    );
}

function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
