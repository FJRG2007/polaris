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
import { EmojiFace, type CustomEmojiSet } from "@/components/rich-text/custom-emoji";
import { browserCanSpeak, speakInBrowser, type BrowserSpeech } from "@/lib/polar/browser-voice";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat, useDisplayPreferences } from "@/components/display-format";
import { REMINDER_PRESETS, reminderMoment, type ReminderPreset } from "./reminder-times";
import { copyText, messageLink } from "./links";
import { useAppUrl } from "@/components/app-url";
import { openLink } from "@/lib/open-link";
import { imageItems } from "@/components/image-actions";
import {
    cloneElement,
    Fragment,
    isValidElement,
    useRef,
    useState,
    useSyncExternalStore,
    type ReactNode
} from "react";
import { useTouchScreen } from "@/components/use-phone";
import { useLongPress } from "./long-press";
import { MessageSheet } from "./message-sheet";
import {
    filled,
    type MenuEntry,
    type MenuModel,
    type MenuReactions,
    type MenuSection
} from "./message-menu-model";
import { plainText } from "@/components/rich-text/excerpt";
import { useTranslateToggle } from "./translated-body";
import { messageTarget, NOTHING, type MessageTarget } from "./message-target";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";
import type { DeleteMessage } from "./delete-message";
import { useHideMessage } from "./vanish-controls";
import { runAction } from "@/lib/run-action";
import { keepMessageAction, setKeepableAction, unkeepMessageAction } from "./vanish-actions";
import { AUDIO_FORMATS, extensionOf, saveRecording, type AudioFormat } from "./audio-download";
import {
    AlarmClock,
    Bookmark,
    BookmarkX,
    Copy,
    Download,
    ExternalLink,
    Flag,
    CornerUpLeft,
    Forward,
    Info,
    Languages,
    Link2,
    Mail,
    MessageCircleReply,
    MessageSquare,
    Pencil,
    Pin,
    PinOff,
    SmilePlus,
    Star,
    EyeOff,
    Trash2,
    Volume2,
    VolumeX
} from "lucide-react";

/** The one message being read aloud, page-wide: reading another stops it. */
let reading: { messageId: string; speech: BrowserSpeech } | null = null;
const readers = new Set<() => void>();
const readingChanged = () => readers.forEach((listener) => listener());

function readAloud(messageId: string, text: string, locale: string): void {
    stopReading();
    const speech = speakInBrowser(text, locale);
    reading = { messageId, speech };
    readingChanged();
    void speech.done.then(() => {
        if (reading?.speech !== speech) return;
        reading = null;
        readingChanged();
    });
}

function stopReading(): void {
    reading?.speech.cancel();
    reading = null;
    readingChanged();
}

