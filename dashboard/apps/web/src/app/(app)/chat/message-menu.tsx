"use client";

/**
 * What a right-click on a message offers.
 *
 * The same actions the hover row carries, and deliberately so: a menu that can
 * do things the visible controls cannot is a menu people have to find out
 * about. This is the faster way to reach them, not a second set.
 *
 * It wraps the row rather than living inside it, so the whole message is the
 * target - right-clicking the text, the avatar or the empty space to the right
 * all open the same menu, which is what everybody expects from a chat client.
 *
 * Wrapping the whole row is also what takes the browser's own menu away, and
 * with it the only way there was to copy a link somebody wrote or save a picture
 * they sent. So the menu asks what the pointer was over - see `messageTarget` -
 * and puts that first: the link's own actions over a link, the picture's over a
 * picture, and the message's underneath either. Nothing is lost by right-
 * clicking one pixel to the left of where you meant.
 */

import { isPlayable } from "./voice-recorder";
import { copyText, messageLink } from "./links";
import { useAppUrl } from "@/components/app-url";
import { imageItems } from "@/components/image-actions";
import { useRef, useState, type ReactNode } from "react";
import { messageTarget, NOTHING, type MessageTarget } from "./message-target";
import { plainText } from "@/components/rich-text/excerpt";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";
import { AUDIO_FORMATS, extensionOf, saveRecording, type AudioFormat } from "./audio-download";
import {
    Copy,
    Download,
    ExternalLink,
    Flag,
    CornerUpLeft,
    Forward,
    Info,
    Link2,
    Mail,
    MessageCircleReply,
    MessageSquare,
    Pencil,
    Star,
    Trash2
} from "lucide-react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    keepFocusOnClose,
    useToast
} from "@polaris/ui";

export interface MessageActions {
    readonly message: ChatMessageView;
    readonly mine: boolean;
    readonly canPost: boolean;
    readonly canModerate: boolean;
    /** The three a thread does not have: answering, forwarding and rewriting all
     *  happen in the channel, and an item that does nothing is worse than one
     *  that is not there. */
    readonly onReply?: (message: ChatMessageView) => void;
    /**
     * Answer whoever wrote this, where nobody else in the room can read it.
     *
     * Absent on your own words, on a message from an account that is gone, and
     * in a conversation that is already between the two of you - in a direct
     * message every reply is already private, and offering it there would be an
     * item that appears to do something and does nothing.
     */
    readonly onReplyPrivately?: (message: ChatMessageView) => void;
    readonly onForward?: (message: ChatMessageView) => void;
    readonly onEdit?: (message: ChatMessageView) => void;
    readonly onOpenThread?: (message: ChatMessageView) => void;
    readonly onStar: (message: ChatMessageView) => void;
    /**
     * Pick the conversation up again from here.
     *
     * Absent inside a thread, whose unread is its own and would be thrown by a
     * mark placed in the channel's timeline, and on the reader's own message,
     * where it would put a conversation back to unread with nothing waiting in
     * it - a badge of zero, which reads as a menu item that did nothing.
     */
    readonly onMarkUnread?: (message: ChatMessageView) => void;
    readonly onDelete: (message: ChatMessageView) => void;
    /** Say something is wrong with it. Not offered on your own message: the
     *  thing to do about your own words is take them back, which is Delete. */
    readonly onReport: (message: ChatMessageView) => void;
    /** When it was sent, when it arrived, when it was read. */
    readonly onExplain: (message: ChatMessageView) => void;
}

