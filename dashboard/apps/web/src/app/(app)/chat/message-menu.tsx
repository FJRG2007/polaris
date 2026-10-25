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

import * as core from "@polaris/core";
import { isPlayable } from "./voice-recorder";
import { setReminderAction } from "./actions";
import { ScheduleDialog } from "./schedule-dialog";
import type { SpaceEmojiScope } from "./space-emoji";
import { EmojiFace } from "@/components/rich-text/custom-emoji";
import { browserCanSpeak, speakInBrowser } from "@/lib/polar/browser-voice";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import { REMINDER_PRESETS, reminderMoment, type ReminderPreset } from "./reminder-times";
import { copyText, messageLink } from "./links";
import { useAppUrl } from "@/components/app-url";
import { imageItems } from "@/components/image-actions";
import { useRef, useState, type ReactNode } from "react";
import { plainText } from "@/components/rich-text/excerpt";
import { messageTarget, NOTHING, type MessageTarget } from "./message-target";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";
import type { DeleteMessage } from "./delete-message";
import { AUDIO_FORMATS, extensionOf, saveRecording, type AudioFormat } from "./audio-download";
import {
    AlarmClock,
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
    Pin,
    PinOff,
    SmilePlus,
    Star,
    Trash2,
    Volume2
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
    useToast,
    ShortcutHint
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
    /** Whether the room has this one pinned, which turns Pin into Unpin. */
    readonly pinned?: boolean;
    /** Pin it for everybody, or take the pin off. Absent where this reader may
     *  not - see `pinsAllowed` - and inside a thread. */
    readonly onPin?: (message: ChatMessageView, pinned: boolean) => void;
    /**
     * Pick the conversation up again from here.
     *
     * Absent inside a thread, whose unread is its own and would be thrown by a
     * mark placed in the channel's timeline, and on the reader's own message,
     * where it would put a conversation back to unread with nothing waiting in
     * it - a badge of zero, which reads as a menu item that did nothing.
     */
    readonly onMarkUnread?: (message: ChatMessageView) => void;
    readonly onDelete: DeleteMessage;
    /** Say something is wrong with it. Not offered on your own message: the
     *  thing to do about your own words is take them back, which is Delete. */
    readonly onReport: (message: ChatMessageView) => void;
    /** When it was sent, when it arrived, when it was read. */
    readonly onExplain: (message: ChatMessageView) => void;
    /**
     * React with one emoji - the same press the hover bar's faces make, so the
     * menu's row of faces records the habit the same way. Absent where nobody
     * may react, which takes the whole row away.
     */
    readonly onReact?: (messageId: string, emoji: string) => void;
    /** The faces the menu's row offers: this reader's most recent first. */
    readonly quick?: readonly string[];
    /** The space's own emoji, to draw a custom face in the row. */
    readonly emoji?: SpaceEmojiScope | null;
    /** Open the full emoji picker beside the message. */
    readonly onAddReaction?: () => void;
}

/** Labels for the reminder presets, in the order the menu lists them. */
const PRESET_LABELS = {
    in15Minutes: "messageMenu.in15Minutes",
    in1Hour: "messageMenu.in1Hour",
    in3Hours: "messageMenu.in3Hours",
    tomorrow: "messageMenu.tomorrow",
    nextMonday: "messageMenu.nextMonday"
} as const satisfies Record<ReminderPreset, string>;

