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
 */

import type { ReactNode } from "react";
import { useMail } from "./mail-shell";
import { useAppUrl } from "@/components/app-url";
import type { MailAction } from "@/lib/mailbox/messages";
import type { MailThreadView } from "@/lib/mailbox/views";
import {
    Archive,
    Bug,
    Clock,
    Copy,
    Link2,
    Mail,
    MailOpen,
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
    useToast
} from "@polaris/ui";

export function ThreadContextMenu({
    thread,
    canArchive,
    permanentDelete,
    onAct,
    onSnooze,
    onLabel,
    children
}: {
    thread: MailThreadView;
    canArchive: boolean;
    permanentDelete: boolean;
    onAct: (action: MailAction, messageIds: readonly string[], announce: string) => void;
    onSnooze: (messageIds: readonly string[], until: Date) => void;
    onLabel: (labelId: string, messageIds: readonly string[]) => void;
    children: ReactNode;
}) {
    const { labels } = useMail();
    const appUrl = useAppUrl();
    const toast = useToast();
    const ids = [thread.leadMessageId].filter(Boolean);
    const unread = thread.unreadCount > 0;

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
                    onSelect={() =>
                        onAct(unread ? "read" : "unread", ids, unread ? "Marked as read." : "Marked as unread.")
                    }
                >
                    {unread ? (
                        <MailOpen className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                        <Mail className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {unread ? "Mark as read" : "Mark as unread"}
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
                    {thread.starred ? "Unstar" : "Star"}
                </ContextMenuItem>

                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <Clock className="size-3.5 shrink-0" aria-hidden />
                        Snooze
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
                            Label
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
                        Archive
                    </ContextMenuItem>
                ) : null}
                <ContextMenuItem onSelect={() => onAct("junk", ids, "Moved to spam.")}>
                    <Bug className="size-3.5 shrink-0" aria-hidden />
                    Report as spam
                </ContextMenuItem>
                <ContextMenuItem
                    onSelect={() =>
                        onAct(
                            permanentDelete ? "delete" : "trash",
                            ids,
                            permanentDelete ? "Deleted." : "Moved to the trash."
                        )
                    }
                >
                    <Trash2 className="size-3.5 shrink-0" aria-hidden />
                    {permanentDelete ? "Delete for ever" : "Move to trash"}
                </ContextMenuItem>

                <ContextMenuSeparator />

                <ContextMenuItem
                    onSelect={() =>
                        void copy(
                            thread.participants[0]?.address ?? "",
                            "Address copied."
                        )
                    }
                    disabled={!thread.participants[0]?.address}
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
