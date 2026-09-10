"use client";

/**
 * Writing a message.
 *
 * Four decisions shape it.
 *
 * **The address it goes from is a field, not a mode.** Somebody with four
 * mailboxes writes from whichever one the conversation belongs to, and a reply
 * starts on the mailbox the message arrived in. Getting that wrong sends a work
 * message from a personal address, which cannot be taken back, so it is on
 * screen the whole time rather than in a menu - and the addresses a mailbox may
 * send AS sit in the same control, because to the writer they are one question.
 *
 * **It is the editor the rest of Polaris writes in.** The same surface as a note
 * and a chat message: real formatting, links, lists, code, emoji and paste. What
 * it produces is Markdown, which is what the mail pipeline already turns into
 * both halves of a message - so writing something formatted and sending
 * something that renders in every client are the same act.
 *
 * **Nothing is lost.** What is typed is saved as a draft a few seconds after
 * typing stops, so a closed tab, a reload or a crash costs the last few seconds.
 *
 * **Send is not final for ten seconds.** Pressing it queues the message and
 * starts a countdown; Undo puts it back. That window catches the wrong recipient
 * and the missing attachment, which are the two mistakes everybody makes.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { RecipientField } from "./recipient-field";
import { useMail, type ComposerSeed } from "./mail-shell";
import { EmojiPicker } from "@/app/(app)/chat/emoji-picker";
import type { MailTemplateView } from "@/lib/mailbox/templates";
import type { PickedFile } from "@/components/file-picker/picked-file";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { keepSignatureDelimiter, signatureBlock, withSignature } from "./signature";
import { useRef, useMemo, useState, useEffect, useCallback, useTransition } from "react";
import { draftSaves, type DraftFields, type DraftSaves, type DraftWriter } from "./draft-saves";
import {
    ChevronDown,
    Clock,
    FileText,
    Loader2,
    Maximize2,
    Minimize2,
    Minus,
    Paperclip,
    PenLine,
    Send,
    X
} from "lucide-react";
import {
    attachFromAddressAction,
    attachFromDriveAction,
    attachFromMessageAction,
    fileDraftOnServerAction,
    listTemplatesAction,
    saveDraftAction,
    sendAction,
    undoSendAction
} from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    Select,
    cn,
    useToast
} from "@polaris/ui";

/** How long typing settles before a draft is written. */
const AUTOSAVE_MS = 3000;

/** How the composer is sitting. `docked` is the corner panel, `full` takes the
 *  screen for a long message, `minimized` is a bar that keeps the draft alive
 *  while somebody goes and looks something up in the conversation behind it. */
type Posture = "docked" | "full" | "minimized";

interface Attached {
    readonly id: string;
    readonly name: string;
    readonly size: number;
}

/** Where a draft is written, for the composer's `draftSaves` queue. */
const writeDraft: DraftWriter = async (fields, id) => {
    const outcome = await saveDraftAction({ id, ...fields });
    return "draftId" in outcome && outcome.draftId ? outcome.draftId : null;
};

