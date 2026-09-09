"use client";

/**
 * One conversation, read.
 *
 * Every message in it is listed oldest first, collapsed to a line except the
 * newest, which opens by itself - that is what somebody came here for. A
 * collapsed message shows who and when and the first line, which is enough to
 * find the one being looked for without opening five.
 *
 * A body is fetched when it is opened and never before. An envelope is a few
 * hundred bytes and a message with a slide deck in it is forty megabytes, so a
 * conversation of thirty is opened for the cost of the one being read.
 *
 * Nothing here marks anything read on its own. A preview pane that marks
 * everything read as somebody arrows past it is the most complained-about
 * behaviour any mail client has ever shipped; opening a message deliberately is
 * what marks it, and the toolbar can always put it back.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { leavesTheView } from "./mail-actions";
import { missingFolderRole, refusalOf } from "./refusal";
import { forwardSeed, replySeed } from "./answering";
import { useMail } from "./mail-shell";
import { MessageBody } from "./message-body";
import { UnsubscribeButton } from "./unsubscribe-button";
import dynamic from "next/dynamic";
import { isViewable } from "@/app/(app)/drive/viewer/kind";
import type { ViewerTarget } from "@/app/(app)/drive/viewer/types";

/**
 * The viewer, fetched when a file is actually opened.
 *
 * Never statically, and this is not a nicety: it carries a PDF engine, a
 * spreadsheet parser, a document converter and a slide renderer, and importing
 * it from a screen means all of that is in the bundle for every reader who never
 * opens an attachment. It also reaches `node:crypto` somewhere down that chain,
 * which a client bundle cannot resolve at all - so a static import does not make
 * the page heavy, it makes the build fail. The chat message list learned this
 * first; `viewer/kind` exists so that asking whether a file is openable costs
 * nothing.
 */
const FileViewer = dynamic(
    () => import("@/app/(app)/drive/file-viewer").then((module) => module.FileViewer),
    { ssr: false }
);
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    cn,
    useToast
} from "@polaris/ui";
import type { MailViewContext } from "./mail-view";
import type { MailAction } from "@/lib/mailbox/messages";
import type { ReadableMessage } from "@/lib/mailbox/reading";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import { actOnAction, applyLabelAction, openMessageAction } from "./actions";
import {
    ArrowLeft,
    Archive,
    BellOff,
    ChevronDown,
    CornerUpLeft,
    CornerUpRight,
    Download,
    Forward,
    Mail,
    MoreHorizontal,
    Paperclip,
    ShieldAlert,
    Star,
    Tag,
    Trash2,
    UserRoundX
} from "lucide-react";

