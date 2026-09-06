"use client";

/**
 * Writing a message.
 *
 * Three decisions shape it.
 *
 * **The mailbox it goes from is a field, not a mode.** Somebody with four
 * mailboxes writes from whichever one the conversation belongs to, and a reply
 * starts on the mailbox the message arrived in. Getting that wrong sends a work
 * message from a personal address, which cannot be taken back, so the address is
 * on screen the whole time rather than in a menu.
 *
 * **Nothing is lost.** What is typed is saved as a draft a few seconds after
 * typing stops, so a closed tab, a reload or a crash costs the last few seconds
 * and nothing more.
 *
 * **Send is not final for ten seconds.** Pressing it queues the message and
 * starts a countdown; Undo puts it back in the composer. That window is what
 * catches the wrong recipient and the missing attachment, which are the two
 * mistakes everybody makes and the only two that matter.
 */

import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { RecipientField } from "./recipient-field";
import { useMail } from "./mail-shell";
import { Loader2, Paperclip, Send, X } from "lucide-react";
import { Button, Input, Select, useToast } from "@polaris/ui";
import { saveDraftAction, sendAction, undoSendAction } from "./actions";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

/** How long typing settles before a draft is written. */
const AUTOSAVE_MS = 3000;

interface Attached {
    readonly id: string;
    readonly name: string;
    readonly size: number;
}