export function MessageMenu({
    actions,
    children
}: {
    actions: MessageActions;
    children: ReactNode;
}) {
    const { message, mine, canPost, canModerate } = actions;
    const baseUrl = useAppUrl();
    const toast = useToast();
    /** Which recording is being converted, so its menu cannot be pressed twice
     *  while a few seconds of encoding are going on. */
    const [saving, setSaving] = useState<string | null>(null);
    /**
     * What the pointer was over when the menu was opened.
     *
     * A ref rather than state: it is written in the same event that opens the
     * menu, and the menu's contents are built after that event - so the value is
     * already there to read, and a message row does not re-render on every press
     * to carry it. Recorded on the press as well as on the menu, because a long
     * press on a touch screen opens this without a context-menu event ever
     * happening.
     */
    const pointed = useRef<MessageTarget>(NOTHING);
    const at = pointed.current;
    const link = at.link;
    const picture = at.image;
    const clip = at.video;
    const announce = (words: string) => toast.show({ title: words });
    // A recording is the one attachment with no way to save it from the message
    // itself: a picture opens into a viewer that offers it and a document is a
    // link, but a player is a player. So the menu is where it lives.
    const recordings = message.attachments.filter((file) => isPlayable(file.contentType));

    /**
     * Save one, in the format that was asked for.
     *
     * Announced on the way in and only on the way out if it went wrong: the
     * original is instant and needs no note, and everything else takes long
     * enough that silence reads as a menu item that did nothing.
     */
    const save = async (file: ChatAttachmentView, format: AudioFormat) => {
        const note = `audio-${file.id}`;
        if (format !== "original") {
            setSaving(file.id);
            toast.show({
                key: note,
                title: "Preparing the file",
                body: "Converted here, in this tab. It stays stored as it was.",
                // Until it is done, however long that is.
                life: 0
            });
        }
        const failure = await saveRecording(`/api/chat/attachments/${file.id}`, file.name, format);
        setSaving(null);
        toast.dismiss(note);
        if (failure) toast.show({ title: failure });
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger
                asChild
                onPointerDown={(event) => {
                    pointed.current = messageTarget(
                        event.target as Element | null,
                        event.currentTarget,
                        baseUrl
                    );
                }}
                onContextMenu={(event) => {
                    pointed.current = messageTarget(
                        event.target as Element | null,
                        event.currentTarget,
                        baseUrl
                    );
                }}
            >
                {children}
            </ContextMenuTrigger>
            {/* Focus is not handed back to the message row on the way out: Reply
                and Edit put the caret in the composer, and the hand-back landed
                a beat later and took it straight out again. */}
            <ContextMenuContent className="w-52" onCloseAutoFocus={keepFocusOnClose}>
                {/* Forwarding and reporting are left out of the picture's own
                    set here: they are about the message, and the message's own
                    items are a few lines below in the same menu. */}
                {picture && (
                    <>
                        {imageItems({
                            image: picture,
                            baseUrl,
                            announce,
                            Item: ContextMenuItem,
                            Separator: ContextMenuSeparator
                        })}
                        <ContextMenuSeparator />
                    </>
                )}

                {/* The same set for a video, less the one item that means
                    nothing for one. Without it a right-click on a clip offered
                    the message's own actions and no way at all to keep the
                    video - which is the thing being right-clicked. */}
                {clip && (
                    <>
                        {imageItems({
                            kind: "video",
                            image: clip,
                            baseUrl,
                            announce,
                            Item: ContextMenuItem,
                            Separator: ContextMenuSeparator
                        })}
                        <ContextMenuSeparator />
                    </>
                )}

                {link && (
                    <>
                        <ContextMenuItem onSelect={() => void copyText(link.copy)}>
                            <Link2 className="size-3.5" />
                            {link.kind === "email" ? "Copy email address" : "Copy link"}
                        </ContextMenuItem>
                        {/* The address as the browser has it, not the one that
                            gets copied: a page inside Polaris opens on this
                            tab's own origin, which is the hostname known to
                            work from here. */}
                        <ContextMenuItem
                            onSelect={() =>
                                window.open(link.open, "_blank", "noopener,noreferrer")
                            }
                        >
                            <ExternalLink className="size-3.5" />
                            {link.kind === "email" ? "Send an email" : "Open link"}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                    </>
                )}

                {canPost && !message.deleted && (
                    <>
                        {actions.onReply && (
                            <ContextMenuItem onSelect={() => actions.onReply?.(message)}>
                                <CornerUpLeft className="size-3.5" />
                                Reply
                                <span className="ml-auto pl-6 text-[0.6875rem] text-foreground-subtle">
                                    R
                                </span>
                            </ContextMenuItem>
                        )}
                        {/* Only where there is somebody to answer and it is not
                            already just the two of you - see `onReplyPrivately`.
                            It leaves the room without saying so: nothing appears
                            here, and what they get is these words quoted in the
                            conversation the two of you would have had anyway. */}
                        {!mine && message.authorId && actions.onReplyPrivately && (
                            <ContextMenuItem
                                onSelect={() => actions.onReplyPrivately?.(message)}
                            >
                                <MessageCircleReply className="size-3.5" />
                                Reply privately
                            </ContextMenuItem>
                        )}
                        {/* Absent rather than refused when whoever wrote it does
                            not allow it. A menu that offers something and then
                            says no is worse than one that offers less. */}
                        {message.forwardable && actions.onForward && (
                            <ContextMenuItem onSelect={() => actions.onForward?.(message)}>
                                <Forward className="size-3.5" />
                                Forward
                            </ContextMenuItem>
                        )}
                        {actions.onOpenThread && (
                            <ContextMenuItem onSelect={() => actions.onOpenThread?.(message)}>
                                <MessageSquare className="size-3.5" />
                                Reply in a thread
                            </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                    </>
                )}

                <ContextMenuItem onSelect={() => actions.onStar(message)}>
                    <Star className="size-3.5" />
                    {message.starred ? "Remove from saved" : "Save"}
                </ContextMenuItem>
                {actions.onMarkUnread && !mine && !message.deleted && (
                    <ContextMenuItem onSelect={() => actions.onMarkUnread?.(message)}>
                        <Mail className="size-3.5" />
                        Mark unread from here
                    </ContextMenuItem>
                )}
                {/* Offered on a deleted message too: the line is still there,
                    replies still hang off it, and its address still opens the
                    conversation at the right place. */}
                <ContextMenuItem
                    onSelect={() =>
                        void copyText(messageLink(baseUrl, message.channelId, message.id))
                    }
                >
                    <Link2 className="size-3.5" />
                    Copy message link
                </ContextMenuItem>
                {/* What it reads as, not what it is stored as. Markdown escapes
                    its punctuation, so copying the source hands back a line full
                    of backslashes for one that reads perfectly well on screen. */}
                {!message.deleted && (
                    <ContextMenuItem onSelect={() => void copyText(plainText(message.body))}>
                        <Copy className="size-3.5" />
                        Copy text
                    </ContextMenuItem>
                )}
                {!message.deleted &&
                    recordings.map((file) => (
                        <ContextMenuSub key={file.id}>
                            <ContextMenuSubTrigger>
                                <Download className="size-3.5" />
                                {/* Named only when there is more than one, since
                                    a voice message has no name worth reading. */}
                                <span className="min-w-0 truncate">
                                    {recordings.length === 1 ? "Download the audio" : file.name}
                                </span>
                            </ContextMenuSubTrigger>
                            {/* A format rather than a file, because what was
                                recorded is a container most desktop players will
                                not open. The first one is what nearly everybody
                                wants; the last is the untouched original. */}
                            <ContextMenuSubContent>
                                {AUDIO_FORMATS.map((choice) => (
                                    <ContextMenuItem
                                        key={choice.format}
                                        disabled={saving === file.id}
                                        onSelect={() => void save(file, choice.format)}
                                    >
                                        {choice.label}
                                        {choice.format === "original" && (
                                            <span className="ml-auto pl-4 text-[0.6875rem] uppercase text-foreground-subtle">
                                                {extensionOf(file.name)}
                                            </span>
                                        )}
                                    </ContextMenuItem>
                                ))}
                            </ContextMenuSubContent>
                        </ContextMenuSub>
                    ))}

                {/* Only where there are ticks to explain, which is exactly a
                    one-to-one conversation, your own message, and both people
                    allowing them - the same rule that decides whether the ticks
                    are drawn, asked once on the server and carried here. */}
                {message.receipt && !message.deleted && (
                    <ContextMenuItem onSelect={() => actions.onExplain(message)}>
                        <Info className="size-3.5" />
                        Information
                    </ContextMenuItem>
                )}

                {!mine && !message.deleted && (
                    <>
                        <ContextMenuSeparator />
                        {/* Red. It is the one consequence in this menu, and
                            reading like Copy is how a menu stops saying which of
                            its items are heavy.

                            Reporting the account is deliberately not here as
                            well: this menu is about the message, and the account
                            has its own menu on the name. Two reports side by side
                            made the common one - the message - a choice somebody
                            had to read twice. */}
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => actions.onReport(message)}
                        >
                            <Flag className="size-3.5" />
                            Report this message
                        </ContextMenuItem>
                    </>
                )}

                {canPost && !message.deleted && (mine || canModerate) && (
                    <>
                        <ContextMenuSeparator />
                        {/* The keys said out loud, because a shortcut nobody is
                            told about is a shortcut nobody uses. Both act on the
                            message under the pointer, which is this one. */}
                        {mine && actions.onEdit && (
                            <ContextMenuItem onSelect={() => actions.onEdit?.(message)}>
                                <Pencil className="size-3.5" />
                                Edit
                                <span className="ml-auto pl-6 text-[0.6875rem] text-foreground-subtle">
                                    F2
                                </span>
                            </ContextMenuItem>
                        )}
                        <ContextMenuItem
                            variant="danger"
                            onSelect={() => actions.onDelete(message)}
                        >
                            <Trash2 className="size-3.5" />
                            Delete
                            <span className="ml-auto pl-6 text-[0.6875rem] text-foreground-subtle">
                                Del
                            </span>
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