function useReadingMessage(): string | null {
    return useSyncExternalStore(
        (listener) => {
            readers.add(listener);
            return () => readers.delete(listener);
        },
        () => reading?.messageId ?? null,
        () => null
    );
}
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
    /** A finger rather than a mouse: the hold opens a sheet instead of the menu. */
    const touch = useTouchScreen();
    const [sheetOpen, setSheetOpen] = useState(false);
    const longPress = useLongPress((target, row) => {
        pointed.current = messageTarget(target, row, baseUrl);
        setAt(pointed.current);
        setSheetOpen(true);
    });
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
    const hide = useHideMessage();
    /**
     * A line Polaris wrote itself - a call ended, somebody joined. It is reacted
     * to and answered like any message, as Discord's are, but nobody wrote it:
     * there is nothing to rewrite, nobody to report or answer privately, and
     * taking it down is not offered rather than offered and refused.
     */
    const notice = message.kind === "system";
    // Keep in chat (`lib/chat/keep.ts`): the server decides; these only offer
    // what it said this reader may do, and say its refusal if it changed.
    const keep = message.keep;
    const disappearing = Boolean(message.expiresAt || keep?.kept);
    const keepCall = (call: () => Promise<{ error?: string }>) =>
        void (async () => {
            const say = (words: string) => toast.show({ title: words });
            const result = await runAction(call, say);
            if (result?.error) say(result.error);
        })();
    const reactable = canPost && !message.deleted && actions.onReact;
    const remindable = !message.deleted && message.kind !== "system";
    const speakable = !message.deleted && Boolean(message.body.trim()) && browserCanSpeak();
    const readingThis = useReadingMessage() === message.id;
    /** Only where the reader has an app that translates, and only for words. */
    const translation = useTranslateToggle(message);

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

    /** Settles what was pressed into state, the render the items are built in. */
    const point = (target: Element | null, row: Element) => {
        pointed.current = messageTarget(target, row, baseUrl);
    };

    // ------------------------------------------------------------------
    // The actions, once, for the menu and the sheet alike. Whether each one
    // is offered is decided here and nowhere else.
    // ------------------------------------------------------------------

    const target: MenuSection[] = [
        // Forwarding and reporting are left out of the picture's own set here:
        // they are about the message, and the message's own items are a few
        // lines below in the same menu.
        {
            key: "picture",
            draw: picture
                ? (parts) => imageItems({ image: picture, baseUrl, announce, ...parts })
                : undefined
        },
        // The same set for a video, less the one item that means nothing for
        // one. Without it a right-click on a clip offered the message's own
        // actions and no way at all to keep the video - which is the thing
        // being right-clicked.
        {
            key: "video",
            draw: clip
                ? (parts) => imageItems({ kind: "video", image: clip, baseUrl, announce, ...parts })
                : undefined
        },
        {
            key: "file",
            entries: [
                // An ordinary download: the route serves it as an attachment, so
                // it is a link rather than anything this has to do.
                !message.deleted &&
                    !message.shielded &&
                    loose && {
                        key: "download",
                        icon: Download,
                        label: t("messageMenu.download"),
                        title: loose.name,
                        link: {
                            href: `/api/chat/attachments/${loose.id}?download=1`,
                            download: loose.name
                        }
                    },
                // A format rather than a file, because what was recorded is a
                // container most desktop players will not open. The first one is
                // what nearly everybody wants; the last is the untouched original.
                !message.deleted &&
                    !message.shielded &&
                    recording && {
                        key: "audio",
                        icon: Download,
                        label: t("messageMenu.downloadTheAudio"),
                        sub: [
                            AUDIO_FORMATS.map((choice) => ({
                                key: choice.format,
                                label: t(choice.label),
                                disabled: saving === recording.id,
                                trailing:
                                    choice.format === "original" ? (
                                        <span className="uppercase">{extensionOf(recording.name)}</span>
                                    ) : undefined,
                                run: () => void save(recording, choice.format)
                            }))
                        ]
                    }
            ].filter(present)
        },
        {
            key: "link",
            entries: link
                ? [
                      {
                          key: "copyLink",
                          icon: Link2,
                          label:
                              link.kind === "email"
                                  ? t("messageMenu.copyEmailAddress")
                                  : t("messageMenu.copyLink"),
                          run: () => void copyText(link.copy)
                      },
                      // The address as the browser has it, not the one that gets
                      // copied: a page inside Polaris opens on this tab's own
                      // origin, which is the hostname known to work from here.
                      {
                          key: "openLink",
                          icon: ExternalLink,
                          label:
                              link.kind === "email"
                                  ? t("messageMenu.sendAnEmail")
                                  : t("messageMenu.openLink"),
                          run: () => openLink(link.open)
                      }
                  ]
                : []
        }
    ];

    // The faces first, the way Discord opens this menu: the most common thing
    // anybody does to a message is react to it. The same faces and the same
    // press as the hover bar.
    const reactions: MenuReactions | null = reactable
        ? {
              quick: actions.quick ?? [],
              react: (choice) => actions.onReact?.(message.id, choice),
              more: actions.onAddReaction
          }
        : null;

    const sections: MenuSection[] = [
        {
            key: "respond",
            entries:
                canPost && !message.deleted
                    ? [
                          // The keys said out loud, because a shortcut nobody is
                          // told about is a shortcut nobody uses.
                          mine &&
                              actions.onEdit &&
                              !notice && {
                                  key: "edit",
                                  icon: Pencil,
                                  label: t("messageMenu.edit"),
                                  // i18n-ignore: a key on the keyboard
                                  hint: <ShortcutHint id="chat.edit" />,
                                  run: () => actions.onEdit?.(message)
                              },
                          actions.onReply && {
                              key: "reply",
                              icon: CornerUpLeft,
                              label: t("messageMenu.reply"),
                              // i18n-ignore: a key on the keyboard
                              hint: <ShortcutHint id="chat.reply" />,
                              run: () => actions.onReply?.(message)
                          },
                          // Only where there is somebody to answer and it is not
                          // already just the two of you - see `onReplyPrivately`.
                          !mine &&
                              message.authorId &&
                              actions.onReplyPrivately && {
                                  key: "replyPrivately",
                                  icon: MessageCircleReply,
                                  label: t("messageMenu.replyPrivately"),
                                  run: () => actions.onReplyPrivately?.(message)
                              },
                          // Absent rather than refused whenever it cannot travel -
                          // the author does not allow it, or it is one of the
                          // exceptions (`forwardBlock`, folded into `forwardable` on
                          // the server).
                          message.forwardable &&
                              actions.onForward &&
                              !notice && {
                                  key: "forward",
                                  icon: Forward,
                                  label: t("messageMenu.forward"),
                                  run: () => actions.onForward?.(message)
                              },
                          actions.onOpenThread &&
                              !notice && {
                                  key: "thread",
                                  icon: MessageSquare,
                                  label: t("messageMenu.replyInAThread"),
                                  run: () => actions.onOpenThread?.(message)
                              }
                      ].filter(present)
                    : []
        },
        {
            // Discord's order: the conversation's place, then this reader's own
            // marks, then what can be taken away from it.
            key: "keep",
            entries: [
                actions.onMarkUnread &&
                    !mine &&
                    !message.deleted && {
                        key: "markUnread",
                        icon: Mail,
                        label: t("messageMenu.markUnreadFromHere"),
                        run: () => actions.onMarkUnread?.(message)
                    },
                actions.onPin &&
                    !message.deleted &&
                    message.kind !== "system" && {
                        key: "pin",
                        icon: actions.pinned ? PinOff : Pin,
                        label: actions.pinned ? t("messageMenu.unpin") : t("messageMenu.pin"),
                        run: () => actions.onPin?.(message, Boolean(actions.pinned))
                    },
                // Two different things, side by side the way WhatsApp puts them:
                // the star is this reader's own bookmark, the pin is the room's.
                {
                    key: "star",
                    icon: Star,
                    label: message.starred
                        ? t("messageMenu.removeFromSaved")
                        : t("messageMenu.save"),
                    run: () => actions.onStar(message)
                },
                !notice &&
                    keep?.mayKeep && {
                        key: "keepInChat",
                        icon: Bookmark,
                        label: t("messageMenu.keepInChat"),
                        run: () => keepCall(() => keepMessageAction(message.id))
                    },
                !notice &&
                    keep?.kept &&
                    (keep.keptByMe || mine) && {
                        key: "unkeep",
                        icon: BookmarkX,
                        label: mine ? t("messageMenu.unkeepForEverybody") : t("messageMenu.unkeep"),
                        run: () => keepCall(() => unkeepMessageAction(message.id))
                    },
                !notice &&
                    mine &&
                    disappearing && {
                        key: "keepable",
                        icon: Bookmark,
                        label:
                            message.keepable === false
                                ? t("messageMenu.allowKeeping")
                                : t("messageMenu.forbidKeeping"),
                        run: () =>
                            keepCall(() =>
                                setKeepableAction({
                                    messageId: message.id,
                                    keepable: message.keepable === false
                                })
                            )
                    },
                // Private to this reader. Each preset says what it is for when it
                // is a clock reading rather than a wait.
                remindable && {
                    key: "remind",
                    icon: AlarmClock,
                    label: t("messageMenu.remindMe"),
                    sub: [
                        REMINDER_PRESETS.map((preset) => {
                            const moment = reminderMoment(preset, new Date(), timeZone);
                            const clock = preset === "tomorrow" || preset === "nextMonday";
                            return {
                                key: preset,
                                label: t(PRESET_LABELS[preset]),
                                disabled: reminding,
                                trailing: clock ? format.time(moment) : undefined,
                                run: () => void remind(moment)
                            };
                        }),
                        [
                            {
                                key: "custom",
                                label: t("messageMenu.custom"),
                                run: () => setChoosing(true)
                            }
                        ]
                    ]
                },
                // What it reads as, not what it is stored as. Markdown escapes its
                // punctuation, so copying the source hands back a line full of
                // backslashes for one that reads perfectly well on screen.
                !message.deleted && {
                    key: "copyText",
                    icon: Copy,
                    label: t("messageMenu.copyText"),
                    hint: <ShortcutHint id="chat.copy" />,
                    run: () => void copyText(plainText(message.body))
                },
                // On this reader's screen only: the message as sent is untouched,
                // and the original is one press away.
                translation && {
                    key: "translate",
                    icon: Languages,
                    label: translation.showing
                        ? t("translation.showOriginal")
                        : t("translation.translate"),
                    run: () => translation.run()
                },
                // Offered on a deleted message too: the line is still there,
                // replies still hang off it, and its address still opens the
                // conversation at the right place.
                {
                    key: "copyMessageLink",
                    icon: Link2,
                    label: t("messageMenu.copyMessageLink"),
                    run: () => void copyText(messageLink(baseUrl, message.channelId, message.id))
                },
                // Read by the browser's own voice, in the reader's language. Only
                // where the browser has one.
                speakable &&
                    (readingThis
                        ? {
                              key: "speak",
                              icon: VolumeX,
                              label: t("messageMenu.stopSpeaking"),
                              run: stopReading
                          }
                        : {
                              key: "speak",
                              icon: Volume2,
                              label: t("messageMenu.speak"),
                              run: () => readAloud(message.id, plainText(message.body), locale)
                          }),
                // Only where there are ticks to explain, which is exactly a
                // one-to-one or a group, your own message, and the settings
                // allowing them - the same rule that decides whether the ticks
                // are drawn, asked once on the server and carried here.
                message.receipt &&
                    !message.deleted && {
                        key: "information",
                        icon: Info,
                        label: t("messageMenu.information"),
                        run: () => actions.onExplain(message)
                    }
            ].filter(present)
        },
        {
            key: "remove",
            entries: [
                // Anybody's message, gone from this reader's screen only. Absent
                // where there is no conversation to hide it from.
                hide &&
                    !notice && {
                        key: "deleteForMe",
                        icon: EyeOff,
                        label: t("messageMenu.deleteForMe"),
                        danger: true,
                        run: () => hide(message)
                    },
                // Shift held skips the question - only the click knows it was.
                canPost &&
                    !message.deleted &&
                    !notice &&
                    (mine || canModerate) && {
                        key: "delete",
                        icon: Trash2,
                        label: t("messageMenu.delete"),
                        hint: <ShortcutHint id="chat.delete" />,
                        danger: true,
                        run: (shift: boolean) => actions.onDelete(message, shift)
                    }
            ].filter(present)
        },
        {
            // Red. It is the one consequence in this menu, and reading like Copy
            // is how a menu stops saying which of its items are heavy.
            //
            // Reporting the account is deliberately not here as well: this menu
            // is about the message, and the account has its own menu on the name.
            key: "report",
            entries:
                !mine && !message.deleted && !notice
                    ? [
                          {
                              key: "report",
                              icon: Flag,
                              label: t("messageMenu.reportThisMessage"),
                              danger: true,
                              run: () => actions.onReport(message)
                          }
                      ]
                    : []
        }
    ];

    const model: MenuModel = { target, reactions, sections };

    return (
        <>
            {touch ? (
                // On a touch screen the hold opens the sheet; the right-click
                // menu, which would open a desktop dropdown under the finger, is
                // not mounted at all.
                <div
                    className="contents"
                    {...longPress}
                >
                    {isValidElement<{ "data-state"?: string }>(children)
                        ? cloneElement(children, { "data-state": sheetOpen ? "open" : "closed" })
                        : children}
                </div>
            ) : (
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
                        onPointerDown={(event) =>
                            point(event.target as Element | null, event.currentTarget)
                        }
                        onContextMenu={(event) =>
                            point(event.target as Element | null, event.currentTarget)
                        }
                    >
                        {children}
                    </ContextMenuTrigger>
                    {/* Focus is not handed back to the message row on the way out: Reply
                        and Edit put the caret in the composer, and the hand-back landed
                        a beat later and took it straight out again. */}
                    <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocusOnClose}>
                        <DesktopMenu model={model} emojiSet={actions.emoji?.set ?? null} />
                    </ContextMenuContent>
                </ContextMenu>
            )}
            {touch && (
                <MessageSheet
                    open={sheetOpen}
                    onOpenChange={setSheetOpen}
                    model={model}
                    emojiSet={actions.emoji?.set ?? null}
                />
            )}
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

