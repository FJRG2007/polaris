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
import { missingFolderRole, refusalOf } from "./refusal";
import { useMail } from "./mail-shell";
import { MessageBody } from "./message-body";
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
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { MailMessageView, MailThreadView } from "@/lib/mailbox/views";
import { actOnAction, applyLabelAction, openMessageAction, trustSenderAction } from "./actions";
import {
    Archive,
    ChevronDown,
    CornerUpLeft,
    CornerUpRight,
    Download,
    Forward,
    Mail,
    Paperclip,
    Star,
    Tag,
    Trash2,
    UserRoundX
} from "lucide-react";

export function ThreadView({
    thread,
    messages,
    context
}: {
    thread: MailThreadView;
    messages: MailMessageView[];
    context: MailViewContext;
}) {
    const { refresh, openComposer, accounts, accountColor, askFolderRole } = useMail();
    const toast = useToast();
    const [busy, startBusy] = useTransition();
    const newest = messages.at(-1);
    const [open, setOpen] = useState<string[]>(newest ? [newest.id] : []);

    // The conversation changed under the pane - a different row was clicked, or
    // a reply arrived. Whatever was open belonged to the old one.
    useEffect(() => {
        setOpen(messages.at(-1) ? [messages[messages.length - 1]!.id] : []);
    }, [thread.id, messages.length]);

    const act = useCallback(
        (action: MailAction) => {
            const messageIds = messages.map((message) => message.id);
            startBusy(async () => {
                const outcome = await actOnAction({ messageIds, action });
                const missing = missingFolderRole(outcome);
                if (missing) {
                    askFolderRole(missing, () => act(action));
                    return;
                }
                const said = refusalOf(outcome);
                if (said) {
                    toast.show({ title: said });
                    return;
                }
                refresh();
            });
        },
        [askFolderRole, messages, refresh, toast]
    );

    if (!newest) {
        return (
            <div className="flex flex-1 items-center justify-center p-8">
                <p className="text-[13px] text-foreground-subtle">This conversation is no longer here.</p>
            </div>
        );
    }

    const account = accounts.find((one) => one.id === newest.accountId);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-start gap-2 border-b border-border px-4 py-3">
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
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={thread.starred ? "Unstar" : "Star"}
                        title={thread.starred ? "Unstar" : "Star"}
                        disabled={busy}
                        onClick={() => act(thread.starred ? "unstar" : "star")}
                    >
                        <Star className={cn("size-4 shrink-0", thread.starred && "fill-current text-warning")} aria-hidden />
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
                <ul className="space-y-2">
                    {messages.map((message) => (
                        <MessageCard
                            key={message.id}
                            message={message}
                            open={open.includes(message.id)}
                            onToggle={() =>
                                setOpen((held) =>
                                    held.includes(message.id)
                                        ? held.filter((id) => id !== message.id)
                                        : [...held, message.id]
                                )
                            }
                        />
                    ))}
                </ul>

                <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => openComposer(replyTo(newest, accounts, false))}>
                        <CornerUpLeft className="size-4 shrink-0" aria-hidden />
                        Reply
                    </Button>
                    {newest.to.length + newest.cc.length > 1 ? (
                        <Button variant="secondary" onClick={() => openComposer(replyTo(newest, accounts, true))}>
                            <CornerUpRight className="size-4 shrink-0" aria-hidden />
                            Reply to all
                        </Button>
                    ) : null}
                    <Button variant="ghost" onClick={() => openComposer(forwardOf(newest))}>
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
                <Button variant="ghost" size="icon" aria-label="Label this conversation" title="Label this conversation">
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
                            <Tag className="size-3.5 shrink-0" style={{ color: label.color }} aria-hidden />
                            {label.name}
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** What a reply starts with. The recipients come out of the shared rule, so a
 *  reply from here and a reply from anywhere else address the same people. */
function replyTo(
    message: MailMessageView,
    accounts: ReturnType<typeof useMail>["accounts"],
    all: boolean
) {
    const self = accounts.map((account) => account.address);
    const { to, cc } = core.replyRecipients(
        {
            messageId: "",
            inReplyTo: "",
            references: [],
            subject: message.subject,
            from: message.from,
            to: message.to,
            cc: message.cc,
            replyTo: message.replyTo,
            listId: message.listId,
            sentAt: new Date(message.sentAt)
        },
        self,
        all
    );
    return {
        accountId: message.accountId,
        to: [...to],
        cc: [...cc],
        subject: core.replySubject(message.subject),
        inReplyToId: message.id,
        forward: false
    };
}

function forwardOf(message: MailMessageView) {
    return {
        accountId: message.accountId,
        to: [],
        subject: core.forwardSubject(message.subject),
        inReplyToId: message.id,
        forward: true
    };
}