export function Composer() {
    const { accounts, composing, openComposer, refresh, viewerName } = useMail();
    const toast = useToast();
    const [sending, startSending] = useTransition();

    const [accountId, setAccountId] = useState("");
    const [to, setTo] = useState<core.MailAddress[]>([]);
    const [cc, setCc] = useState<core.MailAddress[]>([]);
    const [bcc, setBcc] = useState<core.MailAddress[]>([]);
    const [showCopies, setShowCopies] = useState(false);
    const [subject, setSubject] = useState("");
    const [body, setBody] = useState("");
    const [files, setFiles] = useState<Attached[]>([]);
    const [draftId, setDraftId] = useState<string | null>(null);
    const [queued, setQueued] = useState<{ draftId: string; until: number } | null>(null);
    const [problem, setProblem] = useState("");
    const picker = useRef<HTMLInputElement | null>(null);

    // Opening the composer seeds it. Keyed on the seed object, which is replaced
    // whenever something asks for a new one, so pressing Reply twice on two
    // different conversations does not keep the first one's recipients.
    useEffect(() => {
        if (!composing) return;
        setAccountId(composing.accountId ?? accounts[0]?.id ?? "");
        setTo([...(composing.to ?? [])]);
        setCc([...(composing.cc ?? [])]);
        setBcc([]);
        setShowCopies((composing.cc ?? []).length > 0);
        setSubject(composing.subject ?? "");
        setBody(composing.body ?? "");
        setFiles([]);
        setDraftId(composing.draftId ?? null);
        setQueued(null);
        setProblem("");
    }, [composing, accounts]);

    const dirty = to.length > 0 || subject.trim() !== "" || body.trim() !== "" || files.length > 0;

    // The draft, written a few seconds after typing stops. Skipped while nothing
    // has been typed - an opened-and-closed composer should not leave an empty
    // draft in somebody's Drafts.
    useEffect(() => {
        if (!composing || !accountId || !dirty || queued) return;
        const timer = setTimeout(() => {
            void (async () => {
                const outcome = await saveDraftAction({
                    id: draftId,
                    accountId,
                    to,
                    cc,
                    bcc,
                    subject,
                    body,
                    attachmentIds: files.map((file) => file.id)
                });
                if ("draftId" in outcome && outcome.draftId) setDraftId(outcome.draftId);
            })();
        }, AUTOSAVE_MS);
        return () => clearTimeout(timer);
    }, [composing, accountId, to, cc, bcc, subject, body, files, draftId, dirty, queued]);

    const attach = useCallback(
        async (chosen: FileList | null) => {
            if (!chosen) return;
            for (const file of Array.from(chosen)) {
                if (file.size > core.MAIL_MAX_ATTACHMENT_BYTES) {
                    toast.show({ title: `${file.name} is bigger than most mail servers will accept.` });
                    continue;
                }
                const form = new FormData();
                form.set("file", file);
                const response = await fetch("/api/mail/uploads", { method: "POST", body: form });
                const answer = (await response.json().catch(() => null)) as
                    | { upload?: Attached; error?: string }
                    | null;
                if (!response.ok || !answer?.upload) {
                    toast.show({ title: answer?.error ?? "That file could not be attached." });
                    continue;
                }
                setFiles((held) => [...held, answer.upload!]);
            }
        },
        [toast]
    );

    const remove = useCallback(async (uploadId: string) => {
        setFiles((held) => held.filter((file) => file.id !== uploadId));
        await fetch(`/api/mail/uploads?id=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
    }, []);

    const send = useCallback(() => {
        setProblem("");
        startSending(async () => {
            const outcome = await sendAction({
                accountId,
                to,
                cc,
                bcc,
                subject,
                body,
                attachmentIds: files.map((file) => file.id),
                inReplyToId: composing?.inReplyToId ?? null,
                forward: composing?.forward ?? false,
                draftId
            });
            const said = refusalOf(outcome);
            if (said) {
                setProblem(said);
                return;
            }
            if ("draftId" in outcome && outcome.draftId && "sendAt" in outcome && outcome.sendAt) {
                setQueued({ draftId: outcome.draftId, until: new Date(outcome.sendAt).getTime() });
            }
            refresh();
        });
    }, [accountId, to, cc, bcc, subject, body, files, composing, draftId, refresh]);

    if (!composing) return null;

    const account = accounts.find((one) => one.id === accountId);
    const from = account
        ? core.formatAddress({ name: account.displayName || viewerName, address: account.address })
        : "";

    return (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-h-[85vh] w-full max-w-3xl flex-col rounded-t-lg border border-b-0 border-border bg-elevated shadow-modal md:right-6 md:left-auto md:mx-0 md:w-[36rem]">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {subject.trim() || "New message"}
                </h2>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close the composer"
                    title="Close the composer"
                    onClick={() => openComposer(null)}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            </header>

            {queued ? (
                <QueuedNotice
                    until={queued.until}
                    onUndo={() =>
                        void (async () => {
                            const outcome = await undoSendAction(queued.draftId);
                            if ("undone" in outcome && outcome.undone) {
                                setQueued(null);
                                setDraftId(queued.draftId);
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
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <div className="space-y-2 px-3 py-2">
                        {accounts.length > 1 ? (
                            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                <span className="w-10 shrink-0">From</span>
                                <Select
                                    value={accountId}
                                    onValueChange={setAccountId}
                                    options={accounts.map((one) => ({
                                        value: one.id,
                                        label: one.label ? `${one.label} - ${one.address}` : one.address
                                    }))}
                                    aria-label="The mailbox this is sent from"
                                    className="min-w-0 flex-1"
                                />
                            </label>
                        ) : (
                            <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                <span className="w-10 shrink-0">From</span>
                                <span className="min-w-0 truncate text-foreground" title={from}>{from}</span>
                            </p>
                        )}

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
                            <span className="w-10 shrink-0">Subject</span>
                            <Input
                                value={subject}
                                onChange={(event) => setSubject(event.target.value)}
                                aria-label="Subject"
                                className="h-8 min-w-0 flex-1 text-[13px]"
                            />
                        </label>
                    </div>

                    <textarea
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        aria-label="Message"
                        placeholder="Write your message. Markdown works."
                        className="min-h-[14rem] w-full resize-none border-0 bg-transparent px-3 py-2 text-[13px] leading-relaxed outline-none"
                    />

                    {files.length > 0 ? (
                        <ul className="flex flex-wrap gap-2 border-t border-border px-3 py-2">
                            {files.map((file) => (
                                <li
                                    key={file.id}
                                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[12px]"
                                >
                                    <Paperclip className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden />
                                    <span className="max-w-[14rem] truncate" title={file.name}>{file.name}</span>
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
            )}

            {!queued ? (
                <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
                    <Button onClick={send} disabled={sending || to.length === 0 || !accountId}>
                        {sending ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        ) : (
                            <Send className="size-4 shrink-0" aria-hidden />
                        )}
                        Send
                    </Button>
                    <input
                        ref={picker}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                            void attach(event.target.files);
                            event.target.value = "";
                        }}
                    />
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Attach a file"
                        title="Attach a file"
                        onClick={() => picker.current?.click()}
                    >
                        <Paperclip className="size-4 shrink-0" aria-hidden />
                    </Button>
                    {problem ? <p className="min-w-0 flex-1 truncate text-[12px] text-danger" title={problem}>{problem}</p> : null}
                </footer>
            ) : null}
        </div>
    );
}

/**
 * The countdown after Send.
 *
 * It closes itself when it reaches zero rather than sitting there saying "sent",
 * because a composer that stays open after a message has gone is one somebody
 * sends twice.
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

    useEffect(() => {
        const timer = setInterval(() => {
            const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
            setLeft(remaining);
            if (remaining === 0) onDone();
        }, 250);
        return () => clearInterval(timer);
    }, [until, onDone]);

    return (
        <div className="flex items-center gap-3 px-4 py-6">
            <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                {left > 0 ? `Sending in ${left}s.` : "Sending."}
            </p>
            {left > 0 ? (
                <Button variant="secondary" onClick={onUndo}>
                    Undo
                </Button>
            ) : null}
        </div>
    );
}