/** Drops the actions a condition left out, keeping the list's own type. */
function present<T>(value: T | false | null | undefined | "" | 0): value is T {
    return Boolean(value);
}

/** The model as the right-click menu: groups between separators, the faces after
 *  what was pressed and before the message's own items. */
function DesktopMenu({
    model,
    emojiSet
}: {
    model: MenuModel;
    emojiSet: CustomEmojiSet | null;
}) {
    const t = useTranslations("chat");
    const reactions = model.reactions;
    const blocks: { key: string; node: ReactNode }[] = filled(model.target).map((section) => ({
        key: section.key,
        node: <DesktopSection section={section} />
    }));
    if (reactions && (reactions.quick.length > 0 || reactions.more))
        blocks.push({
            key: "reactions",
            node: (
            <>
                {reactions.quick.length > 0 && (
                    <div className="flex items-center gap-1 px-1 py-1">
                        {reactions.quick.map((choice) => {
                            const ref = core.parseCustomEmojiToken(choice);
                            const named = ref ? core.customEmojiFallback(ref) : choice;
                            return (
                                <ContextMenuItem
                                    key={choice}
                                    aria-label={t("messageList.reactWith", { emoji: named })}
                                    title={t("messageList.reactWith", { emoji: named })}
                                    onSelect={() => reactions.react(choice)}
                                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted p-0 text-lg"
                                >
                                    <EmojiFace value={choice} set={emojiSet} />
                                </ContextMenuItem>
                            );
                        })}
                    </div>
                )}
                {reactions.more && (
                    <ContextMenuItem onSelect={() => reactions.more?.()}>
                        <SmilePlus className="size-3.5" />
                        {t("messageMenu.addReaction")}
                    </ContextMenuItem>
                )}
            </>
            )
        });
    for (const section of filled(model.sections))
        blocks.push({ key: section.key, node: <DesktopSection section={section} /> });
    return blocks.map((block, index) => (
        <Fragment key={block.key}>
            {index > 0 && <ContextMenuSeparator />}
            {block.node}
        </Fragment>
    ));
}