export function MessageMenu({
    actions,
    children
}: {
    actions: MessageActions;
    children: ReactNode;
}) {
    const t = useTranslations("chat");
    const { message, mine, canPost, canModerate } = actions;
    const baseUrl = useAppUrl();
    const toast = useToast();
    const locale = useLocale();
    const format = useDisplayFormat();
    const { timeZone } = useDisplayPreferences();
    /** The custom-time dialog, which outlives the menu that opened it. */
    const [choosing, setChoosing] = useState(false);
    const [reminding, setReminding] = useState(false);
    const [reminderError, setReminderError] = useState<string | undefined>();
    /** Which recording is being converted, so its menu cannot be pressed twice
     *  while a few seconds of encoding are going on. */
    const [saving, setSaving] = useState<string | null>(null);
    /**
     * What the pointer was over when the menu was opened.
     *
     * Two halves, and the second one is not optional. The ref records the
     * gesture, on the press as well as on the context-menu event, because a long
     * press on a touch screen opens this without a context-menu event ever
     * happening - and a ref costs no render on a press that opens nothing.
     *
     * But the menu's items are React elements, built when this row last
     * rendered, not when the menu opens. Reading the ref straight into the
     * markup meant the items were always one gesture behind: the first
     * right-click on a picture recorded it and drew a menu with no picture
     * section, and it only appeared once something else re-rendered the row -
     * opening the picture in the viewer, which is exactly what people did, after
     * which the menu looked right for ever and the bug looked like it had never
     * been there. So opening the menu settles what was under the pointer into
     * state, which is the render the items are built in.
     */
    const pointed = useRef<MessageTarget>(NOTHING);
    const [at, setAt] = useState<MessageTarget>(NOTHING);
    const link = at.link;
    const picture = at.image;
    const clip = at.video;
    const announce = (words: string) => toast.show({ title: words });
    /**
     * The attachment under the pointer, when it was on one.
     *
     * Its download is offered only then. A right-click on the text of a message
     * with five files used to list five downloads under the message's own
     * items, which is a menu about the files when the press was about the
     * words. A picture and a clip already carry their own save in the sections
     * above, so this is for the kinds that have none: a recording, which needs
     * a format, and a document, which needs a link.
     */
    const pointedFile = at.attachment
        ? (message.attachments.find((file) => file.id === at.attachment) ?? null)
        : null;
    const recording = pointedFile && isPlayable(pointedFile.contentType) ? pointedFile : null;
    const loose = pointedFile && !recording && !picture && !clip ? pointedFile : null;
    const reactable =
        canPost && !message.deleted && message.kind !== "system" && actions.onReact;
    const remindable = !message.deleted && message.kind !== "system";
    const speakable = !message.deleted && Boolean(message.body.trim()) && browserCanSpeak();

    /** Set the reminder, and say back when it is for. */
    const remind = async (dueAt: Date): Promise<boolean> => {
        setReminding(true);
        const result = await setReminderAction({
            messageId: message.id,
            dueAt: dueAt.toISOString()
        }).catch(() => ({ error: t("errors.schedule.noDate"), dueAt: undefined }));
        setReminding(false);
        if (result.error || !result.dueAt) {
            const words = result.error ?? t("errors.schedule.noDate");
            if (choosing) setReminderError(words);
            else toast.show({ title: words });
            return false;
        }
        const when = new Date(result.dueAt);
        announce(
            t("messageMenu.reminderSet", { date: format.date(when), time: format.time(when) })
        );
        return true;
    };

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
                title: t("messageMenu.preparingTheFile"),
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
        <>
            <ContextMenu
                // Radix runs the trigger's own handler before it opens, so by the
                // time this fires the gesture has already been read. Both updates
                // land in one render, which is the one the items are built in.
                onOpenChange={(open) => {
                    if (open) setAt(pointed.current);
                }}
            >
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
                <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocusOnClose}>
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

                    {/* An ordinary download: the route serves it as an
                        attachment, so it is a link rather than anything this has to
                        do. */}
                    {!message.deleted && loose && (
                        <>
                            <ContextMenuItem asChild>
                                <a
                                    href={`/api/chat/attachments/${loose.id}?download=1`}
                                    download={loose.name}
                                >
                                    <Download className="size-3.5" />
                                    <span className="min-w-0 truncate" title={loose.name}>
                                        {t("messageMenu.download")}
                                    </span>
                                </a>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                        </>
                    )}

                    {!message.deleted && recording && (
                        <>
                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <Download className="size-3.5" />
                                    <span className="min-w-0 truncate">
                                        {t("messageMenu.downloadTheAudio")}
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
                                            disabled={saving === recording.id}
                                            onSelect={() => void save(recording, choice.format)}
                                        >
                                            {t(choice.label)}
                                            {choice.format === "original" && (
                                                <span className="ml-auto pl-4 text-[0.6875rem] uppercase text-foreground-subtle">
                                                    {extensionOf(recording.name)}
                                                </span>
                                            )}
                                        </ContextMenuItem>
                                    ))}
                                </ContextMenuSubContent>
                            </ContextMenuSub>
                            <ContextMenuSeparator />
                        </>
                    )}

                    {link && (
                        <>
                            <ContextMenuItem onSelect={() => void copyText(link.copy)}>
                                <Link2 className="size-3.5" />
                                {link.kind === "email"
                                    ? t("messageMenu.copyEmailAddress")
                                    : t("messageMenu.copyLink")}
                            </ContextMenuItem>
                            {/* The address as the browser has it, not the one that
                                gets copied: a page inside Polaris opens on this
                                tab's own origin, which is the hostname known to
                                work from here. */}
                            <ContextMenuItem
                                onSelect={() => window.open(link.open, "_blank", "noopener,noreferrer")}
                            >
                                <ExternalLink className="size-3.5" />
                                {link.kind === "email"
                                    ? t("messageMenu.sendAnEmail")
                                    : t("messageMenu.openLink")}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                        </>
                    )}

                    {/* The faces first, the way Discord opens this menu: the most
                        common thing anybody does to a message is react to it. The
                        same faces and the same press as the hover bar. */}
                    {reactable && (
                        <>
                            {(actions.quick ?? []).length > 0 && (
                                <div className="flex items-center gap-1 px-1 py-1">
                                    {(actions.quick ?? []).map((choice) => {
                                        const ref = core.parseCustomEmojiToken(choice);
                                        const named = ref ? core.customEmojiFallback(ref) : choice;
                                        return (
                                            <ContextMenuItem
                                                key={choice}
                                                aria-label={t("messageList.reactWith", {
                                                    emoji: named
                                                })}
                                                title={t("messageList.reactWith", { emoji: named })}
                                                onSelect={() => actions.onReact?.(message.id, choice)}
                                                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted p-0 text-lg"
                                            >
                                                <EmojiFace
                                                    value={choice}
                                                    set={actions.emoji?.set ?? null}
                                                />
                                            </ContextMenuItem>
                                        );
                                    })}
                                </div>
                            )}
                            {actions.onAddReaction && (
                                <ContextMenuItem onSelect={() => actions.onAddReaction?.()}>
                                    <SmilePlus className="size-3.5" />
                                    {t("messageMenu.addReaction")}
                                </ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                        </>
                    )}

                    {canPost && !message.deleted && (
                        <>
                            {/* The keys said out loud, because a shortcut nobody is
                                told about is a shortcut nobody uses. */}
                            {mine && actions.onEdit && (
                                <ContextMenuItem onSelect={() => actions.onEdit?.(message)}>
                                    <Pencil className="size-3.5" />
                                    {t("messageMenu.edit")}
                                    {/* i18n-ignore: a key on the keyboard */}
                                    <ShortcutHint id="chat.edit" />
                                </ContextMenuItem>
                            )}
                            {actions.onReply && (
                                <ContextMenuItem onSelect={() => actions.onReply?.(message)}>
                                    <CornerUpLeft className="size-3.5" />
                                    {t("messageMenu.reply")}
                                    {/* i18n-ignore: a key on the keyboard */}
                                    <ShortcutHint id="chat.reply" />
                                </ContextMenuItem>
                            )}
                            {/* Only where there is somebody to answer and it is not
                                already just the two of you - see `onReplyPrivately`.
                                It leaves the room without saying so: nothing appears
                                here, and what they get is these words quoted in the
                                conversation the two of you would have had anyway. */}
                            {!mine && message.authorId && actions.onReplyPrivately && (
                                <ContextMenuItem onSelect={() => actions.onReplyPrivately?.(message)}>
                                    <MessageCircleReply className="size-3.5" />
                                    {t("messageMenu.replyPrivately")}
                                </ContextMenuItem>
                            )}
                            {/* Absent rather than refused when whoever wrote it does
                                not allow it. A menu that offers something and then
                                says no is worse than one that offers less. */}
                            {message.forwardable && actions.onForward && (
                                <ContextMenuItem onSelect={() => actions.onForward?.(message)}>
                                    <Forward className="size-3.5" />
                                    {t("messageMenu.forward")}
                                </ContextMenuItem>
                            )}
                            {actions.onOpenThread && (
                                <ContextMenuItem onSelect={() => actions.onOpenThread?.(message)}>
                                    <MessageSquare className="size-3.5" />
                                    {t("messageMenu.replyInAThread")}
                                </ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                        </>
                    )}

                    {/* What it reads as, not what it is stored as. Markdown escapes
                        its punctuation, so copying the source hands back a line full
                        of backslashes for one that reads perfectly well on screen. */}
                    {!message.deleted && (
                        <ContextMenuItem onSelect={() => void copyText(plainText(message.body))}>
                            <Copy className="size-3.5" />
                            {t("messageMenu.copyText")}
                            <ShortcutHint id="chat.copy" />
                        </ContextMenuItem>
                    )}
                    {actions.onPin && !message.deleted && message.kind !== "system" && (
                        <ContextMenuItem
                            onSelect={() => actions.onPin?.(message, Boolean(actions.pinned))}
                        >
                            {actions.pinned ? (
                                <PinOff className="size-3.5" />
                            ) : (
                                <Pin className="size-3.5" />
                            )}
                            {actions.pinned ? t("messageMenu.unpin") : t("messageMenu.pin")}
                        </ContextMenuItem>
                    )}
                    {/* Two different things, side by side the way WhatsApp puts them:
                        the star is this reader's own bookmark, the pin is the
                        room's. */}
                    <ContextMenuItem onSelect={() => actions.onStar(message)}>
                        <Star className="size-3.5" />
                        {message.starred ? t("messageMenu.removeFromSaved") : t("messageMenu.save")}
                    </ContextMenuItem>
                    {/* Private to this reader. Each preset says what it is for when
                        it is a clock reading rather than a wait. */}
                    {remindable && (
                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <AlarmClock className="size-3.5" />
                                {t("messageMenu.remindMe")}
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="w-52">
                                {REMINDER_PRESETS.map((preset) => {
                                    const moment = reminderMoment(preset, new Date(), timeZone);
                                    const clock = preset === "tomorrow" || preset === "nextMonday";
                                    return (
                                        <ContextMenuItem
                                            key={preset}
                                            disabled={reminding}
                                            onSelect={() => void remind(moment)}
                                        >
                                            <span className="min-w-0 truncate">
                                                {t(PRESET_LABELS[preset])}
                                            </span>
                                            {clock && (
                                                <span className="ml-auto shrink-0 pl-4 text-xs text-foreground-subtle">
                                                    {format.time(moment)}
                                                </span>
                                            )}
                                        </ContextMenuItem>
                                    );
                                })}
                                <ContextMenuSeparator />
                                <ContextMenuItem onSelect={() => setChoosing(true)}>
                                    {t("messageMenu.custom")}
                                </ContextMenuItem>
                            </ContextMenuSubContent>
                        </ContextMenuSub>
                    )}
                    {actions.onMarkUnread && !mine && !message.deleted && (
                        <ContextMenuItem onSelect={() => actions.onMarkUnread?.(message)}>
                            <Mail className="size-3.5" />
                            {t("messageMenu.markUnreadFromHere")}
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
                        {t("messageMenu.copyMessageLink")}
                    </ContextMenuItem>
                    {/* Read by the browser's own voice, in the reader's language.
                        Only where the browser has one. */}
                    {speakable && (
                        <ContextMenuItem
                            onSelect={() => void speakInBrowser(plainText(message.body), locale)}
                        >
                            <Volume2 className="size-3.5" />
                            {t("messageMenu.speak")}
                        </ContextMenuItem>
                    )}

                    {/* Only where there are ticks to explain, which is exactly a
                        one-to-one conversation, your own message, and both people
                        allowing them - the same rule that decides whether the ticks
                        are drawn, asked once on the server and carried here. */}
                    {message.receipt && !message.deleted && (
                        <ContextMenuItem onSelect={() => actions.onExplain(message)}>
                            <Info className="size-3.5" />
                            {t("messageMenu.information")}
                        </ContextMenuItem>
                    )}

                    {canPost && !message.deleted && (mine || canModerate) && (
                        <>
                            <ContextMenuSeparator />
                            {/* Shift held skips the question - only the click
                                knows it was. A key press or a tap arrives as a
                                click as well. */}
                            <ContextMenuItem
                                variant="danger"
                                onClick={(event) => actions.onDelete(message, event.shiftKey)}
                            >
                                <Trash2 className="size-3.5" />
                                {t("messageMenu.delete")}
                                <ShortcutHint id="chat.delete" />
                            </ContextMenuItem>
                        </>
                    )}

                    {!mine && !message.deleted && (
                        <>
                            <ContextMenuSeparator />
                            {/* Red. It is the one consequence in this menu, and
                                reading like Copy is how a menu stops saying which of
                                its items are heavy.

                                Reporting the account is deliberately not here as
                                well: this menu is about the message, and the account
                                has its own menu on the name. */}
                            <ContextMenuItem
                                variant="danger"
                                onSelect={() => actions.onReport(message)}
                            >
                                <Flag className="size-3.5" />
                                {t("messageMenu.reportThisMessage")}
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>
            {/* Outside the menu, which is gone by the time a date is typed. */}
            <ScheduleDialog
                open={choosing}
                onOpenChange={(open) => {
                    setChoosing(open);
                    if (!open) setReminderError(undefined);
                }}
                presets={false}
                busy={reminding}
                error={reminderError}
                words={{
                    title: t("reminders.remindMeAboutThis"),
                    description: t("reminders.youGetANotification"),
                    confirm: t("reminders.setReminder"),
                    busy: t("reminders.setting"),
                    summary: (date, time) => t("reminders.remindsOn", { date, time })
                }}
                onConfirm={(dueAt) =>
                    void remind(new Date(dueAt)).then((done) => done && setChoosing(false))
                }
            />
        </>
    );
}
