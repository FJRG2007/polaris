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

import type { ReactNode } from "react";
import { useMail } from "./mail-shell";
import { useRouter } from "next/navigation";
import { useAppUrl } from "@/components/app-url";
import type { MailAction } from "@/lib/mailbox/messages";
import type { MailThreadView } from "@/lib/mailbox/views";
import {
    Archive,
    Bug,
    Clock,
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
    MenuShortcut,
    useToast
} from "@polaris/ui";

export function ThreadContextMenu({
    thread,
    canArchive,
    permanentDelete,
    onAct,
    onSnooze,
    onLabel,
    onAnswer,
    onBlock,
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
    onAct: (action: MailAction, messageIds: readonly string[], announce: string) => void;
    onSnooze: (messageIds: readonly string[], until: Date) => void;
    onLabel: (labelId: string, messageIds: readonly string[]) => void;
    /** Open the composer answering this conversation. The same three actions the
     *  reading pane offers, because the point of a right-click is doing
     *  something to a row without opening it first. */
    onAnswer: (kind: "reply" | "reply-all" | "forward", messageId: string) => void;
    /** Refuse this sender from now on, and clear out what they have sent. */
    onBlock: (accountId: string, address: string) => void;
    children: ReactNode;
}) {
    const { labels } = useMail();
    const appUrl = useAppUrl();
    const toast = useToast();
    const router = useRouter();
    // What every item that acts on mail acts on: the selection when this row is
    // inside one, and this row alone otherwise.
    const ids = selection ?? [thread.leadMessageId].filter(Boolean);
    const many = selection ? selection.length : 0;
    /** An item's own words when it is about one conversation, and its words when
     *  it is about several. Said rather than counted in a corner: "Move to
     *  trash" and "Move 12 to trash" are different decisions. */
    const said = (one: string, more: (count: number) => string): string =>
        many > 1 ? more(many) : one;
    const unread = thread.unreadCount > 0;
    const sender = thread.participants[0]?.address ?? "";

    async function copy(what: string, said: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(what);
            toast.show({ title: said });
        } catch {
            // A browser that refuses the clipboard is not something the reader
            // can act on, and the menu has already closed over the row.
            toast.show({ title: "This browser would not let Polaris copy that." });
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
                    Reply
                    <MenuShortcut keys="r" />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => onAnswer("reply-all", thread.leadMessageId)}
                    disabled={!thread.leadMessageId}
                >
                    <CornerUpRight className="size-3.5 shrink-0" aria-hidden />
                    Reply to everybody
                    <MenuShortcut keys="a" />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() => onAnswer("forward", thread.leadMessageId)}
                    disabled={!thread.leadMessageId}
                >
                    <Forward className="size-3.5 shrink-0" aria-hidden />
                    Forward
                    <MenuShortcut keys="f" />
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() =>
                        onAct(unread ? "read" : "unread", ids, unread ? "Marked as read." : "Marked as unread.")
                    }
                >
                    {unread ? (
                        <MailOpen className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                        <Mail className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {unread
                        ? said("Mark as read", (n) => `Mark ${n} as read`)
                        : said("Mark as unread", (n) => `Mark ${n} as unread`)}
                    <MenuShortcut keys="u" />
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onAct(
                            thread.starred ? "unstar" : "star",
                            ids,
                            thread.starred ? "Unstarred." : "Starred."
                        )
                    }
                >
                    <Star className="size-3.5 shrink-0" aria-hidden />
                    {thread.starred
                        ? said("Unstar", (n) => `Unstar ${n}`)
                        : said("Star", (n) => `Star ${n}`)}
                    <MenuShortcut keys="s" />
                </ContextMenuItem>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Clock className="size-3.5 shrink-0" aria-hidden />
                        {said("Snooze", (n) => `Snooze ${n}`)}
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        {SNOOZES.map((snooze) => (
                            <ContextMenuItem key={snooze.label} onSelect={() => onSnooze(ids, snooze.when())}>
                                {snooze.label}
                            </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>

                {labels.length > 0 ? (
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Tag className="size-3.5 shrink-0" aria-hidden />
                            {said("Label", (n) => `Label ${n}`)}
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            {labels.map((label) => (
                                <ContextMenuItem key={label.id} onSelect={() => onLabel(label.id, ids)}>
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
                    <ContextMenuItem onSelect={() => onAct("archive", ids, "Archived.")}>
                        <Archive className="size-3.5 shrink-0" aria-hidden />
                        {said("Archive", (n) => `Archive ${n}`)}
                        <MenuShortcut keys="e" />
                    </ContextMenuItem>
                ) : null}
                {/* The two that take mail away from somebody are drawn as what
                    they are. Spam is destructive twice over: it moves the
                    message AND teaches a provider about the sender. */}
                <ContextMenuItem variant="danger" onSelect={() => onAct("junk", ids, "Moved to spam.")}>
                    <Bug className="size-3.5 shrink-0" aria-hidden />
                    {said("Report as spam", (n) => `Report ${n} as spam`)}
                    <MenuShortcut keys="!" />
                </ContextMenuItem>
                <ContextMenuItem
                    variant="danger"
                    onSelect={() =>
                        onAct(
                            permanentDelete ? "delete" : "trash",
                            ids,
                            permanentDelete ? "Deleted." : "Moved to the trash."
                        )
                    }
                >
                    <Trash2 className="size-3.5 shrink-0" aria-hidden />
                    {permanentDelete
                        ? said("Delete for ever", (n) => `Delete ${n} for ever`)
                        : said("Move to trash", (n) => `Move ${n} to the trash`)}
                    <MenuShortcut keys="Delete" />
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() => router.push(SEARCH_FOR(sender))}
                    disabled={!sender}
                >
                    <Search className="size-3.5 shrink-0" aria-hidden />
                    Find everything from {sender || "this sender"}
                </ContextMenuItem>

                <ContextMenuItem
                    variant="danger"
                    onSelect={() => onBlock(thread.accountId, sender)}
                    disabled={!sender}
                >
                    <ShieldOff className="size-3.5 shrink-0" aria-hidden />
                    Block {sender || "this sender"}
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() => void copy(sender, "Address copied.")}
                    disabled={!sender}
                >
                    <Copy className="size-3.5 shrink-0" aria-hidden />
                    Copy the sender&apos;s address
                </ContextMenuItem>
                <ContextMenuItem
                    // Built on the address this Polaris is configured with rather
                    // than on the tab's hostname, so a link handed to somebody
                    // else opens for them too.
                    onSelect={() => void copy(`${appUrl}/mail/t/${thread.id}`, "Link copied.")}
                >
                    <Link2 className="size-3.5 shrink-0" aria-hidden />
                    Copy link to this conversation
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
const SNOOZES: readonly { label: string; when: () => Date }[] = [
    {
        label: "Later today",
        when: () => {
            const when = new Date();
            when.setHours(when.getHours() + 3, 0, 0, 0);
            return when;
        }
    },
    {
        label: "Tomorrow morning",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + 1);
            when.setHours(8, 0, 0, 0);
            return when;
        }
    },
    {
        label: "This weekend",
        when: () => {
            const when = new Date();
            // The coming Saturday, or the next one if today already is.
            when.setDate(when.getDate() + ((6 - when.getDay() + 7) % 7 || 7));
            when.setHours(9, 0, 0, 0);
            return when;
        }
    },
    {
        label: "Next week",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + ((8 - when.getDay()) % 7 || 7));
            when.setHours(8, 0, 0, 0);
            return when;
        }
    }
];