export function ThreadView({
    thread,
    messages,
    context,
    markRead,
    onBack,
    onRead,
    onGone,
    onStayed
}: {
    thread: MailThreadView;
    messages: MailMessageView[];
    context: MailViewContext;
    /** When an opened message stops being unread - see `mail-prefs`. It was
     *  always the instant it opened, which is wrong for anybody who arrows
     *  through a list with a reading pane: passing over a message is not reading
     *  it, and marking it read is how one is lost. */
    markRead: core.MailMarkRead;
    /** Given when the list is not on screen beside this - reading one message at
     *  a time, or on a phone - because then this is the only way back to it. */
    onBack?: () => void;
    /** Told the moment a message here is marked read, so the row in the list
     *  stops being bold now rather than after the round trip. */
    onRead?: () => void;
    /** Told when this conversation has been filed or thrown away from here, so
     *  the address stops naming something the server no longer has. */
    onGone?: () => void;
    /** Put the reader back, for a filing the server refused after this pane had
     *  already stepped out of the way. */
    onStayed?: () => void;
}) {
    const { refresh, reloadLists, openComposer, accounts, accountColor, askFolderRole } = useMail();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const [answering, startAnswering] = useTransition();
    const newest = messages.at(-1);
    const [open, setOpen] = useState<string[]>(newest ? [newest.id] : []);
    const [expandAll, setExpandAll] = useState(false);

    // The conversation changed under the pane - a different row was clicked, or
    // a reply arrived. Whatever was open belonged to the old one.
    useEffect(() => {
        setOpen(messages.at(-1) ? [messages[messages.length - 1]!.id] : []);
        setExpandAll(false);
    }, [thread.id, messages.length]);

    /**
     * What the pane actually lists.
     *
     * A conversation of thirty was thirty preview lines stacked on top of each
     * other, which is a wall rather than a thread - the shape of it was
     * unreadable. So the middle is folded away behind one line saying how many
     * are in there, and what stays is the beginning and the end, which is what
     * anybody opening a long thread is looking for.
     */
    const shown = useMemo<Shown[]>(() => {
        if (expandAll || messages.length <= KEPT_OPEN + KEPT_FIRST + 1) {
            return messages.map((message) => ({ kind: "message" as const, message }));
        }
        const first = messages.slice(0, KEPT_FIRST);
        const last = messages.slice(-KEPT_OPEN);
        return [
            ...first.map((message) => ({ kind: "message" as const, message })),
            { kind: "gap" as const, count: messages.length - first.length - last.length },
            ...last.map((message) => ({ kind: "message" as const, message }))
        ];
    }, [messages, expandAll]);

    const act = useCallback(
        (action: MailAction) => {
            const messageIds = messages.map((message) => message.id);
            // Out of the conversation now, before the mail server is asked.
            // Filing a message is a round trip to somebody else's IMAP server,
            // and waiting for it read as a button that had not been pressed -
            // the reader sat inside a message they had just deleted, watching
            // nothing happen. If it is refused, they are put back and told.
            const leaving = leavesTheView(action);
            if (leaving) onGone?.();
            startBusy(async () => {
                const outcome = await actOnAction({ messageIds, action });
                const missing = missingFolderRole(outcome);
                if (missing) {
                    // Back where they were, so the question is answered with the
                    // conversation in front of them rather than about a message
                    // they can no longer see.
                    if (leaving) onStayed?.();
                    askFolderRole(missing, () => act(action));
                    return;
                }
                const said = refusalOf(outcome);
                if (said) {
                    if (leaving) onStayed?.();
                    toast.show({ title: said });
                    return;
                }
                // Archived, trashed or deleted: this pane was looking at messages
                // the server has now moved out from under it, and it closed
                // before the round trip.
                //
                // The router is left alone here, because closing is already a
                // navigation and a refresh in the same breath is a second fetch
                // racing it - the navigation loses, which is why deleting from
                // inside a conversation used to leave the reader inside it. But
                // the LIST still has to be pulled again: it is fetched by the
                // browser against the narrowing, and dropping `?open=` does not
                // change the narrowing, so without this the message somebody just
                // deleted stayed in the list until they reloaded the page.
                if (leaving) {
                    reloadLists();
                    return;
                }
                refresh();
            });
        },
        [askFolderRole, messages, onGone, onStayed, refresh, reloadLists, toast]
    );

    /**
     * Open the composer with the message quoted in it.
     *
     * The quoting happens here rather than at send time, because the point of a
     * quote is that its author can see it, trim it, and write above it - which is
     * what everybody does with a long thread. It needs the plain text, and a
     * collapsed message has none loaded, so it goes through the same action the
     * reading pane uses rather than growing a second path to a body.
     */
    const answer = useCallback(
        (kind: "reply" | "reply-all" | "forward") => {
            // Guarded here as well as by the early return below: this closure
            // outlives the render that made it, and a conversation whose last
            // message was just moved has none.
            if (!newest) return;
            startAnswering(async () => {
                const outcome = await openMessageAction(newest.id);
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                const readable = "readable" in outcome ? outcome.readable : null;
                // The plain text, never the HTML: quoting markup into a reply is
                // how a thread turns into unreadable nested tables. A message with
                // no text part quotes nothing, which is honest.
                const body = readable?.text ?? "";
                openComposer(
                    kind === "forward"
                        ? forwardSeed(newest, body)
                        : replySeed(
                              newest,
                              accounts.map((account) => account.address),
                              kind === "reply-all",
                              body
                          )
                );
            });
        },
        [accounts, newest, openComposer, toast]
    );

    if (!newest) {
        return (
            <div className="flex flex-1 items-center justify-center p-8">
                <p className="text-[13px] text-foreground-subtle">
                    This conversation is no longer here.
                </p>
            </div>
        );
    }

    const account = accounts.find((one) => one.id === newest.accountId);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
                {onBack ? (
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Back to the list"
                        title="Back to the list"
                        onClick={onBack}
                    >
                        <ArrowLeft className="size-4 shrink-0" aria-hidden />
                    </Button>
                ) : null}
                <div className="min-w-0 flex-1">
                    <h2 className="truncate text-[17px] font-semibold tracking-tight">
                        {thread.subject || "(no subject)"}
                    </h2>
                    {accounts.length > 1 && account ? (
                        <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-foreground-subtle">
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ backgroundColor: accountColor(account.id) }}
                                aria-hidden
                            />
                            <span className="truncate" title={account.label || account.address}>
                                {account.label || account.address}
                            </span>
                        </p>
                    ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {/* Answering is offered at the top as well as the bottom.
                        A company's newsletter is a screen and a half of HTML
                        with a footer under it, and having to scroll all of it
                        to find Reply is the thing that makes people answer in
                        another client. Same three actions, same handler; icons
                        here because the words are already at the bottom. */}
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Reply"
                        title="Reply"
                        disabled={answering}
                        onClick={() => answer("reply")}
                    >
                        <CornerUpLeft className="size-4 shrink-0" aria-hidden />
                    </Button>
                    {newest.to.length + newest.cc.length > 1 ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Reply to everybody"
                            title="Reply to everybody"
                            disabled={answering}
                            onClick={() => answer("reply-all")}
                        >
                            <CornerUpRight className="size-4 shrink-0" aria-hidden />
                        </Button>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Forward"
                        title="Forward"
                        disabled={answering}
                        onClick={() => answer("forward")}
                    >
                        <Forward className="size-4 shrink-0" aria-hidden />
                    </Button>
                    <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={thread.starred ? "Unstar" : "Star"}
                        title={thread.starred ? "Unstar" : "Star"}
                        disabled={busy}
                        onClick={() => act(thread.starred ? "unstar" : "star")}
                    >
                        <Star
                            className={cn(
                                "size-4 shrink-0",
                                thread.starred && "fill-current text-warning"
                            )}
                            aria-hidden
                        />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Mark as unread"
                        title="Mark as unread"
                        disabled={busy}
                        onClick={() => act("unread")}
                    >
                        <Mail className="size-4 shrink-0" aria-hidden />
                    </Button>
                    {context.canArchive ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Archive"
                            title="Archive"
                            disabled={busy}
                            onClick={() => act("archive")}
                        >
                            <Archive className="size-4 shrink-0" aria-hidden />
                        </Button>
                    ) : null}
                    <LabelMenu messageIds={messages.map((message) => message.id)} />
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={context.permanentDelete ? "Delete for ever" : "Move to trash"}
                        title={context.permanentDelete ? "Delete for ever" : "Move to trash"}
                        disabled={busy}
                        onClick={() => act(context.permanentDelete ? "delete" : "trash")}
                    >
                        <Trash2 className="size-4 shrink-0" aria-hidden />
                    </Button>
                </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <ul className="space-y-1.5">
                    {shown.map((entry) =>
                        entry.kind === "gap" ? (
                            <li key="gap">
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                                    onClick={() => setExpandAll(true)}
                                >
                                    <MoreHorizontal className="size-3.5 shrink-0" aria-hidden />
                                    {entry.count} earlier{" "}
                                    {entry.count === 1 ? "message" : "messages"}
                                </button>
                            </li>
                        ) : (
                            <MessageCard
                                key={entry.message.id}
                                message={entry.message}
                                markRead={markRead}
                                onRead={onRead}
                                open={open.includes(entry.message.id)}
                                onToggle={() =>
                                    setOpen((held) =>
                                        held.includes(entry.message.id)
                                            ? held.filter((id) => id !== entry.message.id)
                                            : [...held, entry.message.id]
                                    )
                                }
                            />
                        )
                    )}
                </ul>

                <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                        variant="secondary"
                        disabled={answering}
                        onClick={() => answer("reply")}
                    >
                        <CornerUpLeft className="size-4 shrink-0" aria-hidden />
                        Reply
                    </Button>
                    {newest.to.length + newest.cc.length > 1 ? (
                        <Button
                            variant="secondary"
                            disabled={answering}
                            onClick={() => answer("reply-all")}
                        >
                            <CornerUpRight className="size-4 shrink-0" aria-hidden />
                            Reply to all
                        </Button>
                    ) : null}
                    <Button variant="ghost" disabled={answering} onClick={() => answer("forward")}>
                        <Forward className="size-4 shrink-0" aria-hidden />
                        Forward
                    </Button>
                </div>
            </div>
        </div>
    );
}

