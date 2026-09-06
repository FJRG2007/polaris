"use client";

/**
 * The list of conversations, and whatever is open beside it.
 *
 * Two things about it are worth knowing before changing it.
 *
 * **A row says which mailbox it came from.** In a merged view the colour down
 * the left of each row is the mailbox's own, the same one the rail draws beside
 * that mailbox. Without it a merged inbox is a list where nobody can tell work
 * from personal, which is the reason people keep separate tabs open instead.
 *
 * **Selection is the toolbar.** Nothing is done to a conversation by hovering
 * over it. Picking rows turns the header into what can be done to them, which is
 * one place to look rather than a row of icons that appear under the pointer and
 * cannot be reached from a keyboard.
 *
 * Actions are optimistic and roll back. Every one of them is a round trip to
 * somebody's mail server, which can be slow and can refuse, so the row moves at
 * once and comes back with a message if the server said no.
 */

import Link from "next/link";
import { refusalOf } from "./refusal";
import { useMail } from "./mail-shell";
import { ThreadView } from "./thread-view";
import { MailSearch } from "./mail-search";
import { useRouter } from "next/navigation";
import type { DisplayFormat } from "@polaris/core";
import type { MailAction } from "@/lib/mailbox/messages";
import { useDisplayFormat } from "@/components/display-format";
import { actOnAction, snoozeAction, syncAllAction } from "./actions";
import { useCallback, useMemo, useState, useTransition } from "react";
import { Button, Checkbox, EmptyState, cn, useToast } from "@polaris/ui";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import {
    Archive,
    Bug,
    Clock,
    Inbox,
    Mail,
    MailOpen,
    Paperclip,
    RefreshCw,
    Star,
    Trash2
} from "lucide-react";

/** What the list is showing, so the empty state and the toolbar can say the
 *  right thing: "no mail" in an inbox and "nothing in the trash" are different
 *  sentences and lead somewhere different. */
export interface MailViewContext {
    readonly title: string;
    readonly emptyTitle: string;
    readonly emptyBody: string;
    /** Whether Archive is offered. It is not, in the folder it archives into. */
    readonly canArchive: boolean;
    /** Whether Delete means "for ever" rather than "to the trash". */
    readonly permanentDelete: boolean;
}