export function Composer() {
    const { accounts, identities, composing, openComposer, refresh, viewerName } = useMail();
    const toast = useToast();
    const [sending, startSending] = useTransition();

    const [posture, setPosture] = useState<Posture>("docked");
    const [accountId, setAccountId] = useState("");
    const [identityId, setIdentityId] = useState("");
    const [to, setTo] = useState<core.MailAddress[]>([]);
    const [cc, setCc] = useState<core.MailAddress[]>([]);
    const [bcc, setBcc] = useState<core.MailAddress[]>([]);
    const [showCopies, setShowCopies] = useState(false);
    const [subject, setSubject] = useState("");
    const [body, setBody] = useState("");
    const [files, setFiles] = useState<Attached[]>([]);
    const saves = useRef<DraftSaves | null>(null);
    const [sendAt, setSendAt] = useState<Date | null>(null);
    const [queued, setQueued] = useState<{ draftId: string; until: number } | null>(null);
    const [problem, setProblem] = useState("");
    const [picking, setPicking] = useState(false);
    const [insert, setInsert] = useState<{ token: number; text: string } | null>(null);

    // Opening the composer seeds it. Keyed on the seed object, which is replaced
    // whenever something asks for a new one, so pressing Reply on two different
    // conversations does not keep the first one's recipients.
    //
    // Only a NEW seed seeds. The mailboxes and their identities come from the
    // server and are fresh objects after every live refresh - which the draft's
    // own autosave causes, and any arriving message too - so running on them
    // wiped the recipients and the subject a few seconds into typing.
    const seeded = useRef<ComposerSeed | null>(null);
    useEffect(() => {
        if (!composing) {
            seeded.current = null;
            return;
        }
        if (seeded.current === composing) return;
        seeded.current = composing;
        const account = composing.accountId ?? accounts[0]?.id ?? "";
        const identity = (identities[account] ?? []).find((one) => one.isDefault);
        setAccountId(account);
        setIdentityId(identity?.id ?? "");
        setTo([...(composing.to ?? [])]);
        setCc([...(composing.cc ?? [])]);
        setBcc([...(composing.bcc ?? [])]);
        setShowCopies((composing.cc ?? []).length + (composing.bcc ?? []).length > 0);
        setSubject(composing.subject ?? "");
        const body = withSignature(composing, accounts.find((one) => one.id === account), identity);
        setBody(body);
        setFiles([]);
        saves.current = draftSaves(
            {
                accountId: account,
                identityId: identity?.id ?? null,
                to: [...(composing.to ?? [])],
                cc: [...(composing.cc ?? [])],
                bcc: [...(composing.bcc ?? [])],
                subject: composing.subject ?? "",
                body,
                attachmentIds: []
            },
            composing.draftId ?? null,
            writeDraft
        );
        setSendAt(null);
        setQueued(null);
        setProblem("");
        setPosture("docked");
    }, [composing, accounts, identities]);

    /** Files being brought over from the message being forwarded, and the ones
     *  that could not be. */
    const [carrying, setCarrying] = useState(false);
    const [notCarried, setNotCarried] = useState<string[]>([]);

    // A forward brings the original's files with it. A reopened draft already
    // has whatever survived of them, so only a fresh forward asks.
    useEffect(() => {
        setNotCarried([]);
        if (!composing?.forward || !composing.inReplyToId || composing.draftId) {
            setCarrying(false);
            return;
        }
        let current = true;
        setCarrying(true);
        void (async () => {
            const outcome = await attachFromMessageAction({ messageId: composing.inReplyToId });
            if (!current) return;
            setCarrying(false);
            const said = refusalOf(outcome);
            if (said) {
                setNotCarried([said]);
                return;
            }
            if ("uploads" in outcome) {
                const carried = outcome.uploads as Attached[];
                setFiles((held) => [...held, ...carried]);
                saves.current?.carry(carried.map((file) => file.id));
                setNotCarried(outcome.skipped);
            }
        })();
        return () => {
            current = false;
        };
    }, [composing]);

    const dirty = to.length > 0 || subject.trim() !== "" || body.trim() !== "" || files.length > 0;

    // The draft, a few seconds after typing stops. Skipped while nothing has been
    // typed - an opened-and-closed composer should not leave an empty draft.
    useEffect(() => {
        if (!composing || !accountId || !dirty || queued) return;
        const timer = setTimeout(() => {
            void saves.current?.save({
                accountId,
                identityId: identityId || null,
                to,
                cc,
                bcc,
                subject,
                body,
                attachmentIds: files.map((file) => file.id)
            });
        }, AUTOSAVE_MS);
        return () => clearTimeout(timer);
    }, [composing, accountId, identityId, to, cc, bcc, subject, body, files, dirty, queued]);

    const attach = useCallback(
        async (chosen: readonly File[]) => {
            for (const file of chosen) {
                if (file.size > core.MAIL_MAX_ATTACHMENT_BYTES) {
                    toast.show({
                        title: `${file.name} is bigger than most mail servers will accept.`
                    });
                    continue;
                }
                const form = new FormData();
                form.set("file", file);
                const response = await fetch("/api/mail/uploads", { method: "POST", body: form });
                const answer = (await response.json().catch(() => null)) as {
                    upload?: Attached;
                    error?: string;
                } | null;
                if (!response.ok || !answer?.upload) {
                    toast.show({ title: answer?.error ?? "That file could not be attached." });
                    continue;
                }
                const stored = answer.upload;
                setFiles((held) => [...held, stored]);
            }
        },
        [toast]
    );

    /**
     * Files chosen anywhere but this machine.
     *
     * A file already on a storage Polaris can reach never travels: the server
     * copies it. So does one at an address somebody pasted, through the same
     * guard every outside address goes through - the browser is not asked to
     * fetch a stranger's URL on the reader's behalf.
     */
    const attachPicked = useCallback(
        async (picked: readonly PickedFile[]) => {
            const fromComputer = picked.filter((one) => one.kind === "upload");
            if (fromComputer.length > 0) {
                await attach(fromComputer.map((one) => (one as { file: File }).file));
            }
            for (const one of picked) {
                if (one.kind === "upload") continue;
                const answer =
                    one.kind === "drive"
                        ? await attachFromDriveAction({
                              connectionId: one.connectionId,
                              path: one.path
                          })
                        : await attachFromAddressAction({ url: one.url });
                const said = refusalOf(answer);
                if (said) {
                    toast.show({ title: said });
                    continue;
                }
                if ("upload" in answer && answer.upload) {
                    const stored = answer.upload as Attached;
                    setFiles((held) => [...held, stored]);
                }
            }
        },
        [attach, toast]
    );

    const remove = useCallback(async (uploadId: string) => {
        setFiles((held) => held.filter((file) => file.id !== uploadId));
        await fetch(`/api/mail/uploads?id=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
    }, []);

    const send = useCallback(
        (when: Date | null) => {
            setProblem("");
            startSending(async () => {
                const fields: DraftFields = {
                    accountId,
                    identityId: identityId || null,
                    to,
                    cc,
                    bcc,
                    subject,
                    body,
                    attachmentIds: files.map((file) => file.id)
                };
                const draftId = (await saves.current?.after((id) => Promise.resolve(id))) ?? null;
                saves.current?.hold();
                const outcome = await sendAction({
                    ...fields,
                    inReplyToId: composing?.inReplyToId ?? null,
                    forward: composing?.forward ?? false,
                    sendAt: when,
                    draftId
                });
                const said = refusalOf(outcome);
                if (said) {
                    saves.current?.release();
                    setProblem(said);
                    return;
                }
                if (
                    "draftId" in outcome &&
                    outcome.draftId &&
                    "sendAt" in outcome &&
                    outcome.sendAt
                ) {
                    saves.current?.adopt(outcome.draftId, fields);
                    setQueued({
                        draftId: outcome.draftId,
                        until: new Date(outcome.sendAt).getTime()
                    });
                }
                refresh();
            });
        },
        [accountId, identityId, to, cc, bcc, subject, body, files, composing, refresh]
    );

    /**
     * Close, keeping what was written.
     *
     * The draft is saved a few seconds after typing stops, so the last words
     * typed before closing were not saved yet - they are now. Then the draft's
     * copy goes to the server's Drafts folder, so it can be finished on another
     * device. A message waiting to go is left to the queue.
     */
    const close = useCallback(() => {
        openComposer(null);
        if (queued || !accountId) return;
        const fields: DraftFields = {
            accountId,
            identityId: identityId || null,
            to,
            cc,
            bcc,
            subject,
            body,
            attachmentIds: files.map((file) => file.id)
        };
        void (async () => {
            const id = await saves.current?.save(fields);
            if (id) await fileDraftOnServerAction(id);
            refresh();
        })();
    }, [openComposer, queued, accountId, identityId, to, cc, bcc, subject, body, files, refresh]);

    const account = accounts.find((one) => one.id === accountId);
    const own = useMemo(() => identities[accountId] ?? [], [identities, accountId]);
    const identity = own.find((one) => one.id === identityId);
    /** What this message would sign with, for the Insert button. */
    const signature = (identity?.signature || account?.signature || "").trim();

    // A message with nowhere to leave from is not a message: the shell sends a
    // Write with no mailbox to connecting one, and a mailbox removed while a
    // draft was open takes the composer with it.
    if (!composing || accounts.length === 0) return null;

    const from = account
        ? core.formatAddress({
              name: identity?.displayName || account.displayName || viewerName,
              address: identity?.address || account.address
          })
        : "";

    const shell =
        posture === "full"
            ? "inset-4 md:inset-10 rounded-lg border-b"
            : posture === "minimized"
              ? "bottom-0 right-6 w-[22rem]"
              : // Taller and wider than it was. A composer whose body is three
                // lines is one people write three lines in, and the message
                // being written is the whole point of the screen it covers.
                "inset-x-0 bottom-0 mx-auto flex w-full max-w-3xl md:inset-x-auto md:right-6 md:mx-0 md:h-[38rem] md:max-h-[85vh] md:w-[40rem]";

    return (
        <div
            className={cn(
                "fixed z-40 flex flex-col rounded-t-lg border border-b-0 border-border bg-elevated shadow-modal",
                shell
            )}
            role="dialog"
            aria-label="New message"
        >
            <header className="flex items-center gap-1 border-b border-border px-3 py-2">
                <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-medium"
                    onClick={() => setPosture(posture === "minimized" ? "docked" : "minimized")}
                >
                    {subject.trim() || "New message"}
                </button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                        posture === "minimized" ? "Open the composer" : "Minimize the composer"
                    }
                    title={posture === "minimized" ? "Open the composer" : "Minimize the composer"}
                    onClick={() => setPosture(posture === "minimized" ? "docked" : "minimized")}
                >
                    <Minus className="size-4 shrink-0" aria-hidden />
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={posture === "full" ? "Shrink the composer" : "Expand the composer"}
                    title={posture === "full" ? "Shrink the composer" : "Expand the composer"}
                    onClick={() => setPosture(posture === "full" ? "docked" : "full")}
                >
                    {posture === "full" ? (
                        <Minimize2 className="size-4 shrink-0" aria-hidden />
                    ) : (
                        <Maximize2 className="size-4 shrink-0" aria-hidden />
                    )}
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close the composer"
                    title="Close the composer"
                    onClick={close}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            </header>

            {posture === "minimized" ? null : queued ? (
                <QueuedNotice
                    until={queued.until}
                    onUndo={() =>
                        void (async () => {
                            const outcome = await undoSendAction(queued.draftId);
                            if ("undone" in outcome && outcome.undone) {
                                setQueued(null);
                                saves.current?.release();
                                toast.show({ title: "Brought back. Nothing was sent." });
                                refresh();
                                return;
                            }
                            toast.show({ title: "That message has already gone." });
                            openComposer(null);
                        })()
                    }
                    onDone={() => openComposer(null)}
                />
            ) : (
                <>
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                        <div className="space-y-1.5 border-b border-border px-4 py-3">
                            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                <span className="w-12 shrink-0">From</span>
                                {accounts.length > 1 || own.length > 0 ? (
                                    <Select
                                        value={
                                            identityId
                                                ? `identity:${identityId}`
                                                : `account:${accountId}`
                                        }
                                        onValueChange={(next) => {
                                            const [kind, id] = next.split(":");
                                            if (kind === "identity") {
                                                setIdentityId(id ?? "");
                                                return;
                                            }
                                            setAccountId(id ?? "");
                                            setIdentityId("");
                                        }}
                                        aria-label="The address this is sent from"
                                        className="min-w-0 flex-1"
                                        options={accounts.flatMap((one) => [
                                            {
                                                value: `account:${one.id}`,
                                                label: one.label
                                                    ? `${one.label} - ${one.address}`
                                                    : one.address
                                            },
                                            ...(identities[one.id] ?? []).map((alias) => ({
                                                value: `identity:${alias.id}`,
                                                label: `${alias.address} (via ${one.address})`
                                            }))
                                        ])}
                                    />
                                ) : (
                                    <span className="min-w-0 truncate text-foreground" title={from}>
                                        {from}
                                    </span>
                                )}
                            </label>

                            <RecipientField label="To" value={to} onChange={setTo} autoFocus />
                            {showCopies ? (
                                <>
                                    <RecipientField label="Cc" value={cc} onChange={setCc} />
                                    <RecipientField label="Bcc" value={bcc} onChange={setBcc} />
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className="pl-12 text-[12px] text-muted-foreground hover:text-foreground"
                                    onClick={() => setShowCopies(true)}
                                >
                                    Add a copy or a blind copy
                                </button>
                            )}

                            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                <span className="w-12 shrink-0">Subject</span>
                                <Input
                                    value={subject}
                                    onChange={(event) => setSubject(event.target.value)}
                                    aria-label="Subject"
                                    className="h-8 min-w-0 flex-1 text-[13px]"
                                />
                            </label>
                        </div>

                        {/* The body takes whatever is left, so the message is
                            the biggest thing in the composer rather than a strip
                            under the headers. */}
                        <div className="flex min-h-0 flex-1 flex-col px-2 py-2">
                            <RichTextEditor
                                value={body}
                                onChange={(next) => setBody(keepSignatureDelimiter(next))}
                                insert={insert}
                                placeholder="Write your message"
                                className="flex min-h-[14rem] flex-1 flex-col"
                                // A screenshot pasted in is an attachment rather
                                // than a picture pasted into the text: a data URI
                                // that size is refused by mail servers and shows
                                // up as a broken image at the other end.
                                onPasteFiles={(dropped) => {
                                    void attach([...dropped]);
                                    return true;
                                }}
                            />
                        </div>

                        {carrying ? (
                            <p className="flex items-center gap-1.5 px-3 pb-2 text-[12px] text-foreground-subtle">
                                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                                Bringing the files over from the original message
                            </p>
                        ) : notCarried.length > 0 ? (
                            <p className="px-3 pb-2 text-[12px] text-foreground-subtle">
                                Not carried over: {notCarried.join(", ")}. Attach again if needed.
                            </p>
                        ) : null}

                        {files.length > 0 ? (
                            <ul className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
                                {files.map((file) => (
                                    <li
                                        key={file.id}
                                        className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[12px]"
                                    >
                                        <Paperclip
                                            className="size-3.5 shrink-0 text-foreground-subtle"
                                            aria-hidden
                                        />
                                        <span className="max-w-[14rem] truncate" title={file.name}>
                                            {file.name}
                                        </span>
                                        <button
                                            type="button"
                                            aria-label={`Remove ${file.name}`}
                                            title={`Remove ${file.name}`}
                                            className="text-foreground-subtle hover:text-foreground"
                                            onClick={() => void remove(file.id)}
                                        >
                                            <X className="size-3.5 shrink-0" aria-hidden />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>

                    <footer className="flex flex-wrap items-center gap-1 border-t border-border px-3 py-2">
                        <div className="flex items-stretch">
                            <Button
                                className="rounded-r-none"
                                onClick={() => send(sendAt)}
                                disabled={sending || to.length === 0 || !accountId}
                            >
                                {sending ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                                ) : (
                                    <Send className="size-4 shrink-0" aria-hidden />
                                )}
                                {sendAt ? "Schedule" : "Send"}
                            </Button>
                            <SendLaterMenu
                                disabled={sending || to.length === 0 || !accountId}
                                chosen={sendAt}
                                onChoose={(when) => {
                                    setSendAt(when);
                                    if (when) send(when);
                                }}
                            />
                        </div>

                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Attach a file"
                            title="Attach a file"
                            onClick={() => setPicking(true)}
                        >
                            <Paperclip className="size-4 shrink-0" aria-hidden />
                        </Button>

                        <EmojiPicker
                            disabled={false}
                            media={false}
                            onEmoji={(emoji) => setInsert({ token: Date.now(), text: emoji })}
                        />

                        <TemplateMenu
                            accountId={accountId}
                            onPick={(template) => {
                                setInsert({ token: Date.now(), text: template.body });
                                // A template's subject fills an empty line and
                                // never replaces one somebody already wrote.
                                if (template.subject && !subject.trim()) setSubject(template.subject);
                            }}
                        />

                        {signature ? (
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Insert your signature"
                                title="Insert your signature"
                                onClick={() =>
                                    setInsert({
                                        token: Date.now(),
                                        text: `\n\n${signatureBlock(signature)}`
                                    })
                                }
                            >
                                <PenLine className="size-4 shrink-0" aria-hidden />
                            </Button>
                        ) : null}

                        {problem ? (
                            <p className="min-w-0 flex-1 basis-full text-[12px] text-danger">
                                {problem}
                            </p>
                        ) : null}
                    </footer>
                </>
            )}

            {picking ? (
                <FilePickerDialog
                    title="Attach to this message"
                    onClose={() => setPicking(false)}
                    onPick={(picked) => void attachPicked(picked)}
                />
            ) : null}
        </div>
    );
}

/**
 * Insert a template.
 *
 * The list is asked for when the menu opens rather than with the page: most
 * messages are written without one, and a template made in another tab a minute
 * ago should be in the list. Only the ones offered for the mailbox this message
 * goes from are shown - a support reply tied to the support address has no
 * business in a personal message.
 */
function TemplateMenu({
    accountId,
    onPick
}: {
    accountId: string;
    onPick: (template: MailTemplateView) => void;
}) {
    const [templates, setTemplates] = useState<MailTemplateView[] | null>(null);

    const offered = (templates ?? []).filter(
        (template) => template.accountId === null || template.accountId === accountId
    );

    return (
        <DropdownMenu
            onOpenChange={(open) => {
                if (!open) return;
                void listTemplatesAction().then((answer) => setTemplates(answer.templates));
            }}
        >
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Insert a template"
                    title="Insert a template"
                >
                    <FileText className="size-4 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-72">
                {templates === null ? (
                    <DropdownMenuItem disabled>
                        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        Loading templates
                    </DropdownMenuItem>
                ) : offered.length === 0 ? (
                    <DropdownMenuItem disabled>No templates for this mailbox yet</DropdownMenuItem>
                ) : (
                    offered.map((template) => (
                        <DropdownMenuItem key={template.id} onSelect={() => onPick(template)}>
                            <span className="truncate" title={template.name}>{template.name}</span>
                        </DropdownMenuItem>
                    ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/mail/settings/templates">Manage templates</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * Send later.
 *
 * A handful of times somebody would actually pick, and a specific one for
 * everything else. Nothing new underneath it: the queue already holds a message
 * with an hour on it, so this only decides which hour.
 */
function SendLaterMenu({
    disabled,
    chosen,
    onChoose
}: {
    disabled: boolean;
    chosen: Date | null;
    onChoose: (when: Date | null) => void;
}) {
    const [custom, setCustom] = useState("");
    const [asking, setAsking] = useState(false);

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="icon"
                        className="rounded-l-none border-l border-black/20"
                        disabled={disabled}
                        aria-label="Send later"
                        title="Send later"
                    >
                        <ChevronDown className="size-4 shrink-0" aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {SEND_TIMES.map((entry) => (
                        <DropdownMenuItem key={entry.label} onSelect={() => onChoose(entry.when())}>
                            <Clock className="size-3.5 shrink-0" aria-hidden />
                            {entry.label}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setAsking(true)}>
                        Pick a time...
                    </DropdownMenuItem>
                    {chosen ? (
                        <DropdownMenuItem onSelect={() => onChoose(null)}>
                            Send it now instead
                        </DropdownMenuItem>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>

            {asking ? (
                <Dialog open onOpenChange={(next) => (next ? undefined : setAsking(false))}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>Send this when?</DialogTitle>
                        </DialogHeader>
                        <Input
                            type="datetime-local"
                            value={custom}
                            aria-label="The time to send it"
                            onChange={(event) => setCustom(event.target.value)}
                        />
                        <div className="mt-3 flex gap-2">
                            <Button
                                disabled={!custom || new Date(custom).getTime() <= Date.now()}
                                onClick={() => {
                                    onChoose(new Date(custom));
                                    setAsking(false);
                                }}
                            >
                                Schedule it
                            </Button>
                            <Button variant="ghost" onClick={() => setAsking(false)}>
                                Cancel
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}
        </>
    );
}

/** The times worth having on a menu. Anything else is the picker. */
const SEND_TIMES: readonly { label: string; when: () => Date }[] = [
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
        label: "Monday morning",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + ((8 - when.getDay()) % 7 || 7));
            when.setHours(8, 0, 0, 0);
            return when;
        }
    }
];

/**
 * The countdown after Send.
 *
 * It closes itself when it reaches zero rather than sitting there saying "sent",
 * because a composer that stays open after a message has gone is one somebody
 * sends twice. A message scheduled for next week says so instead of counting
 * down to it.
 */
function QueuedNotice({
    until,
    onUndo,
    onDone
}: {
    until: number;
    onUndo: () => void;
    onDone: () => void;
}) {
    const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    // Anything further out than a minute is a scheduled message rather than a
    // send in progress, and counting down to Thursday would be absurd.
    const scheduled = until - Date.now() > 60_000;

    useEffect(() => {
        if (scheduled) return;
        const timer = setInterval(() => {
            const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
            setLeft(remaining);
            if (remaining === 0) onDone();
        }, 250);
        return () => clearInterval(timer);
    }, [until, onDone, scheduled]);

    return (
        <div className="flex items-center gap-3 px-4 py-6">
            <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                {scheduled
                    ? "Waiting until it is due."
                    : left > 0
                      ? `Sending in ${left}s.`
                      : "Sending."}
            </p>
            {scheduled || left > 0 ? (
                <Button variant="secondary" onClick={onUndo}>
                    {scheduled ? "Bring it back" : "Undo"}
                </Button>
            ) : null}
            {scheduled ? (
                <Button variant="ghost" onClick={onDone}>
                    Done
                </Button>
            ) : null}
        </div>
    );
}