const DESKTOP_PARTS = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

function DesktopSection({ section }: { section: MenuSection }) {
    return (
        <>
            {section.draw?.(DESKTOP_PARTS)}
            {section.entries?.map((entry) => <DesktopEntry key={entry.key} entry={entry} />)}
        </>
    );
}

function DesktopEntry({ entry }: { entry: MenuEntry }) {
    const Icon = entry.icon;
    const body = (
        <>
            {Icon && <Icon className="size-3.5" />}
            <span className="min-w-0 truncate" title={entry.title}>
                {entry.label}
            </span>
            {entry.trailing && (
                <span className="ms-auto shrink-0 ps-4 text-xs text-foreground-subtle">{entry.trailing}</span>
            )}
            {entry.hint}
        </>
    );
    if (entry.link)
        return (
            <ContextMenuItem asChild data-action={entry.key}>
                <a href={entry.link.href} download={entry.link.download}>
                    {body}
                </a>
            </ContextMenuItem>
        );
    if (entry.sub)
        return (
            <ContextMenuSub>
                <ContextMenuSubTrigger data-action={entry.key}>
                    {Icon && <Icon className="size-3.5" />}
                    <span className="min-w-0 truncate">{entry.label}</span>
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="w-52">
                    {entry.sub.map((group, index) => (
                        <Fragment key={index}>
                            {index > 0 && <ContextMenuSeparator />}
                            {group.map((item) => (
                                <DesktopEntry key={item.key} entry={item} />
                            ))}
                        </Fragment>
                    ))}
                </ContextMenuSubContent>
            </ContextMenuSub>
        );
    return (
        <ContextMenuItem
            data-action={entry.key}
            variant={entry.danger ? "danger" : undefined}
            disabled={entry.disabled}
            // The click rather than the select, which is the only one that knows
            // Shift was held. A key press or a tap arrives as a click as well.
            onClick={(event) => entry.run?.(event.shiftKey)}
        >
            {body}
        </ContextMenuItem>
    );
}
