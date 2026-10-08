"use client";

/**
 * The right-click menu on a conversation.
 *
 * Everything here is on screen somewhere else as well - the toolbar, the reading
 * pane, the keyboard. That is the rule a context menu has to obey: it is a
 * shortcut for people who reach for one, never the only way to do something, or
 * it becomes a feature nobody using a touchscreen or a screen reader can find.
 *
 * What it adds over the toolbar is that it acts on the row under the pointer
 * without selecting it first, which is the whole reason anybody right-clicks a
 * list.
 *
 * **Unless that row is one of several ticked.** Then it acts on all of them, and
 * says how many in every item that does. Right-clicking inside a selection and
 * being given a menu that quietly does the thing to one message is how somebody
 * loses a selection they spent a minute building - every list in every operating
 * system works the other way round, and so does this one. A right-click on a row
 * OUTSIDE the selection is still about that row, because that is what pointing
 * at it means.
 */

import * as core from "@polaris/core";
import type { ReactNode } from "react";
import { useMail } from "./mail-shell";
import { useRouter } from "next/navigation";
import { useAppUrl } from "@/components/app-url";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MailAction } from "@/lib/mailbox/messages";
import type { MailThreadView } from "@/lib/mailbox/views";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    MenuShortcut,
    useShortcutBindings,
    useToast
} from "@polaris/ui";
import {
    Archive,
    Bell,
    BellOff,
    Bookmark,
    Bug,
    Clock,
    Pin,
    PinOff,
    Copy,
    CornerUpLeft,
    CornerUpRight,
    Forward,
    Link2,
    Mail,
    MailOpen,
    Search,
    ShieldOff,
    Star,
    Tag,
    Trash2,
    Undo2
} from "lucide-react";