function MessageCard({
    message,
    open,
    onToggle
}: {
    message: MailMessageView;
    open: boolean;
    onToggle: () => void;
}) {
    const format = useDisplayFormat();
    const { refresh } = useMail();
    const toast = useToast();
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
        marked.current = true;
        void (async () => {
            const outcome = await actOnAction({ messageIds: [message.id], action: "read" });
            // A server that refused leaves it unread, which is the truth. Nothing
            // is said about it: nobody asked for this, so a failure is not news.
            if (!refusalOf(outcome)) refresh();
        })();
    }, [open, message.id, message.seen, refresh]);

    const sender = message.from[0];

    return (
        <li className="rounded-md border border-border bg-card">
            <button
                type="button"
                className="flex w-full items-start gap-2 px-3 py-2 text-left"
                aria-expanded={open}
                onClick={onToggle}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                            {sender ? core.addressLabel(sender) : "(nobody)"}
                        </span>
                        <span className="min-w-0 truncate text-[12px] text-foreground-subtle">
                            {sender?.address}
                        </span>
                        <span className="ml-auto shrink-0 text-[11px] text-foreground-subtle">
                            {format.dateTime(new Date(message.sentAt))}
                        </span>
                    </div>
                    {open ? (
                        <p className="mt-0.5 truncate text-[12px] text-foreground-subtle">
                            to {message.to.map((entry) => core.addressLabel(entry)).join(", ") || "nobody"}
                            {message.cc.length > 0
                                ? `, copy to ${message.cc.map((entry) => core.addressLabel(entry)).join(", ")}`
                                : ""}
                        </p>
                    ) : (
                        <p className="truncate text-[12px] text-muted-foreground" title={message.snippet}>{message.snippet}</p>
                    )}
                </div>
                <ChevronDown
                    className={cn("mt-0.5 size-4 shrink-0 text-foreground-subtle", open && "rotate-180")}
                    aria-hidden
                />
            </button>

            {open ? (
                <div className="border-t border-border px-3 py-3">
                    {failed ? (
                        <p className="text-[13px] text-danger">{failed}</p>
                    ) : readable ? (
                        <>
                            {readable.wantsReceipt ? (
                                <p className="mb-3 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground">
                                    <UserRoundX className="size-3.5 shrink-0" aria-hidden />
                                    The sender asked to be told when this was opened. Polaris did not tell them.
                                </p>
                            ) : null}
                            <MessageBody
                                html={readable.html}
                                text={readable.text}
                                remoteAllowed={readable.remoteAllowed}
                                remoteCount={readable.remoteCount}
                                trackerVendors={readable.trackerVendors}
                                onAlwaysAllow={
                                    sender
                                        ? () =>
                                              void (async () => {
                                                  const outcome = await trustSenderAction(message.accountId, {
                                                      address: sender.address,
                                                      trusted: true
                                                  });
                                                  const said = refusalOf(outcome);
                                                  if (said) {
                                                      toast.show({ title: said });
                                                      return;
                                                  }
                                                  toast.show({ title: `Pictures from ${sender.address} will load from now on.` });
                                                  refresh();
                                              })()
                                        : undefined
                                }
                            />
                            {message.attachments.filter((file) => !file.inline).length > 0 ? (
                                <ul className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                                    {message.attachments
                                        .filter((file) => !file.inline)
                                        .map((file) => (
                                            <li key={file.id}>
                                                <a
                                                    href={`/api/mail/attachments/${file.id}`}
                                                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                                                    download
                                                >
                                                    <Paperclip className="size-3.5 shrink-0" aria-hidden />
                                                    <span className="max-w-[16rem] truncate" title={file.name}>{file.name}</span>
                                                    <span className="shrink-0 text-foreground-subtle">
                                                        {readableSize(file.size)}
                                                    </span>
                                                    <Download className="size-3.5 shrink-0" aria-hidden />
                                                </a>
                                            </li>
                                        ))}
                                </ul>
                            ) : null}
                            {readable.unsubscribe ? (
                                <p className="mt-3 text-[12px] text-foreground-subtle">
                                    This looks like a mailing list.{" "}
                                    <a
                                        className="underline"
                                        href={readable.unsubscribe}
                                        target="_blank"
                                        rel="noopener noreferrer nofollow"
                                    >
                                        Unsubscribe
                                    </a>
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <div className="h-24 animate-pulse rounded-md bg-surface" aria-label="Opening the message" />
                    )}
                </div>
            ) : null}
        </li>
    );
}

/** A file size somebody can read. Not a locale format: the units are the same
 *  everywhere and the number is deliberately coarse. */
function readableSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
