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
import { leavesTheView } from "./mail-actions";
import { missingFolderRole, refusalOf } from "./refusal";
import { useMailLayout } from "./use-mail-layout";
import { ThreadContextMenu } from "./thread-menu";
import { MAIL_SHORTCUTS, useMailKeys } from "./use-mail-keys";
import { useMail } from "./mail-shell";
import { ThreadView } from "./thread-view";
import { MailSearch } from "./mail-search";
import { useRouter } from "next/navigation";
import type { DisplayFormat } from "@polaris/core";
import type { MailAction } from "@/lib/mailbox/messages";
import { useDisplayFormat } from "@/components/display-format";
import { actOnAction, applyLabelAction, snoozeAction, syncAllAction } from "./actions";
import { useCallback, useEffect, useMemo, useState, useTransition, type ComponentPropsWithRef } from "react";
import {
    Button,
    Checkbox,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    EmptyState,
    cn,
    useToast
} from "@polaris/ui";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import {
    Archive,
    Bug,
    Clock,
    Columns2,
    Inbox,
    Mail,
    MailOpen,
    Paperclip,
    RefreshCw,
    Rows3,
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
    const { accounts, accountColor, askFolderRole, identities, openComposer, refresh } = useMail();
    const toast = useToast();
    const [selected, setSelected] = useState<string[]>([]);
    const [busy, startBusy] = useTransition();
    // Which row the keyboard is on. Separate from the selection on purpose: the
    // pointer and the keyboard are two ways of pointing at a row, and a keyboard
    // walk that ticked every checkbox on the way past would be unusable.
    const [onIndex, setOnIndex] = useState(0);
    const [helpOpen, setHelpOpen] = useState(false);
    const [layout, setLayout] = useMailLayout();

    /**
     * What the reader has just done, before the server has said so.
     *
     * Every action here is a round trip to somebody's mail server - a socket, a
     * command, a wait - and waiting for it before the row changes is what made
     * marking a message read feel broken. So the row moves now and the truth
     * arrives after: a refusal puts it back and says why, and a success is
     * simply the server agreeing with a screen that already showed it.
     *
     * Cleared whenever the server's own answer arrives, which is what
     * `threads` becoming a new array means. Keeping a patch past that would
     * mean the screen quietly disagreeing with the server for ever.
     */
    const [patched, setPatched] = useState<Record<string, ThreadPatch>>({});
    useEffect(() => {
        setPatched({});
    }, [threads]);

    const patch = useCallback((ids: readonly string[], change: ThreadPatch) => {
        setPatched((held) => {
            const next = { ...held };
            for (const id of ids) next[id] = { ...next[id], ...change };
            return next;
        });
    }, []);

    /** The row as the reader should see it: what the server sent, with anything
     *  they have just done laid over it. */
    const shown = useCallback(
        (thread: MailThreadView): MailThreadView => {
            const over = patched[thread.id];
            return over ? { ...thread, ...over } : thread;
        },
        [patched]
    );

    /**
     * Stop the address naming a conversation.
     *
     * Archiving, trashing or deleting drops the rows the reading pane was drawn
     * from - a move is re-fetched under the destination's own uids rather than
     * guessed at - so a moment after the action the pane is asking the server for
     * something that is not there. Left alone that took the whole screen away
     * rather than the one message; leaving it open would be a pane that says the
     * conversation is gone next to a list it is no longer in.
     *
     * `/mail/t/<id>` names the conversation in the path instead of the query and
     * has nothing to strip, so the way out of it is the list itself. Replaced
     * rather than pushed: a Back into a conversation that has been filed is a
     * step nobody wants offered.
     */
    const closeOpen = useCallback(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("open");
        const path = url.pathname.startsWith("/mail/t/") ? "/mail" : url.pathname;
        router.replace(`${path}${url.search}`, { scroll: false });
    }, [router]);

    /** The conversations an action was aimed at, from the messages it named. */
    const threadsOf = useCallback(
        (messageIds: readonly string[]) =>
            threads.filter((thread) => messageIds.includes(thread.leadMessageId)).map((thread) => thread.id),
        [threads]
    );

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
            const aimed = threadsOf(messageIds);
            const ahead = optimistically(action);
            // The row moves now. A mail server is slow enough that waiting for it
            // reads as the screen having ignored the click.
            if (ahead) patch(aimed, ahead);

            startBusy(async () => {
                const outcome = await actOnAction({ messageIds: [...messageIds], action });
                // This mailbox has no folder for what was asked. Ask which one it
                // is and do the action again once it is settled, so the answer
                // costs one question rather than the action being lost.
                const missing = missingFolderRole(outcome);
                if (missing) {
                    setPatched({});
                    askFolderRole(missing, () => act(action, messageIds, announce));
                    return;
                }
                const said = refusalOf(outcome);
                if (said) {
                    // Put it back. A screen that kept showing the change after
                    // the server refused it would be lying about somebody's mail.
                    setPatched({});
                    toast.show({ title: said });
                    return;
                }
                setSelected([]);
                toast.show({ title: announce });
                // Done from the list, but it may have been aimed at whatever is
                // open beside it - the conversation's own row, or the whole
                // selection with it in.
                if (leavesTheView(action) && openThread && aimed.includes(openThread.id)) {
                    closeOpen();
                }
                refresh();
            });
        },
        [askFolderRole, closeOpen, openThread, patch, refresh, threadsOf, toast]
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

    const onRow = threads[Math.min(onIndex, threads.length - 1)] ?? null;
    const rowMessageIds = onRow ? [onRow.leadMessageId].filter(Boolean) : [];

    useMailKeys({
        compose: () => openComposer({}),
        next: () => setOnIndex((held) => Math.min(held + 1, Math.max(0, threads.length - 1))),
        previous: () => setOnIndex((held) => Math.max(0, held - 1)),
        open: () => {
            if (onRow) router.push(`?open=${onRow.id}`, { scroll: false });
        },
        back: () => {
            if (openThread) router.push(window.location.pathname, { scroll: false });
        },
        archive: () => {
            if (context.canArchive) act("archive", rowMessageIds, "Archived.");
        },
        trash: () =>
            act(
                context.permanentDelete ? "delete" : "trash",
                rowMessageIds,
                context.permanentDelete ? "Deleted." : "Moved to the trash."
            ),
        junk: () => act("junk", rowMessageIds, "Moved to spam."),
        star: () => {
            if (!onRow) return;
            act(
                onRow.starred ? "unstar" : "star",
                rowMessageIds,
                onRow.starred ? "Unstarred." : "Starred."
            );
        },
        markUnread: () => act("unread", rowMessageIds, "Marked as unread."),
        search: () => {
            const box = document.querySelector<HTMLInputElement>(SEARCH_BOX);
            box?.focus();
        },
        refresh: () =>
            startBusy(async () => {
                await syncAllAction();
                refresh();
            })
    });

    // `?` is bound here rather than in the hook: it is about this screen's own
    // help sheet, and a hook that owned it would have to know the sheet exists.
    useEffect(() => {
        function onKey(event: KeyboardEvent): void {
            if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target;
            if (
                target instanceof HTMLElement &&
                (target.isContentEditable || EDITABLE.test(target.tagName))
            ) {
                return;
            }
            event.preventDefault();
            setHelpOpen((held) => !held);
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const label = useCallback(
        (labelId: string, messageIds: readonly string[]) => {
            startBusy(async () => {
                const outcome = await applyLabelAction({
                    labelId,
                    messageIds: [...messageIds],
                    applied: true
                });
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                refresh();
            });
        },
        [refresh, toast]
    );

    /**
     * Every address that is the reader's own.
     *
     * A conversation's participants include whoever it was addressed to, and in
     * an inbox that is always the person looking at it. Printing their own name
     * in the sender column of every row is a column of noise: no mail client
     * does it, because the one thing a reader already knows about their inbox is
     * that it is theirs. The mailboxes and every address they may send as, so an
     * alias is recognised as them too.
     */
    const mine = useMemo(() => {
        const held = new Set<string>();
        for (const account of accounts) {
            held.add(account.address.trim().toLowerCase());
            for (const identity of identities[account.id] ?? []) {
                held.add(identity.address.trim().toLowerCase());
            }
        }
        return held;
    }, [accounts, identities]);

    const allPicked = threads.length > 0 && selected.length === threads.length;

    return (
        <div className="flex h-full min-h-0">
            <section
                className={cn(
                    // `min-h-0` is what keeps the two panes scrolling apart.
                    // A flex item's floor is its content, so without it the
                    // `overflow-y-auto` inside never gets shorter than the list
                    // and the scroll escapes to whatever contains both - which
                    // is one scrollbar moving the message and the list together.
                    "flex min-h-0 min-w-0 flex-col",
                    // Two shapes, and which one is a decision its reader makes.
                    //
                    // `split` keeps a narrow list beside the conversation, which
                    // is what somebody triaging a hundred messages wants. `full`
                    // gives the list the whole width and hands the whole width to
                    // the message once one is open, which is what somebody who
                    // reads one message at a time wants. Neither is right for
                    // both, which is why this is not a constant.
                    //
                    // In `split` the list is the same width the whole time. It
                    // used to take the screen until something was opened and then
                    // snap to a fifth of it, so choosing the reading pane meant
                    // watching the list jump every time you came back to an empty
                    // one - a column that changes width is a column nobody can
                    // learn to read. Narrow only where there is room for the pane
                    // beside it; a phone gets the list and then the message.
                    layout === "split"
                        ? openThread
                            ? "hidden w-80 shrink-0 border-r border-border lg:flex"
                            : "flex flex-1 lg:w-80 lg:flex-none lg:shrink-0 lg:border-r lg:border-border"
                        : openThread
                          ? "hidden"
                          : "flex flex-1"
                )}
                aria-label={context.title}
            >
                <header className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
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
                                    aria-label={
                                        layout === "split"
                                            ? "Show one message at a time"
                                            : "Show the list beside the message"
                                    }
                                    title={
                                        layout === "split"
                                            ? "Show one message at a time"
                                            : "Show the list beside the message"
                                    }
                                    onClick={() => setLayout(layout === "split" ? "full" : "split")}
                                >
                                    {layout === "split" ? (
                                        <Rows3 className="size-4 shrink-0" aria-hidden />
                                    ) : (
                                        <Columns2 className="size-4 shrink-0" aria-hidden />
                                    )}
                                </Button>
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
                                <ThreadContextMenu
                                    key={thread.id}
                                    thread={shown(thread)}
                                    canArchive={context.canArchive}
                                    permanentDelete={context.permanentDelete}
                                    onAct={act}
                                    onSnooze={snooze}
                                    onLabel={label}
                                >
                                    <ThreadRow
                                        thread={shown(thread)}
                                        onCursor={onRow?.id === thread.id}
                                        open={openThread?.id === thread.id}
                                        picked={selected.includes(thread.id)}
                                        color={accountColor(thread.accountId)}
                                        showColor={accounts.length > 1}
                                        wide={layout === "full" && !openThread}
                                        mine={mine}
                                        onPick={(next) =>
                                            setSelected((held) =>
                                                next ? [...held, thread.id] : held.filter((id) => id !== thread.id)
                                            )
                                        }
                                        onStar={() =>
                                            act(
                                                shown(thread).starred ? "unstar" : "star",
                                                [thread.leadMessageId],
                                                shown(thread).starred ? "Unstarred." : "Starred."
                                            )
                                        }
                                    />
                                </ThreadContextMenu>
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

            {helpOpen ? <ShortcutSheet onClose={() => setHelpOpen(false)} /> : null}

            <section
                className={cn(
                    // Same reason as the list beside it: this pane owns its own
                    // scrollbar, and it only can while its own height is bounded.
                    "min-h-0 min-w-0 flex-1",
                    openThread ? "flex" : layout === "split" ? "hidden lg:flex" : "hidden"
                )}
                aria-label="Conversation"
            >
                {openThread ? (
                    <ThreadView
                        thread={shown(openThread)}
                        messages={openMessages}
                        context={context}
                        // Opening a message marks it read on the server, which
                        // takes a round trip. The row stops being bold now.
                        onRead={() => patch([openThread.id], { unreadCount: 0 })}
                        // Filed or thrown away from its own header. Same reason
                        // as above, from the other side of the screen.
                        onGone={closeOpen}
                        // Reading one message at a time needs a way back, because
                        // the list it came from is not on screen.
                        onBack={
                            layout === "full"
                                ? () => router.push(window.location.pathname, { scroll: false })
                                : undefined
                        }
                    />
                ) : (
                    <div className="flex flex-1 items-center justify-center p-8">
                        <p className="text-[13px] text-foreground-subtle">Pick a conversation to read it.</p>
                    </div>
                )}
            </section>
        </div>
    );
}

/** How `/` finds the search box, and which elements own a key press rather than
 *  the screen. Named because two places read each. */
const SEARCH_BOX = 'input[aria-label="Search mail"]';
const EDITABLE = /^(?:INPUT|TEXTAREA|SELECT)$/;

/** What the keys do. Reached with `?`, and from nowhere else - it is a reminder
 *  for people who already use them, not a feature anybody has to find. */
function ShortcutSheet({ onClose }: { onClose: () => void }) {
    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Keyboard</DialogTitle>
                </DialogHeader>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                    {MAIL_SHORTCUTS.map((entry) => (
                        <div key={entry.keys} className="contents">
                            <dt className="font-mono text-[12px] text-foreground">{entry.keys}</dt>
                            <dd className="text-muted-foreground">{entry.what}</dd>
                        </div>
                    ))}
                </dl>
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    Every one of these has a button on screen as well.
                </p>
            </DialogContent>
        </Dialog>
    );
}

/** What an action changes about a row before the server has confirmed it. Only
 *  the two things a list actually draws differently. */
interface ThreadPatch {
    unreadCount?: number;
    starred?: boolean;
}

/**
 * How a row should look the instant an action is asked for.
 *
 * Only the actions that leave the conversation where it is. Archiving, trashing
 * and reporting spam take it out of this list entirely, and guessing that
 * locally would mean a row vanishing and reappearing if the server refused -
 * which is worse than the wait. Those keep the refresh.
 */
function optimistically(action: MailAction): ThreadPatch | null {
    switch (action) {
        case "read":
            return { unreadCount: 0 };
        case "unread":
            return { unreadCount: 1 };
        case "star":
            return { starred: true };
        case "unstar":
            return { starred: false };
        default:
            return null;
    }
}

/** Eight tomorrow morning, in the reader's own clock. The one snooze everybody
 *  reaches for; the rest are on the conversation's own menu. */
function tomorrowMorning(): Date {
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(8, 0, 0, 0);
    return when;
}

/**
 * One row.
 *
 * It takes and passes on whatever else it is handed, and that is not tidiness:
 * the right-click menu wraps this in a Radix trigger with `asChild`, which works
 * by cloning the child and handing it the handler and the ref that make the menu
 * open. A component that declares its props and drops the rest swallows both
 * silently - no error, no warning, and a right-click on a conversation that does
 * nothing at all. That is what it did.
 */
function ThreadRow({
    thread,
    onCursor,
    open,
    picked,
    color,
    showColor,
    wide,
    mine,
    onPick,
    onStar,
    ...rest
}: ComponentPropsWithRef<"li"> & {
    thread: MailThreadView;
    /** Whether the keyboard is on this row. Drawn as an edge rather than a fill,
     *  so it stays legible over the fill an open or picked row already has. */
    onCursor: boolean;
    open: boolean;
    picked: boolean;
    color: string;
    showColor: boolean;
    /** Whether the list has the whole width. Then a row is one line - sender,
     *  subject, snippet, date - the way a full-width list is read; narrow, it
     *  stacks, because three columns in twenty rems is unreadable. */
    wide: boolean;
    /** Every address belonging to the reader, so their own name is kept out of
     *  the column that says who a conversation is with. */
    mine: ReadonlySet<string>;
    onPick: (next: boolean) => void;
    onStar: () => void;
}) {
    const format = useDisplayFormat();
    const unread = thread.unreadCount > 0;
    return (
        <li
            {...rest}
            className={cn(
                "relative border-b border-border/60",
                open ? "bg-card" : "hover:bg-card/60",
                picked && "bg-card",
                onCursor && "ring-1 ring-inset ring-border-strong",
                rest.className
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
                    className={cn("min-w-0 flex-1", wide && "flex items-baseline gap-3")}
                    aria-current={open ? "true" : undefined}
                >
                    <div className={cn("flex items-baseline gap-2", wide && "w-56 shrink-0")}>
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate text-[13px]",
                                unread ? "font-semibold text-foreground" : "text-muted-foreground"
                            )}
                        >
                            {people(thread, mine)}
                        </span>
                        {thread.messageCount > 1 ? (
                            <span className="shrink-0 text-[11px] tabular-nums text-foreground-subtle">
                                {thread.messageCount}
                            </span>
                        ) : null}
                        {wide ? null : (
                            <span className="shrink-0 text-[11px] text-foreground-subtle">
                                {shortDate(thread.lastMessageAt, format)}
                            </span>
                        )}
                    </div>
                    <div className={cn("min-w-0", wide && "flex flex-1 items-baseline gap-2")}>
                        <p
                            className={cn(
                                "truncate text-[13px]",
                                wide && "shrink-0 max-w-[50%]",
                                unread ? "font-medium text-foreground" : "text-muted-foreground"
                            )}
                        >
                            {thread.subject || "(no subject)"}
                        </p>
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            {thread.hasAttachments ? (
                                <Paperclip
                                    className="size-3 shrink-0 text-foreground-subtle"
                                    aria-label="Has attachments"
                                />
                            ) : null}
                            <p className="min-w-0 flex-1 truncate text-[12px] text-foreground-subtle">
                                {thread.snippet}
                            </p>
                        </div>
                    </div>
                    {wide ? (
                        <span className="shrink-0 text-[11px] text-foreground-subtle">
                            {shortDate(thread.lastMessageAt, format)}
                        </span>
                    ) : null}
                    {thread.labels.length > 0 && !wide ? (
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

/**
 * Who a conversation is with, as a list shows it.
 *
 * The people, not the addresses, and never more than three names before it says
 * how many more. The reader themself is not one of the people: they are on every
 * conversation in their own mailbox, so their name in that column is a word
 * repeated down the whole screen that tells nobody anything. A message somebody
 * sent to themself is the one case where it is all there is, and then it stands.
 */
function people(thread: MailThreadView, mine: ReadonlySet<string>): string {
    const others = thread.participants.filter(
        (entry) => !mine.has(entry.address.trim().toLowerCase())
    );
    const shown = others.length > 0 ? others : thread.participants;
    const names = shown.map((entry) => entry.name.trim() || entry.address.split("@")[0] || entry.address);
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