export function MailView({
    threads,
    context,
    openThread,
    openMessages,
    cursor
}: {
    threads: MailThreadView[];
    context: MailViewContext;
    openThread: MailThreadView | null;
    openMessages: MailMessageView[];
    cursor: string;
}) {
    const router = useRouter();
    const { accounts, accountColor, refresh } = useMail();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, startBusy] = useTransition();

    // The lead message of each selected conversation. Every action here is
    // against messages rather than conversations, because a conversation lives
    // in two folders at once and archiving "the conversation" would be a promise
    // about mail this view is not showing.
    const selectedMessageIds = useMemo(
        () =>
            threads
                .filter((thread) => selected.includes(thread.id))
                .map((thread) => thread.leadMessageId)
                .filter(Boolean),
        [threads, selected]
    );

    const act = useCallback(
        (action: MailAction, messageIds: readonly string[], announce: string) => {
            if (messageIds.length === 0) return;
            startBusy(async () => {
                const outcome = await actOnAction({ messageIds: [...messageIds], action });
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                setSelected([]);
                toast.show({ title: announce });
                refresh();
            });
        },
        [refresh, toast]
    );

    const snooze = useCallback(
        (messageIds: readonly string[], until: Date) => {
            startBusy(async () => {
                const outcome = await snoozeAction({ messageIds: [...messageIds], until });
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                setSelected([]);
                refresh();
            });
        },
        [refresh, toast]
    );

    const allPicked = threads.length > 0 && selected.length === threads.length;

    return (
        <div className="flex h-full min-h-0">
            <section
                className={cn(
                    "flex min-w-0 flex-col border-r border-border",
                    // The list keeps its width beside an open conversation and
                    // takes the whole column when nothing is open.
                    openThread ? "hidden w-[22rem] shrink-0 lg:flex" : "flex flex-1"
                )}
                aria-label={context.title}
            >
                <header className="flex flex-col gap-2 border-b border-border px-3 py-2">
                    <div className="flex items-center gap-2">
                        <Checkbox
                            checked={allPicked}
                            aria-label={allPicked ? "Clear the selection" : "Select everything shown"}
                            onChange={(event) =>
                                setSelected(event.target.checked ? threads.map((thread) => thread.id) : [])
                            }
                        />
                        {selected.length === 0 ? (
                            <>
                                <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight">
                                    {context.title}
                                </h1>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Check for new mail"
                                    title="Check for new mail"
                                    disabled={busy || accounts.length === 0}
                                    onClick={() =>
                                        startBusy(async () => {
                                            await syncAllAction();
                                            refresh();
                                        })
                                    }
                                >
                                    <RefreshCw className={cn("size-4 shrink-0", busy && "animate-spin")} aria-hidden />
                                </Button>
                            </>
                        ) : (
                            <div className="flex min-w-0 flex-1 items-center gap-1">
                                <span className="mr-1 shrink-0 text-[12px] text-muted-foreground tabular-nums">
                                    {selected.length} picked
                                </span>
                                {context.canArchive ? (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label="Archive"
                                        title="Archive"
                                        disabled={busy}
                                        onClick={() => act("archive", selectedMessageIds, "Archived.")}
                                    >
                                        <Archive className="size-4 shrink-0" aria-hidden />
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Mark as read"
                                    title="Mark as read"
                                    disabled={busy}
                                    onClick={() => act("read", selectedMessageIds, "Marked as read.")}
                                >
                                    <MailOpen className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Mark as unread"
                                    title="Mark as unread"
                                    disabled={busy}
                                    onClick={() => act("unread", selectedMessageIds, "Marked as unread.")}
                                >
                                    <Mail className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Snooze until tomorrow morning"
                                    title="Snooze until tomorrow morning"
                                    disabled={busy}
                                    onClick={() => snooze(selectedMessageIds, tomorrowMorning())}
                                >
                                    <Clock className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Report as spam"
                                    title="Report as spam"
                                    disabled={busy}
                                    onClick={() => act("junk", selectedMessageIds, "Moved to spam.")}
                                >
                                    <Bug className="size-4 shrink-0" aria-hidden />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={context.permanentDelete ? "Delete for ever" : "Move to trash"}
                                    title={context.permanentDelete ? "Delete for ever" : "Move to trash"}
                                    disabled={busy}
                                    onClick={() =>
                                        act(
                                            context.permanentDelete ? "delete" : "trash",
                                            selectedMessageIds,
                                            context.permanentDelete ? "Deleted." : "Moved to the trash."
                                        )
                                    }
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </div>
                        )}
                    </div>
                    <MailSearch />
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto">
                    {threads.length === 0 ? (
                        <div className="p-6">
                            <EmptyState
                                icon={<Inbox className="size-5 shrink-0" aria-hidden />}
                                title={context.emptyTitle}
                                description={context.emptyBody}
                            />
                        </div>
                    ) : (
                        <ul>
                            {threads.map((thread) => (
                                <ThreadRow
                                    key={thread.id}
                                    thread={thread}
                                    open={openThread?.id === thread.id}
                                    picked={selected.includes(thread.id)}
                                    color={accountColor(thread.accountId)}
                                    showColor={accounts.length > 1}
                                    onPick={(next) =>
                                        setSelected((held) =>
                                            next ? [...held, thread.id] : held.filter((id) => id !== thread.id)
                                        )
                                    }
                                    onStar={() =>
                                        act(
                                            thread.starred ? "unstar" : "star",
                                            [thread.leadMessageId],
                                            thread.starred ? "Unstarred." : "Starred."
                                        )
                                    }
                                />
                            ))}
                        </ul>
                    )}

                    {cursor ? (
                        <div className="p-3">
                            <Button
                                variant="secondary"
                                className="w-full"
                                onClick={() => {
                                    const url = new URL(window.location.href);
                                    url.searchParams.set("before", cursor);
                                    router.push(`${url.pathname}${url.search}`);
                                }}
                            >
                                Older conversations
                            </Button>
                        </div>
                    ) : null}
                </div>
            </section>

            <section className={cn("min-w-0 flex-1", openThread ? "flex" : "hidden lg:flex")} aria-label="Conversation">
                {openThread ? (
                    <ThreadView thread={openThread} messages={openMessages} context={context} />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-8">
                        <p className="text-[13px] text-foreground-subtle">Pick a conversation to read it.</p>
                    </div>
                )}
            </section>
        </div>
    );
}

/** Eight tomorrow morning, in the reader's own clock. The one snooze everybody
 *  reaches for; the rest are on the conversation's own menu. */
function tomorrowMorning(): Date {
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(8, 0, 0, 0);
    return when;
}

function ThreadRow({
    thread,
    open,
    picked,
    color,
    showColor,
    onPick,
    onStar
}: {
    thread: MailThreadView;
    open: boolean;
    picked: boolean;
    color: string;
    showColor: boolean;
    onPick: (next: boolean) => void;
    onStar: () => void;
}) {
    const format = useDisplayFormat();
    const unread = thread.unreadCount > 0;
    return (
        <li
            className={cn(
                "relative border-b border-border/60",
                open ? "bg-card" : "hover:bg-card/60",
                picked && "bg-card"
            )}
        >
            {showColor ? (
                <span
                    className="absolute inset-y-0 left-0 w-0.5"
                    style={{ backgroundColor: color }}
                    aria-hidden
                />
            ) : null}
            <div className="flex items-start gap-2 py-2 pl-3 pr-2">
                <Checkbox
                    className="mt-0.5"
                    checked={picked}
                    aria-label={`Select the conversation ${thread.subject || "with no subject"}`}
                    onChange={(event) => onPick(event.target.checked)}
                />
                <button
                    type="button"
                    className="mt-0.5 shrink-0 text-foreground-subtle hover:text-foreground"
                    aria-label={thread.starred ? "Unstar" : "Star"}
                    title={thread.starred ? "Unstar" : "Star"}
                    onClick={onStar}
                >
                    <Star
                        className={cn("size-4 shrink-0", thread.starred && "fill-current text-warning")}
                        aria-hidden
                    />
                </button>
                <Link
                    href={`?open=${thread.id}`}
                    scroll={false}
                    className="min-w-0 flex-1"
                    aria-current={open ? "true" : undefined}
                >
                    <div className="flex items-baseline gap-2">
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate text-[13px]",
                                unread ? "font-semibold text-foreground" : "text-muted-foreground"
                            )}
                        >
                            {people(thread)}
                        </span>
                        {thread.messageCount > 1 ? (
                            <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                                {thread.messageCount}
                            </span>
                        ) : null}
                        <span className="shrink-0 text-[11px] text-foreground-subtle">
                            {shortDate(thread.lastMessageAt, format)}
                        </span>
                    </div>
                    <p
                        className={cn(
                            "truncate text-[13px]",
                            unread ? "font-medium text-foreground" : "text-muted-foreground"
                        )}
                    >
                        {thread.subject || "(no subject)"}
                    </p>
                    <div className="flex items-center gap-1.5">
                        {thread.hasAttachments ? (
                            <Paperclip className="size-3 shrink-0 text-foreground-subtle" aria-label="Has attachments" />
                        ) : null}
                        <p className="min-w-0 flex-1 truncate text-[12px] text-foreground-subtle">
                            {thread.snippet}
                        </p>
                    </div>
                    {thread.labels.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1">
                            {thread.labels.map((label) => (
                                <span
                                    key={label.id}
                                    className="rounded px-1 text-[10px] font-medium"
                                    style={{ backgroundColor: `${label.color}22`, color: label.color }}
                                >
                                    {label.name}
                                </span>
                            ))}
                        </div>
                    ) : null}
                </Link>
            </div>
        </li>
    );
}

/** Who a conversation is with, as a list shows it: the people, not the
 *  addresses, and never more than three names before it says how many more. */
function people(thread: MailThreadView): string {
    const names = thread.participants.map((entry) => entry.name.trim() || entry.address.split("@")[0] || entry.address);
    if (names.length === 0) return "(nobody)";
    if (names.length <= 3) return names.join(", ");
    return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/**
 * The date a mail list shows: the time for something that arrived today, the
 * date for everything else.
 *
 * Deliberately not "3 days ago". A mail list is scanned for a date somebody half
 * remembers, and a relative date makes that arithmetic the reader's job. Both
 * halves go through the display format, which is where the clock and the date
 * order this deployment uses are decided - never through the browser's locale,
 * because the whole point of that setting is that the order is chosen rather
 * than implied.
 */
function shortDate(iso: string, format: DisplayFormat): string {
    const when = new Date(iso);
    const now = new Date();
    return when.toDateString() === now.toDateString() ? format.time(when) : format.date(when);
}