/**
 * Putting a label on a conversation.
 *
 * Applied to every message in it, because "label the conversation" is what
 * somebody means and a label on one message of six is one nobody can find again.
 * The menu says where to make a label when there are none, rather than being an
 * empty menu that reads as broken.
 */
function LabelMenu({ messageIds }: { messageIds: string[] }) {
    const { labels, refresh } = useMail();
    const toast = useToast();

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Label this conversation"
                    title="Label this conversation"
                >
                    <Tag className="size-4 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {labels.length === 0 ? (
                    <DropdownMenuItem asChild>
                        <Link href="/mail/settings/labels">Make your first label</Link>
                    </DropdownMenuItem>
                ) : (
                    labels.map((label) => (
                        <DropdownMenuItem
                            key={label.id}
                            onSelect={() =>
                                void (async () => {
                                    const answer = await applyLabelAction({
                                        labelId: label.id,
                                        messageIds,
                                        applied: true
                                    });
                                    const said = refusalOf(answer);
                                    if (said) {
                                        toast.show({ title: said });
                                        return;
                                    }
                                    toast.show({ title: `Labelled ${label.name}.` });
                                    refresh();
                                })()
                            }
                        >
                            <Tag
                                className="size-3.5 shrink-0"
                                style={{ color: label.color }}
                                aria-hidden
                            />
                            {label.name}
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** How many of the newest messages stay on screen when a long conversation is
 *  folded, and how many of the oldest. The last few are what somebody came for;
 *  the first is where the thread started, which is the other thing people look
 *  for. Everything between them is one line. */
const KEPT_OPEN = 3;
const KEPT_FIRST = 1;

/** A row in the pane: a message, or the fold standing in for the ones between. */
type Shown =
    | { readonly kind: "message"; readonly message: MailMessageView }
    | { readonly kind: "gap"; readonly count: number };

function MessageCard({
    message,
    open,
    markRead,
    onToggle,
    onRead
}: {
    message: MailMessageView;
    open: boolean;
    markRead: core.MailMarkRead;
    onToggle: () => void;
    onRead?: () => void;
}) {
    const format = useDisplayFormat();
    const { refresh } = useMail();
    const [viewing, setViewing] = useState<ViewerTarget | null>(null);
    const [readable, setReadable] = useState<ReadableMessage | null>(null);
    const [failed, setFailed] = useState("");

    useEffect(() => {
        if (!open || readable) return;
        let live = true;
        void (async () => {
            const outcome = await openMessageAction(message.id);
            if (!live) return;
            if ("error" in outcome && outcome.error) {
                setFailed(outcome.error);
                return;
            }
            if ("readable" in outcome && outcome.readable) setReadable(outcome.readable);
        })();
        return () => {
            live = false;
        };
    }, [open, readable, message.id]);

    /**
     * Opening a message marks it read.
     *
     * The fetch above peeks rather than setting the flag, so this is the
     * deliberate half, and it fires only when a message is actually expanded -
     * which is somebody clicking the conversation or this header. Arrowing past
     * a row in the list expands nothing and marks nothing, which is what a
     * preview pane gets complained about for; the toolbar can always put it back.
     *
     * Guarded by a ref rather than by the flag on the row: the row is a server
     * component's snapshot and does not change until the refresh lands, so
     * reading the flag would fire this again on the way there.
     */
    const marked = useRef(false);
    useEffect(() => {
        if (!open || message.seen || marked.current) return;
        // Left to the toolbar, for somebody whose unread list is their to-do
        // list. Nothing here is a promise that it stays unread - marking it read
        // by hand still works - only that opening it does not do it for them.
        if (markRead === "never") return;

        const mark = () => {
            if (marked.current) return;
            marked.current = true;
            // The list stops being bold now. The server is told in the same
            // breath, and the round trip is no longer something anybody watches.
            onRead?.();
            void (async () => {
                const outcome = await actOnAction({ messageIds: [message.id], action: "read" });
                // A server that refused leaves it unread, which is the truth.
                // Nothing is said about it: nobody asked for this, so a failure is
                // not news - and the next refresh brings the bold row back on its
                // own.
                if (!refusalOf(outcome)) refresh();
            })();
        };

        if (markRead === "open") {
            mark();
            return;
        }
        // Waited out, and cancelled by leaving. Somebody walking down a list with
        // the arrow keys passes over a dozen messages on the way to one, and the
        // wait is the whole difference between passing over and reading.
        const timer = setTimeout(mark, core.MAIL_MARK_READ_DELAY_MS);
        return () => clearTimeout(timer);
    }, [open, markRead, message.id, message.seen, onRead, refresh]);

    const sender = message.from[0];

    return (
        <li className="rounded-md border border-border bg-card">
            {/* Collapsed, a message is ONE line - who, a glimpse, when - because
                a conversation is read by scanning down it. It was three lines
                with the whole preview in the middle, so ten messages filled the
                screen and the shape of the thread disappeared. */}
            <button
                type="button"
                className={cn(
                    "flex w-full items-baseline gap-2 px-3 text-left",
                    open ? "items-start py-2" : "py-1.5"
                )}
                aria-expanded={open}
                onClick={onToggle}
            >
                {open ? (
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="truncate text-[13px] font-medium text-foreground">
                                {sender ? core.addressLabel(sender) : "(nobody)"}
                            </span>
                            <span className="min-w-0 truncate text-[12px] text-foreground-subtle">
                                {sender?.address}
                            </span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-foreground-subtle">
                            to{" "}
                            {message.to.map((entry) => core.addressLabel(entry)).join(", ") ||
                                "nobody"}
                            {message.cc.length > 0
                                ? `, copy to ${message.cc.map((entry) => core.addressLabel(entry)).join(", ")}`
                                : ""}
                        </p>
                    </div>
                ) : (
                    <>
                        <span
                            className={cn(
                                "w-40 shrink-0 truncate text-[13px]",
                                message.seen
                                    ? "text-muted-foreground"
                                    : "font-semibold text-foreground"
                            )}
                        >
                            {sender ? core.addressLabel(sender) : "(nobody)"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground-subtle">
                            {message.snippet}
                        </span>
                    </>
                )}
                <span className="ml-auto shrink-0 pl-2 text-[11px] text-foreground-subtle">
                    {open
                        ? format.dateTime(new Date(message.sentAt))
                        : shortWhen(message.sentAt, format)}
                </span>
                <ChevronDown
                    className={cn("size-4 shrink-0 text-foreground-subtle", open && "rotate-180")}
                    aria-hidden
                />
            </button>

            {open ? (
                <div className="border-t border-border px-3 py-3">
                    {failed ? (
                        <p className="text-[13px] text-danger">{failed}</p>
                    ) : readable ? (
                        <>
                            {/* What Polaris thought of it, and only when it
                                thought something. A message that arrived
                                without objection says nothing about itself -
                                a badge on every message is a badge nobody
                                reads by the third one.

                                Shown as the reason rather than the number.
                                "40 out of 100" is not something anybody can
                                act on; "a link says bank.example.com and goes
                                to evil.example.ru" is. */}
                            {message.spamReason ? (
                                <p className="mb-3 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[12px] text-foreground">
                                    <ShieldAlert
                                        className="mt-px size-3.5 shrink-0 text-warning"
                                        aria-hidden
                                    />
                                    <span className="min-w-0">
                                        {message.folderRole === "junk"
                                            ? "Polaris filed this as junk. "
                                            : "This one looks off. "}
                                        {message.spamReason}.{" "}
                                        {message.folderRole === "junk"
                                            ? "Not junk puts it back and teaches the filter."
                                            : "Junk files it and teaches the filter."}
                                    </span>
                                </p>
                            ) : null}
                            {/* Gmail's one good idea about mailing lists: the
                                way out at the top, beside who sent it, rather
                                than in six-point grey under a footer nobody
                                scrolls to. What pressing it does depends on
                                what the sender published - see
                                `unsubscribe-button`. */}
                            {readable.unsubscribe && readable.unsubscribeKind ? (
                                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] text-muted-foreground">
                                    <BellOff className="size-3.5 shrink-0" aria-hidden />
                                    <span className="min-w-0 flex-1">
                                        {sender
                                            ? `${core.addressLabel(sender)} sends this as a mailing list.`
                                            : "This arrived as a mailing list."}
                                    </span>
                                    <UnsubscribeButton
                                        size="xs"
                                        target={{
                                            kind: readable.unsubscribeKind,
                                            url: readable.unsubscribe,
                                            source: readable.unsubscribeSource || "header",
                                            sender: sender
                                                ? core.addressLabel(sender)
                                                : "this sender",
                                            messageId: message.id
                                        }}
                                    />
                                </div>
                            ) : null}
                            {readable.wantsReceipt ? (
                                <p className="mb-3 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground">
                                    <UserRoundX className="size-3.5 shrink-0" aria-hidden />
                                    The sender asked to be told when this was opened. Polaris did
                                    not tell them.
                                </p>
                            ) : null}
                            <MessageBody
                                html={readable.html}
                                text={readable.text}
                                remoteAllowed={readable.remoteAllowed}
                                trackerVendors={readable.trackerVendors}
                            />
                            {message.attachments.filter((file) => !file.inline).length > 0 ? (
                                <ul className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                                    {message.attachments
                                        .filter((file) => !file.inline)
                                        .map((file) => (
                                            <li
                                                key={file.id}
                                                className="flex items-center gap-1 rounded-md border border-border pr-1 text-[12px]"
                                            >
                                                {/* Openable ones open. A receipt,
                                                    a spreadsheet, a scan - the
                                                    reason to attach one is for
                                                    somebody to look at it, and
                                                    making them save it to a
                                                    Downloads folder first is a
                                                    step nobody wanted. */}
                                                {isViewable(file.name) ? (
                                                    <button
                                                        type="button"
                                                        className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-muted-foreground hover:text-foreground"
                                                        onClick={() =>
                                                            setViewing({
                                                                path: file.id,
                                                                name: file.name,
                                                                size: String(file.size)
                                                            })
                                                        }
                                                    >
                                                        <Paperclip
                                                            className="size-3.5 shrink-0"
                                                            aria-hidden
                                                        />
                                                        <span
                                                            className="max-w-[16rem] truncate"
                                                            title={file.name}
                                                        >
                                                            {file.name}
                                                        </span>
                                                        <span className="shrink-0 text-foreground-subtle">
                                                            {readableSize(file.size)}
                                                        </span>
                                                    </button>
                                                ) : (
                                                    <span className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-muted-foreground">
                                                        <Paperclip
                                                            className="size-3.5 shrink-0"
                                                            aria-hidden
                                                        />
                                                        <span
                                                            className="max-w-[16rem] truncate"
                                                            title={file.name}
                                                        >
                                                            {file.name}
                                                        </span>
                                                        <span className="shrink-0 text-foreground-subtle">
                                                            {readableSize(file.size)}
                                                        </span>
                                                    </span>
                                                )}
                                                <a
                                                    href={`/api/mail/attachments/${file.id}`}
                                                    className="shrink-0 rounded p-1 text-foreground-subtle hover:text-foreground"
                                                    aria-label={`Save ${file.name}`}
                                                    title={`Save ${file.name}`}
                                                    download
                                                >
                                                    <Download
                                                        className="size-3.5 shrink-0"
                                                        aria-hidden
                                                    />
                                                </a>
                                            </li>
                                        ))}
                                </ul>
                            ) : null}
                            {/* The message itself, as its server holds it.
                                Not a convenience: a mail client that cannot
                                hand a message back is one nobody should put
                                their correspondence into, and this is the one
                                place somebody is looking at the message they
                                want out. */}
                            <p className="mt-3 text-[12px] text-foreground-subtle">
                                <a
                                    className="inline-flex items-center gap-1 underline"
                                    href={`/api/mail/export?messageId=${encodeURIComponent(message.id)}`}
                                    download
                                >
                                    <Download className="size-3 shrink-0" aria-hidden />
                                    Save this message
                                </a>
                            </p>
                        </>
                    ) : (
                        <div
                            className="h-24 animate-pulse rounded-md bg-surface"
                            aria-label="Opening the message"
                        />
                    )}
                </div>
            ) : null}

            {/* The same viewer Drive opens a file in - PDFs, spreadsheets,
                documents, pictures, code. Written once there and pointed at a
                different source here rather than reimplemented, which is the
                whole reason it takes a `urlFor`. */}
            <FileViewer
                target={viewing}
                readOnly
                urlFor={(target, inline) =>
                    `/api/mail/attachments/${target.path}${inline ? "?inline=1" : ""}`
                }
                onOpenChange={(open) => (open ? undefined : setViewing(null))}
            />
        </li>
    );
}

/** The date beside a collapsed message: the time if it arrived today, the date
 *  otherwise. Short, because it sits at the end of a one-line row. */
function shortWhen(iso: string, format: ReturnType<typeof useDisplayFormat>): string {
    const when = new Date(iso);
    return when.toDateString() === new Date().toDateString()
        ? format.time(when)
        : format.date(when);
}

/** A file size somebody can read. Not a locale format: the units are the same
 *  everywhere and the number is deliberately coarse. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