export function ThreadContextMenu({
    thread,
    canArchive,
    permanentDelete,
    restorable,
    onAct,
    onSnooze,
    onLabel,
    onAnswer,
    onBlock,
    onConversation,
    selection,
    children
}: {
    thread: MailThreadView;
    /** The conversations ticked, as message ids, when this row is one of them
     *  and there is more than one. Null for the ordinary case: a right-click on
     *  a row that is not part of a selection. */
    selection: readonly string[] | null;
    canArchive: boolean;
    permanentDelete: boolean;
    /** Whether these can go back where they were deleted from. */
    restorable: boolean;
    onAct: (action: MailAction, messageIds: readonly string[], announce: string) => void;
    onSnooze: (messageIds: readonly string[], until: Date) => void;
    onLabel: (labelId: string, messageIds: readonly string[]) => void;
    /** Open the composer answering this conversation. The same three actions the
     *  reading pane offers, because the point of a right-click is doing
     *  something to a row without opening it first. */
    onAnswer: (kind: "reply" | "reply-all" | "forward", messageId: string) => void;
    /** Refuse this sender from now on, and clear out what they have sent. */
    onBlock: (accountId: string, address: string) => void;
    /** Pin the conversations to the top, or mute them - Polaris' own, so nothing
     *  is asked of the mail server. */
    onConversation: (
        messageIds: readonly string[],
        state: { pinned?: boolean; muted?: boolean },
        announce: string
    ) => void;
    children: ReactNode;
}) {
    const { labels } = useMail();
    const appUrl = useAppUrl();
    const toast = useToast();
    const t = useTranslations("mail");
    const router = useRouter();
    // What every item that acts on mail acts on: the selection when this row is
    // inside one, and this row alone otherwise.
    const ids = selection ?? [thread.leadMessageId].filter(Boolean);
    const many = selection ? selection.length : 0;
    /** An item's own words when it is about one conversation, and its words when
     *  it is about several. Said rather than counted in a corner: "Move to
     *  trash" and "Move 12 to trash" are different decisions. */
    const shown = many > 1 ? many : 1;
    const unread = thread.unreadCount > 0;
    const sender = thread.participants[0]?.address ?? "";
    // The keys in force now, from the table every app shares.
    const bindings = useShortcutBindings();
    const keyFor = (command: core.MailKeyCommand): string => {
        const first = core.keysOf(bindings, `mail.${command}`)[0];
        return first ?? "";
    };

    async function copy(what: string, said: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(what);
            toast.show({ title: said });
        } catch {
            // A browser that refuses the clipboard is not something the reader
            // can act on, and the menu has already closed over the row.
            toast.show({ title: t("thread.copyRefused") });
        }
    }

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem
                    onSelect={() => onAnswer("reply", thread.leadMessageId)}
                    disabled={!thread.leadMessageId}
                >
                    <CornerUpLeft className="size-3.5 shrink-0" aria-hidden />
                    {t("thread.reply")}
                    <MenuShortcut keys={keyFor("reply")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => onAnswer("reply-all", thread.leadMessageId)}
                    disabled={!thread.leadMessageId}
                >
                    <CornerUpRight className="size-3.5 shrink-0" aria-hidden />
                    {t("thread.replyAll")}
                    <MenuShortcut keys={keyFor("replyAll")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => onAnswer("forward", thread.leadMessageId)}
                    disabled={!thread.leadMessageId}
                >
                    <Forward className="size-3.5 shrink-0" aria-hidden />
                    {t("thread.forward")}
                    <MenuShortcut keys={keyFor("forward")} />
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() =>
                        onAct(
                            unread ? "read" : "unread",
                            ids,
                            unread ? t("thread.announce.read") : t("thread.announce.unread")
                        )
                    }
                >
                    {unread ? (
                        <MailOpen className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                        <Mail className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {unread
                        ? t("thread.markRead", { count: shown })
                        : t("thread.markUnread", { count: shown })}
                    <MenuShortcut keys={keyFor("markUnread")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onAct(
                            thread.starred ? "unstar" : "star",
                            ids,
                            thread.starred
                                ? t("thread.announce.unstarred")
                                : t("thread.announce.starred")
                        )
                    }
                >
                    <Star className="size-3.5 shrink-0" aria-hidden />
                    {thread.starred
                        ? t("thread.unstar", { count: shown })
                        : t("thread.star", { count: shown })}
                    <MenuShortcut keys={keyFor("star")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onAct(
                            thread.important ? "unimportant" : "important",
                            ids,
                            thread.important
                                ? t("thread.announce.unimportant")
                                : t("thread.announce.important")
                        )
                    }
                >
                    <Bookmark className="size-3.5 shrink-0" aria-hidden />
                    {thread.important
                        ? t("thread.unimportant", { count: shown })
                        : t("thread.important", { count: shown })}
                    <MenuShortcut keys={keyFor("important")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onConversation(
                            ids,
                            { pinned: !thread.pinned },
                            thread.pinned
                                ? t("thread.announce.unpinned")
                                : t("thread.announce.pinned")
                        )
                    }
                >
                    {thread.pinned ? (
                        <PinOff className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                        <Pin className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {thread.pinned
                        ? t("thread.unpin", { count: shown })
                        : t("thread.pin", { count: shown })}
                    <MenuShortcut keys={keyFor("pin")} />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onConversation(
                            ids,
                            { muted: !thread.muted },
                            thread.muted ? t("thread.announce.unmuted") : t("thread.announce.muted")
                        )
                    }
                >
                    {thread.muted ? (
                        <Bell className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                        <BellOff className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {thread.muted
                        ? t("thread.unmute", { count: shown })
                        : t("thread.mute", { count: shown })}
                    <MenuShortcut keys={keyFor("mute")} />
                </ContextMenuItem>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Clock className="size-3.5 shrink-0" aria-hidden />
                        {t("thread.snooze", { count: shown })}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        {SNOOZES.map((snooze) => (
                            <ContextMenuItem
                                key={snooze.id}
                                onSelect={() => onSnooze(ids, snooze.when())}
                            >
                                {t(`thread.snoozes.${snooze.id}`)}
                            </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>

                {labels.length > 0 ? (
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Tag className="size-3.5 shrink-0" aria-hidden />
                            {t("thread.label", { count: shown })}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            {labels.map((label) => (
                                <ContextMenuItem
                                    key={label.id}
                                    onSelect={() => onLabel(label.id, ids)}
                                >
                                    <Tag
                                        className="size-3.5 shrink-0"
                                        style={{ color: label.color }}
                                        aria-hidden
                                    />
                                    {label.name}
                                </ContextMenuItem>
                            ))}
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                ) : null}

                <ContextMenuSeparator />

                {canArchive ? (
                    <ContextMenuItem
                        onSelect={() => onAct("archive", ids, t("thread.announce.archived"))}
                    >
                        <Archive className="size-3.5 shrink-0" aria-hidden />
                        {t("thread.archive", { count: shown })}
                        <MenuShortcut keys={keyFor("archive")} />
                    </ContextMenuItem>
                ) : null}
                {/* The two that take mail away from somebody are drawn as what
                    they are. Spam is destructive twice over: it moves the
                    message AND teaches a provider about the sender. */}
                {restorable ? (
                    <ContextMenuItem
                        onSelect={() => onAct("restore", ids, t("thread.announce.restored"))}
                    >
                        <Undo2 className="size-3.5 shrink-0" aria-hidden />
                        {t("thread.restore", { count: shown })}
                    </ContextMenuItem>
                ) : (
                    <ContextMenuItem
                        variant="danger"
                        onSelect={() => onAct("junk", ids, t("thread.announce.junk"))}
                    >
                        <Bug className="size-3.5 shrink-0" aria-hidden />
                        {t("thread.junk", { count: shown })}
                        <MenuShortcut keys={keyFor("junk")} />
                    </ContextMenuItem>
                )}
                <ContextMenuItem
                    variant="danger"
                    onSelect={() =>
                        onAct(
                            permanentDelete ? "delete" : "trash",
                            ids,
                            permanentDelete
                                ? t("thread.announce.deleted")
                                : t("thread.announce.trashed")
                        )
                    }
                >
                    <Trash2 className="size-3.5 shrink-0" aria-hidden />
                    {permanentDelete
                        ? t("thread.delete", { count: shown })
                        : t("thread.trash", { count: shown })}
                    <MenuShortcut keys="Delete" />
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() => router.push(SEARCH_FOR(sender))}
                    disabled={!sender}
                >
                    <Search className="size-3.5 shrink-0" aria-hidden />
                    {sender ? t("thread.findFrom", { sender }) : t("thread.findFromThis")}
                </ContextMenuItem>

                <ContextMenuItem
                    variant="danger"
                    onSelect={() => onBlock(thread.accountId, sender)}
                    disabled={!sender}
                >
                    <ShieldOff className="size-3.5 shrink-0" aria-hidden />
                    {sender ? t("thread.block", { sender }) : t("thread.blockThis")}
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() => void copy(sender, t("thread.announce.addressCopied"))}
                    disabled={!sender}
                >
                    <Copy className="size-3.5 shrink-0" aria-hidden />
                    {t("thread.copySender")}
                </ContextMenuItem>
                <ContextMenuItem
                    // Built on the address this Polaris is configured with rather
                    // than on the tab's hostname, so a link handed to somebody
                    // else opens for them too.
                    onSelect={() =>
                        void copy(`${appUrl}/mail/t/${thread.id}`, t("thread.announce.linkCopied"))
                    }
                >
                    <Link2 className="size-3.5 shrink-0" aria-hidden />
                    {t("thread.copyLink")}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Where a sender's whole correspondence lives: an ordinary search, so it
 *  lands somewhere with an address bar that can be edited and kept rather than
 *  in a filter that only exists while the menu is open. */
function SEARCH_FOR(address: string): string {
    return `/mail?q=${encodeURIComponent(`from:${address}`)}`;
}

/** The snoozes worth having on a menu. Anything finer belongs in a picker, and
 *  nobody has ever wanted one on a right-click. */
const SNOOZES: readonly {
    id: "laterToday" | "tomorrow" | "weekend" | "nextWeek";
    when: () => Date;
}[] = [
    {
        id: "laterToday",
        when: () => {
            const when = new Date();
            when.setHours(when.getHours() + 3, 0, 0, 0);
            return when;
        }
    },
    {
        id: "tomorrow",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + 1);
            when.setHours(8, 0, 0, 0);
            return when;
        }
    },
    {
        id: "weekend",
        when: () => {
            const when = new Date();
            // The coming Saturday, or the next one if today already is.
            when.setDate(when.getDate() + ((6 - when.getDay() + 7) % 7 || 7));
            when.setHours(9, 0, 0, 0);
            return when;
        }
    },
    {
        id: "nextWeek",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + ((8 - when.getDay()) % 7 || 7));
            when.setHours(8, 0, 0, 0);
            return when;
        }
    }
];
