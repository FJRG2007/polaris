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

import dynamic from "next/dynamic";
import { saveFile, sendFile } from "@/components/transfers/move-file";
import { isViewable } from "@/app/(app)/drive/viewer/kind";
import type { ViewerTarget } from "@/app/(app)/drive/viewer/types";
import { useDockedCorner } from "@/components/docked-corner";
import Link from "next/link";
import { useBusy } from "./use-busy";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { mailRefusalText } from "@/lib/mailbox/refusal-text";
import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { RecipientField } from "./recipient-field";
import { useMail, type ComposerSeed } from "./mail-shell";
import { EmojiPicker } from "@/app/(app)/chat/emoji-picker";
import type { MailTemplateView } from "@/lib/mailbox/templates";
import type { PickedFile } from "@/components/file-picker/picked-file";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { useRef, useMemo, useState, useEffect, useCallback } from "react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { ImproveButton } from "@/components/polar/improve-button";
import { AiRewriting } from "@/components/polar/ai-rewriting";
import { FillInBar } from "@/components/polar/fill-in-bar";
import { fillInFields } from "@/lib/polar/improve-draft";
import { keepSignatureDelimiter, signatureBlock, splitAtSignature, withSignature } from "./signature";
import { joinComposerBody, trimComposerBody } from "./trimmed-content";
import { TrimmedPill } from "./trimmed-pill";
import { draftSaves, type DraftFields, type DraftSaves, type DraftWriter } from "./draft-saves";
import { readMessage } from "./message-store";
import { answerSeed, draftAnswerKind, type AnswerContext, type AnswerKind } from "./answering";
import {
    Check,
    ChevronDown,
    Clock,
    FileText,
    Loader2,
    Maximize2,
    Minimize2,
    Minus,
    Forward,
    Paperclip,
    PenLine,
    Reply,
    ReplyAll,
    Send,
    X
} from "lucide-react";
import * as outbox from "./outbox";
import { keepSend } from "./offline-sends";
import { draftSaved, draftWrite, keepDraft, type KeptDraft } from "./offline-drafts";
import { newClientKey } from "@/lib/offline/outbox";
import { keepOnUnload } from "@/lib/offline/app-writes";
import { rememberSender } from "./default-sender";
import { useDisplayFormat } from "@/components/display-format";
import {
    attachFromAddressAction,
    attachFromDriveAction,
    attachFromMessageAction,
    draftAttachmentsAction,
    fileDraftOnServerAction,
    listTemplatesAction
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
    useToast,
    DateInput,
    clearWindowControls
} from "@polaris/ui";

/** The viewer Drive opens a file in, loaded the first time a file is opened
 *  rather than with every composer - see the same note in `thread-view`. */
const FileViewer = dynamic(
    () => import("@/app/(app)/drive/file-viewer").then((module) => module.FileViewer),
    { ssr: false }
);

/** Where the viewer reads an attachment of a message still being written. */
function uploadUrl(id: string, inline = false): string {
    return `/api/mail/uploads?id=${encodeURIComponent(id)}${inline ? "&inline=1" : ""}`;
}

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

/** Where a draft is written, for the composer's `draftSaves` queue. A request of
 *  its own rather than a server action, because it fires on a timer - see
 *  `outbox`. A new message carries the composer's key, so a save whose answer
 *  never came back does not write a second draft; once saved, nothing older of
 *  it kept on this device is left to save. */
function draftWriter(draftKey: string): DraftWriter {
    return async (fields, id) => {
        const outcome = await outbox.saveDraft(fields, id, id ? undefined : draftKey);
        if (outbox.isRefused(outcome)) return null;
        draftSaved({ id: outcome.draftId, draftKey });
        return outcome.draftId;
    };
}

/** A route's answer, when there is one to read. */
function parsed(body: string): unknown {
    try {
        return JSON.parse(body || "null");
    } catch {
        return null;
    }
}

export function Composer() {
    const {
        accounts,
        identities,
        composing,
        openComposer,
        refreshMailbox,
        viewerName,
        shelf,
        canImprove
    } = useMail();
    const toast = useToast();
    const t = useTranslations("mailCompose");
    const tm = useTranslations("mail");
    const [sending, startSending] = useBusy();

    const [posture, setPosture] = useState<Posture>("docked");
    const [accountId, setAccountId] = useState("");
    const [identityId, setIdentityId] = useState("");
    const [to, setTo] = useState<core.MailAddress[]>([]);
    const [cc, setCc] = useState<core.MailAddress[]>([]);
    const [bcc, setBcc] = useState<core.MailAddress[]>([]);
    const [showCopies, setShowCopies] = useState(false);
    const [subject, setSubject] = useState("");
    const [body, setBody] = useState("");
    /**
     * The history a reply or a forward carries, folded away under "..." the way
     * Gmail trims it. It is still the message: everything that saves or sends
     * reads `message`, which is the two joined back exactly - so a quote nobody
     * opened goes out as the very text it always did. Opening it puts it into
     * the editor and leaves this empty for the rest of the draft.
     */
    const [trimmed, setTrimmed] = useState("");
    const [expanded, setExpanded] = useState(false);
    const message = joinComposerBody(body, trimmed);
    const [files, setFiles] = useState<Attached[]>([]);
    /** The same, for a close that has to wait for a reopened draft's files. */
    const filesNow = useRef<Attached[]>([]);
    filesNow.current = files;
    /**
     * A reopened draft's files, while they are on their way.
     *
     * Nothing saves until they are here: a save names every file the draft
     * keeps, and one that ran before they arrived named none - which took them
     * off the draft and off the disk.
     */
    const [loadingFiles, setLoadingFiles] = useState(false);
    const filesLoad = useRef<Promise<void> | null>(null);
    /** The attachment open in the viewer, and whether the viewer was ever needed. */
    const [viewing, setViewing] = useState<ViewerTarget | null>(null);
    const [viewerWanted, setViewerWanted] = useState(false);
    useEffect(() => {
        if (viewing) setViewerWanted(true);
    }, [viewing]);
    const saves = useRef<DraftSaves | null>(null);
    /** The composer's own key for its draft - see `offline-drafts`. */
    const draftKey = useRef("");
    const [sendAt, setSendAt] = useState<Date | null>(null);
    const [queued, setQueued] = useState<{ draftId: string; until: number } | null>(null);
    const [problem, setProblem] = useState("");
    const [picking, setPicking] = useState(false);
    /** The docked panel itself, so it can say how much of the corner it takes. */
    const shell = useRef<HTMLDivElement | null>(null);
    const [insert, setInsert] = useState<{ token: number; text: string } | null>(null);
    /** Whether "Improve" is rewriting the body, and the field to fill it last picked. */
    const [rewriting, setRewriting] = useState(false);
    const [reveal, setReveal] = useState<{ token: number; label: string } | null>(null);
    /** The body a "fields still to fill" warning was shown for: sending that
     *  same body again sends it as it is. */
    const warnedFor = useRef<string | null>(null);
    /**
     * Putting the writer in the message, on a line of their own.
     *
     * A reply and a forward open holding somebody else's words, and what they
     * open on was the attribution line of that message: the writer had to make
     * room above it before they could start, every single time. A draft being
     * reopened is the other way round - the text at the top is their own, and
     * they go back to the end of it.
     */
    const [focusAt, setFocusAt] = useState(0);
    const [ownLine, setOwnLine] = useState(false);
    /**
     * Reply, Reply all or Forward, for a composer one of those opened. Switched
     * from the composer itself - see `switchAnswer`. A draft reopened from
     * Drafts gets the same switch once the message it answers has loaded.
     */
    const [switched, setSwitched] = useState<{ seed: ComposerSeed; kind: AnswerKind } | null>(
        null
    );
    const [restored, setRestored] = useState<{ seed: ComposerSeed; context: AnswerContext } | null>(
        null
    );
    // Held with the seed it belongs to, so the render a new seed arrives in
    // does not read the last composer's choice for this one.
    const answering =
        composing?.answering ?? (restored && restored.seed === composing ? restored.context : null);
    const answerKind =
        switched && switched.seed === composing ? switched.kind : (answering?.kind ?? null);
    const forwarding = answerKind ? answerKind === "forward" : Boolean(composing?.forward);
    /** The files a forward brought over, which a switch back to a reply drops. */
    const carriedIds = useRef<string[]>([]);

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
        const kept = composing.kept;
        const identity = kept
            ? (identities[account] ?? []).find((one) => one.id === kept.identityId)
            : (identities[account] ?? []).find((one) => one.isDefault);
        draftKey.current = kept?.draftKey ?? newClientKey();
        setAccountId(account);
        setIdentityId(identity?.id ?? "");
        setTo([...(composing.to ?? [])]);
        setCc([...(composing.cc ?? [])]);
        setBcc([...(composing.bcc ?? [])]);
        setShowCopies((composing.cc ?? []).length + (composing.bcc ?? []).length > 0);
        setSubject(composing.subject ?? "");
        const body = withSignature(
            composing,
            accounts.find((one) => one.id === account),
            identity
        );
        // Only an answer has history to trim, and a reopened draft only while
        // its quote is still nothing but the quote.
        const split = composing.inReplyToId
            ? trimComposerBody(body, Boolean(composing.draftId || kept))
            : null;
        setBody(split ? split.head : body);
        setTrimmed(split?.tail ?? "");
        setExpanded(false);
        setFiles(kept ? [...kept.files] : []);
        filesNow.current = kept ? [...kept.files] : [];
        setViewing(null);
        carriedIds.current = [];
        saves.current = draftSaves(
            {
                accountId: account,
                identityId: identity?.id ?? null,
                to: [...(composing.to ?? [])],
                cc: [...(composing.cc ?? [])],
                bcc: [...(composing.bcc ?? [])],
                subject: composing.subject ?? "",
                body,
                attachmentIds: kept ? kept.files.map((file) => file.id) : [],
                inReplyToId: composing.inReplyToId ?? null,
                forward: composing.forward ?? false
            },
            composing.draftId ?? null,
            draftWriter(draftKey.current),
            Boolean(kept)
        );
        setSendAt(null);
        setQueued(null);
        setProblem("");
        setPosture("docked");
        setOwnLine(!composing.draftId && !kept);
        // The caret goes to the message only when there is nobody left to name:
        // a reply arrives addressed, so writing is all that is left. A forward
        // and a new message arrive with an empty To, and taking the caret out of
        // it would be answering a question nobody asked first. Bumped rather
        // than set - the number means nothing to the editor beyond having
        // changed, and two replies in a row have to move the caret twice.
        if (composing.inReplyToId && (composing.to ?? []).length > 0) setFocusAt(Date.now());
    }, [composing, accounts, identities]);

    // A reopened reply or forward loads the message it answers, which is what
    // switching between Reply, Reply all and Forward rebuilds from. The draft
    // keeps that message by id; one that is gone, or cannot be opened, leaves
    // the draft as it was saved, without the switch.
    useEffect(() => {
        const messageId = composing?.inReplyToId;
        if (!composing?.draftId || !messageId || composing.answering) return;
        let current = true;
        const seed = composing;
        void readMessage(messageId).then(
            (opened) => {
                if (!current) return;
                const self = accounts.map((account) => account.address);
                const message = opened.envelope;
                const kind = draftAnswerKind(message, self, {
                    to: seed.to ?? [],
                    cc: seed.cc ?? [],
                    forward: seed.forward ?? false
                });
                setRestored({
                    seed,
                    context: { kind, message, self, quoted: opened.readable.text }
                });
            },
            () => undefined
        );
        return () => {
            current = false;
        };
        // The mailboxes refresh often; the message is held by the store, so
        // answering again costs no request.
    }, [composing, accounts]);

    // A reopened draft brings back the files already on it. Keyed on the seed
    // alone, for the reason the seeding above is.
    useEffect(() => {
        const draftId = composing?.draftId;
        // A kept draft brought its files with it, newer than the server's.
        if (!draftId || composing.kept) {
            setLoadingFiles(false);
            filesLoad.current = null;
            return;
        }
        let current = true;
        setLoadingFiles(true);
        filesLoad.current = (async () => {
            const outcome = await draftAttachmentsAction({ draftId }).catch(() => null);
            if (!current) return;
            if (outcome && "uploads" in outcome) {
                const held: Attached[] = outcome.uploads;
                filesNow.current = held;
                setFiles(held);
                saves.current?.carry(held.map((file) => file.id));
            }
            setLoadingFiles(false);
        })();
        return () => {
            current = false;
        };
    }, [composing]);

    /** Files being brought over from the message being forwarded, and the ones
     *  that could not be. */
    const [carrying, setCarrying] = useState(false);
    const [notCarried, setNotCarried] = useState<string[]>([]);

    // A forward brings the original's files with it. A draft reopened as a
    // forward already has whatever survived of them, so only a fresh forward -
    // or a reopened reply switched to one - asks.
    useEffect(() => {
        setNotCarried([]);
        if (!forwarding || !composing?.inReplyToId || (composing.draftId && composing.forward)) {
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
                carriedIds.current = carried.map((file) => file.id);
                setFiles((held) => [...held, ...carried]);
                saves.current?.carry(carried.map((file) => file.id));
                setNotCarried(outcome.skipped);
            }
        })();
        return () => {
            current = false;
        };
    }, [composing, forwarding]);

    const dirty =
        to.length > 0 || subject.trim() !== "" || message.trim() !== "" || files.length > 0;

    /** The draft as it stands, for a tab that closes before it is saved. */
    const standing = useRef<KeptDraft | null>(null);
    standing.current =
        composing && accountId && dirty && !queued
            ? {
                  accountId,
                  identityId: identityId || null,
                  to,
                  cc,
                  bcc,
                  subject,
                  body: message,
                  attachmentIds: files.map((file) => file.id),
                  inReplyToId: composing.inReplyToId ?? null,
                  forward: forwarding,
                  id: saves.current?.id() ?? null,
                  draftKey: draftKey.current,
                  files
              }
            : null;
    // What is not saved yet is kept on this device if the tab goes away first,
    // and saved to Drafts when Polaris answers.
    useEffect(() => {
        if (!composing) return;
        return keepOnUnload(() => {
            const draft = standing.current;
            return draft && saves.current?.pending(draft) ? draftWrite(draft) : null;
        });
    }, [composing]);

    // The draft, a few seconds after typing stops. Skipped while nothing has been
    // typed - an opened-and-closed composer should not leave an empty draft.
    useEffect(() => {
        if (!composing || !accountId || !dirty || queued || loadingFiles) return;
        const timer = setTimeout(() => {
            void saves.current?.save({
                accountId,
                identityId: identityId || null,
                to,
                cc,
                bcc,
                subject,
                body: message,
                attachmentIds: files.map((file) => file.id),
                inReplyToId: composing.inReplyToId ?? null,
                forward: forwarding
            });
        }, AUTOSAVE_MS);
        return () => clearTimeout(timer);
    }, [
        composing,
        accountId,
        identityId,
        to,
        cc,
        bcc,
        subject,
        message,
        files,
        dirty,
        queued,
        loadingFiles,
        forwarding
    ]);

    /** Put the history into the editor, where it can be read, edited or cut. */
    const showTrimmed = useCallback(() => {
        setBody(joinComposerBody(body, trimmed));
        setTrimmed("");
        setExpanded(true);
        // The blank line a reply opens on is already in the editor when the
        // writer typed on it; putting it back would push their words down.
        if (body.trim()) setOwnLine(false);
        // The pill is gone, and the focus with it: back to the message.
        setFocusAt(Date.now());
    }, [body, trimmed]);

    /**
     * Turn a reply into a reply to all, a forward, or back - the way Gmail's
     * switch does, keeping what was written.
     *
     * The recipients become the ones that button would have opened with. The
     * subject and the quote change only while they are still the ones the
     * composer opened with: a subject somebody rewrote, or a quote they opened
     * and edited, is theirs. A forward brings the message's files and a switch
     * away from one drops them again.
     */
    const switchAnswer = useCallback(
        (kind: AnswerKind) => {
            const context = answering;
            if (!composing || !context || !answerKind || kind === answerKind) return;
            const was = answerSeed(answerKind, context.message, context.self, context.quoted);
            const next = answerSeed(kind, context.message, context.self, context.quoted);
            setTo([...next.to]);
            setCc([...next.cc]);
            if (next.cc.length > 0) setShowCopies(true);
            if (subject.trim() === was.subject.trim()) setSubject(next.subject);
            if (trimmed && (kind === "forward" || answerKind === "forward")) {
                const split = trimComposerBody(next.body, false);
                if (split) setTrimmed(split.tail);
            }
            if (answerKind === "forward") {
                const dropped = new Set(carriedIds.current);
                carriedIds.current = [];
                setFiles((held) => held.filter((file) => !dropped.has(file.id)));
                setNotCarried([]);
                for (const id of dropped) {
                    void fetch(`/api/mail/uploads?id=${encodeURIComponent(id)}`, {
                        method: "DELETE"
                    });
                }
            }
            setSwitched({ seed: composing, kind });
        },
        [composing, answering, answerKind, subject, trimmed]
    );

    const attach = useCallback(
        async (chosen: readonly File[]) => {
            for (const file of chosen) {
                if (file.size > core.MAIL_MAX_ATTACHMENT_BYTES) {
                    toast.show({
                        title: t("compose.tooBig", { name: file.name })
                    });
                    continue;
                }
                const form = new FormData();
                form.set("file", file);
                // Through the shared sender, so a twenty-megabyte attachment has a
                // bar rather than a composer that looks stuck - see
                // `components/transfers`.
                const response = await sendFile("/api/mail/uploads", form, { name: file.name });
                const answer = parsed(response.body) as {
                    upload?: Attached;
                    error?: string;
                } | null;
                if (!response.ok || !answer?.upload) {
                    toast.show({ title: answer?.error ?? t("compose.attachFailed") });
                    continue;
                }
                const stored = answer.upload;
                setFiles((held) => [...held, stored]);
            }
        },
        [toast, t]
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
            // A field the rewrite left to fill goes out as "{{Recipient's
            // name}}" unless somebody fills it. Said once per body, with the
            // first one selected; sending again sends it anyway.
            const unfilled = fillInFields(body);
            if (unfilled.length > 0 && warnedFor.current !== body) {
                warnedFor.current = body;
                setProblem(t("compose.fillInFirst", { count: unfilled.length }));
                setReveal({ token: Date.now(), label: unfilled[0]! });
                return;
            }
            startSending(async () => {
                const fields: DraftFields = {
                    accountId,
                    identityId: identityId || null,
                    to,
                    cc,
                    bcc,
                    subject,
                    body: message,
                    attachmentIds: files.map((file) => file.id),
                    inReplyToId: composing?.inReplyToId ?? null,
                    forward: forwarding
                };
                const draftId = (await saves.current?.after((id) => Promise.resolve(id))) ?? null;
                saves.current?.hold();
                const outgoing = {
                    ...fields,
                    inReplyToId: composing?.inReplyToId ?? null,
                    forward: forwarding,
                    sendAt: when,
                    draftId
                };
                const outcome = await outbox.queueMessage(outgoing);
                // Polaris did not answer: kept on this device and sent when it
                // does, like a chat message. The composer closes as on any send.
                if (outbox.isRefused(outcome) && outcome.unreachable && (await keepSend(outgoing))) {
                    // The send has it now: a copy kept as a draft would be a
                    // second one.
                    draftSaved({ id: draftId, draftKey: draftKey.current });
                    rememberSender(shelf, accountId);
                    openComposer(null);
                    toast.show({ title: t("compose.keptOffline") });
                    return;
                }
                if (outbox.isRefused(outcome)) {
                    saves.current?.release();
                    setProblem(mailRefusalText(tm, outcome.error));
                    return;
                }
                saves.current?.adopt(outcome.draftId, fields);
                draftSaved({ id: outcome.draftId, draftKey: draftKey.current });
                setQueued({ draftId: outcome.draftId, until: new Date(outcome.sendAt).getTime() });
                // The mailbox somebody actually wrote from is the one the next
                // message starts on, wherever they write it from.
                rememberSender(shelf, accountId);
                refreshMailbox();
            });
        },
        [
            accountId,
            identityId,
            to,
            cc,
            bcc,
            subject,
            message,
            body,
            t,
            files,
            composing,
            forwarding,
            refreshMailbox,
            startSending,
            shelf,
            openComposer,
            toast
        ]
    );

    /** Take it back out of the queue, and put the composer back as it was. */
    const undo = useCallback(
        (draftId: string) => {
            void (async () => {
                const outcome = await outbox.undoSend(draftId);
                if (outbox.isRefused(outcome)) {
                    toast.show({ title: mailRefusalText(tm, outcome.error) });
                    return;
                }
                if (outcome.undone) {
                    setQueued(null);
                    saves.current?.release();
                    toast.show({ title: t("compose.undone") });
                    refreshMailbox();
                    return;
                }
                toast.show({ title: t("compose.gone") });
                openComposer(null);
            })();
        },
        [openComposer, refreshMailbox, toast, t]
    );

    /** Skip the rest of the wait. The composer closes at once: the message is
     *  the queue's now, and a failure reaches Drafts the way any send's does. */
    const sendRightAway = useCallback(
        (draftId: string) => {
            openComposer(null);
            void (async () => {
                const outcome = await outbox.sendNow(draftId);
                if (outbox.isRefused(outcome)) {
                    toast.show({ title: mailRefusalText(tm, outcome.error) });
                    return;
                }
                if (outcome.sent) toast.show({ title: t("compose.sendingNow") });
                refreshMailbox();
            })();
        },
        [openComposer, refreshMailbox, toast, t]
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
        void (async () => {
            // A draft closed before its files came back is saved with them, not
            // without them.
            await filesLoad.current;
            const fields: DraftFields = {
                accountId,
                identityId: identityId || null,
                to,
                cc,
                bcc,
                subject,
                body: message,
                attachmentIds: filesNow.current.map((file) => file.id),
                inReplyToId: composing?.inReplyToId ?? null,
                forward: forwarding
            };
            const id = (await saves.current?.save(fields)) ?? null;
            // Polaris did not take it: kept on this device and saved to Drafts
            // when it answers, rather than lost with the composer.
            if (saves.current?.pending(fields)) {
                const kept = await keepDraft({ ...fields, id, draftKey: draftKey.current, files: filesNow.current });
                toast.show({ title: t(kept ? "compose.draftKeptOffline" : "compose.draftNotKept") });
                return;
            }
            if (id) await fileDraftOnServerAction(id).catch(() => undefined);
            refreshMailbox();
        })();
    }, [
        toast,
        t,
        openComposer,
        queued,
        accountId,
        identityId,
        to,
        cc,
        bcc,
        subject,
        message,
        refreshMailbox,
        composing,
        forwarding
    ]);

    const account = accounts.find((one) => one.id === accountId);
    const own = useMemo(() => identities[accountId] ?? [], [identities, accountId]);
    const identity = own.find((one) => one.id === identityId);
    /** What this message would sign with, for the Insert button. */
    const signature = (identity?.signature || account?.signature || "").trim();

    // A message with nowhere to leave from is not a message: the shell sends a
    // Write with no mailbox to connecting one, and a mailbox removed while a
    // draft was open takes the composer with it.

    // Nothing is published while the composer takes the whole screen: there is no
    // room left to sit above, so the card floats over it instead. Called before
    // the return below, never after it: the composer is mounted with nothing
    // open, and a hook that only runs once a draft opens is a different number
    // of hooks between two renders - which React refuses by taking the whole
    // mail screen down the moment somebody presses Reply.
    useDockedCorner(
        shell,
        Boolean(composing) && accounts.length > 0 && posture !== "full" && !queued
    );

    if (!composing || accounts.length === 0) return null;

    const from = account
        ? core.formatAddress({
              name: identity?.displayName || account.displayName || viewerName,
              address: identity?.address || account.address
          })
        : "";

    // On a phone, writing takes the whole screen, as it does in Gmail's app: a
    // panel docked to the bottom there was half a screen with the keyboard
    // over the other half. Wherever it reaches the top of the window it starts
    // below the desktop app's window buttons, the full posture's 2.5rem margin
    // included.
    const shellClass = clearWindowControls(
        posture === "full"
            ? "inset-0 md:inset-10 md:top-[calc(2.5rem+var(--window-controls-height))] md:rounded-lg md:border-b max-md:rounded-none max-md:border-0 max-md:pb-[var(--safe-bottom)] max-md:pt-[var(--safe-top)]"
            : posture === "minimized"
              ? "bottom-0 end-[calc(1.5rem+var(--safe-end))] w-[22rem] pb-[var(--safe-bottom)] max-md:inset-x-2 max-md:end-auto max-md:w-auto"
              : // Taller and wider than it was. A composer whose body is three
                // lines is one people write three lines in, and the message
                // being written is the whole point of the screen it covers.
                "inset-0 mx-auto flex w-full max-w-3xl max-md:max-w-none max-md:rounded-none max-md:border-0 max-md:pb-[var(--safe-bottom)] max-md:pt-[var(--safe-top)] md:inset-x-auto md:bottom-0 md:top-auto md:end-6 md:mx-0 md:h-[38rem] md:max-h-[85vh] md:w-[40rem]"
    );

    return (
        <>
            {/* Above the seasonal drift (41) as well as the app bar (40): a
                composer is written in like a dialog, and nothing decorative
                drifts across one. Under the transfer card (50) still. */}
            <div
                className={cn(
                    "fixed z-[42] flex flex-col rounded-t-lg border border-b-0 border-border bg-elevated shadow-modal",
                    // Queued, the panel folds down into the corner the countdown
                    // appears in rather than standing there the same size to say
                    // one line. It stays mounted underneath: Undo unfolds the same
                    // message, recipients, cursor and all.
                    "origin-bottom transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none md:origin-bottom-right",
                    queued && "pointer-events-none translate-y-6 scale-[0.2] opacity-0",
                    shellClass
                )}
                ref={shell}
                role="dialog"
                aria-label={t("compose.title")}
                aria-hidden={queued ? true : undefined}
                inert={queued ? true : undefined}
            >
                <header className="flex items-center gap-1 border-b border-border px-3 py-2">
                    {answerKind && answering && posture !== "minimized" ? (
                        <AnswerSwitch kind={answerKind} onSwitch={switchAnswer} />
                    ) : null}
                    <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-start text-[13px] font-medium"
                        onClick={() => setPosture(posture === "minimized" ? "docked" : "minimized")}
                    >
                        {subject.trim() || t("compose.title")}
                    </button>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                            posture === "minimized" ? t("compose.open") : t("compose.minimize")
                        }
                        title={posture === "minimized" ? t("compose.open") : t("compose.minimize")}
                        onClick={() => setPosture(posture === "minimized" ? "docked" : "minimized")}
                    >
                        <Minus className="size-4 shrink-0" aria-hidden />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label={posture === "full" ? t("compose.shrink") : t("compose.expand")}
                        title={posture === "full" ? t("compose.shrink") : t("compose.expand")}
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
                        aria-label={t("compose.close")}
                        title={t("compose.close")}
                        onClick={close}
                    >
                        <X className="size-4 shrink-0" aria-hidden />
                    </Button>
                </header>

                {posture === "minimized" ? null : (
                    <>
                        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
                            <div className="space-y-1.5 border-b border-border px-4 py-3">
                                <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                    <span className="min-w-12 max-w-[40%] shrink-0 truncate" title={t("compose.from")}>
                                        {t("compose.from")}
                                    </span>
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
                                                    const owner = Object.keys(identities).find(
                                                        (account) =>
                                                            identities[account]?.some(
                                                                (alias) => alias.id === id
                                                            )
                                                    );
                                                    if (!owner || !id) return;
                                                    setAccountId(owner);
                                                    setIdentityId(id);
                                                    return;
                                                }
                                                setAccountId(id ?? "");
                                                setIdentityId("");
                                            }}
                                            aria-label={t("compose.fromLabel")}
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
                                                    label: t("compose.via", {
                                                        alias: alias.address,
                                                        address: one.address
                                                    })
                                                }))
                                            ])}
                                        />
                                    ) : (
                                        <span
                                            className="min-w-0 truncate text-foreground"
                                            title={from}
                                        >
                                            {from}
                                        </span>
                                    )}
                                </label>

                                <RecipientField
                                    label={t("compose.to")}
                                    value={to}
                                    onChange={setTo}
                                    // A reply arrives addressed: the caret belongs in the message,
                                    // and an autofocused To would take it back from the editor.
                                    autoFocus={
                                        !(composing?.inReplyToId && (composing.to ?? []).length > 0)
                                    }
                                />
                                {showCopies ? (
                                    <>
                                        <RecipientField
                                            label={t("compose.cc")}
                                            value={cc}
                                            onChange={setCc}
                                        />
                                        <RecipientField
                                            label={t("compose.bcc")}
                                            value={bcc}
                                            onChange={setBcc}
                                        />
                                    </>
                                ) : (
                                    <button
                                        type="button"
                                        className="ps-12 text-[12px] text-muted-foreground hover:text-foreground"
                                        onClick={() => setShowCopies(true)}
                                    >
                                        {t("compose.addCopies")}
                                    </button>
                                )}

                                <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                                    <span className="min-w-12 max-w-[40%] shrink-0 truncate" title={t("compose.subject")}>
                                        {t("compose.subject")}
                                    </span>
                                    <Input
                                        value={subject}
                                        onChange={(event) => setSubject(event.target.value)}
                                        aria-label={t("compose.subject")}
                                        className="h-8 min-w-0 flex-1 text-[13px]"
                                    />
                                </label>
                            </div>

                            {/* The body takes whatever is left, so the message is
                                the biggest thing in the composer rather than a strip
                                under the headers. */}
                            <div className="flex shrink-0 grow flex-col gap-2 px-2 py-2">
                                <AiRewriting
                                    active={rewriting}
                                    className="flex grow flex-col"
                                >
                                <RichTextEditor
                                    value={body}
                                    framed
                                    reveal={reveal}
                                    disabled={rewriting}
                                    onChange={(next) => setBody(keepSignatureDelimiter(next))}
                                    insert={insert}
                                    focusAt={focusAt}
                                    focusWhere={ownLine || expanded ? "start" : "end"}
                                    leadingBlankLine={ownLine}
                                    placeholder={t("compose.bodyPlaceholder")}
                                    className="flex min-h-[14rem] flex-1 flex-col"
                                    after={
                                        trimmed ? (
                                            <TrimmedPill
                                                className="ms-0.5 mt-1"
                                                label={tm("body.showTrimmed")}
                                                onToggle={showTrimmed}
                                            />
                                        ) : null
                                    }
                                    // A screenshot pasted in is an attachment rather
                                    // than a picture pasted into the text: a data URI
                                    // that size is refused by mail servers and shows
                                    // up as a broken image at the other end.
                                    onPasteFiles={(dropped) => {
                                        void attach([...dropped]);
                                        return true;
                                    }}
                                />
                                </AiRewriting>
                                <FillInBar
                                    text={body}
                                    onReveal={(label) => setReveal({ token: Date.now(), label })}
                                />
                            </div>

                            {carrying ? (
                                <p className="flex items-center gap-1.5 px-3 pb-2 text-[12px] text-foreground-subtle">
                                    <Loader2
                                        className="size-3.5 shrink-0 animate-spin"
                                        aria-hidden
                                    />
                                    {t("compose.carrying")}
                                </p>
                            ) : notCarried.length > 0 ? (
                                <p className="px-3 pb-2 text-[12px] text-foreground-subtle">
                                    {t("compose.notCarried", { names: notCarried.join(", ") })}
                                </p>
                            ) : null}

                            {files.length > 0 ? (
                                <ul className="flex max-h-32 shrink-0 flex-wrap gap-2 overflow-y-auto overscroll-contain border-t border-border px-3 py-2">
                                    {files.map((file) => (
                                        <li
                                            key={file.id}
                                            className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-[12px]"
                                        >
                                            <button
                                                type="button"
                                                className="flex min-w-0 items-center gap-2 text-muted-foreground hover:text-foreground"
                                                title={file.name}
                                                aria-label={t("compose.openAttachment", { name: file.name })}
                                                data-mail-upload={file.id}
                                                onClick={() =>
                                                    isViewable(file.name)
                                                        ? setViewing({
                                                              path: file.id,
                                                              name: file.name,
                                                              size: String(file.size)
                                                          })
                                                        : saveFile(uploadUrl(file.id), file.name)
                                                }
                                            >
                                                <Paperclip
                                                    className="size-3.5 shrink-0 text-foreground-subtle"
                                                    aria-hidden
                                                />
                                                <span className="min-w-0 max-w-[14rem] truncate">
                                                    {file.name}
                                                </span>
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={t("recipients.remove", {
                                                    address: file.name
                                                })}
                                                title={t("recipients.remove", {
                                                    address: file.name
                                                })}
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

                        {viewerWanted ? (
                            <FileViewer
                                target={viewing}
                                readOnly
                                urlFor={(target, inline) => uploadUrl(target.path, inline)}
                                onOpenChange={(open) => (open ? undefined : setViewing(null))}
                            />
                        ) : null}

                        <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-3 py-2">
                            <div className="flex items-stretch">
                                <Button
                                    className="rounded-e-none"
                                    onClick={() => send(sendAt)}
                                    disabled={sending || loadingFiles || to.length === 0 || !accountId}
                                >
                                    {sending ? (
                                        <Loader2
                                            className="size-4 shrink-0 animate-spin"
                                            aria-hidden
                                        />
                                    ) : (
                                        <Send className="size-4 shrink-0" aria-hidden />
                                    )}
                                    {sendAt ? t("compose.schedule") : t("compose.send")}
                                </Button>
                                <SendLaterMenu
                                    disabled={sending || loadingFiles || to.length === 0 || !accountId}
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
                                aria-label={t("compose.attach")}
                                title={t("compose.attach")}
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
                                    if (template.subject && !subject.trim())
                                        setSubject(template.subject);
                                }}
                            />

                            {canImprove ? (
                                // What the person wrote, never the signature or
                                // the quote under it.
                                <ImproveButton
                                    size="icon"
                                    purpose="email"
                                    subject={subject}
                                    orgId={
                                        accounts.find((account) => account.id === accountId)
                                            ?.orgId ?? null
                                    }
                                    onBusyChange={setRewriting}
                                    value={splitAtSignature(body).head}
                                    onChange={(next) => {
                                        // The blank lines before the signature
                                        // stay, so its delimiter still opens a
                                        // paragraph of its own.
                                        const { head, tail } = splitAtSignature(body);
                                        const gap = tail ? (/\s*$/.exec(head)?.[0] ?? "") : "";
                                        setBody(`${tail ? next.trimEnd() : next}${gap}${tail}`);
                                    }}
                                    disabled={sending}
                                />
                            ) : null}

                            {signature ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("compose.signature")}
                                    title={t("compose.signature")}
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
                        title={t("compose.attachTitle")}
                        onClose={() => setPicking(false)}
                        onPick={(picked) => void attachPicked(picked)}
                    />
                ) : null}
            </div>
            {queued ? (
                <QueuedPill
                    until={queued.until}
                    onUndo={() => undo(queued.draftId)}
                    onSendNow={() => sendRightAway(queued.draftId)}
                    onDone={() => openComposer(null)}
                />
            ) : null}
        </>
    );
}

/** The icon each way of answering is drawn with, here and on the buttons. */
const ANSWER_ICONS = { reply: Reply, "reply-all": ReplyAll, forward: Forward } as const;
const ANSWER_LABELS = { reply: "reply", "reply-all": "replyAll", forward: "forward" } as const;

/**
 * Reply, Reply all or Forward, from inside the composer.
 *
 * Gmail's arrow beside the recipients: pressing the wrong button is common, and
 * closing a half-written reply to press the other one is not an answer.
 */
function AnswerSwitch({
    kind,
    onSwitch
}: {
    kind: AnswerKind;
    onSwitch: (kind: AnswerKind) => void;
}) {
    const t = useTranslations("mailCompose");
    const Icon = ANSWER_ICONS[kind];
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-1.5"
                    aria-label={t("compose.answerKind.answerAs")}
                    title={t("compose.answerKind.answerAs")}
                >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <ChevronDown className="size-3.5 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {(["reply", "reply-all", "forward"] as const).map((option) => {
                    const OptionIcon = ANSWER_ICONS[option];
                    return (
                        <DropdownMenuItem
                            key={option}
                            className={cn(option === kind && "font-medium")}
                            onSelect={() => onSwitch(option)}
                        >
                            <OptionIcon className="size-4 shrink-0" aria-hidden />
                            <span className="min-w-0 flex-1 truncate">
                                {t(`compose.answerKind.${ANSWER_LABELS[option]}`)}
                            </span>
                            {option === kind ? (
                                <Check className="size-3.5 shrink-0" aria-hidden />
                            ) : null}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
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
    const t = useTranslations("mailCompose");
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
                    aria-label={t("compose.template")}
                    title={t("compose.template")}
                >
                    <FileText className="size-4 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-72">
                {templates === null ? (
                    <DropdownMenuItem disabled>
                        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
                        {t("compose.loadingTemplates")}
                    </DropdownMenuItem>
                ) : offered.length === 0 ? (
                    <DropdownMenuItem disabled>{t("compose.noTemplates")}</DropdownMenuItem>
                ) : (
                    offered.map((template) => (
                        <DropdownMenuItem key={template.id} onSelect={() => onPick(template)}>
                            <span className="truncate" title={template.name}>
                                {template.name}
                            </span>
                        </DropdownMenuItem>
                    ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/mail/settings/templates">{t("compose.manageTemplates")}</Link>
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
    const t = useTranslations("mailCompose");
    const tc = useTranslations("common");
    const [custom, setCustom] = useState("");
    const [asking, setAsking] = useState(false);

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="icon"
                        className="rounded-s-none border-s border-black/20"
                        disabled={disabled}
                        aria-label={t("compose.sendLater")}
                        title={t("compose.sendLater")}
                    >
                        <ChevronDown className="size-4 shrink-0" aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {SEND_TIMES.map((entry) => (
                        <DropdownMenuItem key={entry.id} onSelect={() => onChoose(entry.when())}>
                            <Clock className="size-3.5 shrink-0" aria-hidden />
                            {t(`compose.times.${entry.id}`)}
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        onSelect={() => {
                            setCustom("");
                            setAsking(true);
                        }}
                    >
                        {t("compose.pickTime")}
                    </DropdownMenuItem>
                    {chosen ? (
                        <DropdownMenuItem onSelect={() => onChoose(null)}>
                            {t("compose.sendNowInstead")}
                        </DropdownMenuItem>
                    ) : null}
                </DropdownMenuContent>
            </DropdownMenu>

            {asking ? (
                <Dialog open onOpenChange={(next) => (next ? undefined : setAsking(false))}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("compose.when")}</DialogTitle>
                        </DialogHeader>
                        <DateInput
                            mode="datetime"
                            value={custom}
                            aria-label={t("compose.timeLabel")}
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
                                {t("compose.scheduleIt")}
                            </Button>
                            <Button variant="ghost" onClick={() => setAsking(false)}>
                                {tc("actions.cancel")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}
        </>
    );
}

/** The times worth having on a menu. Anything else is the picker. */
const SEND_TIMES: readonly { id: "laterToday" | "tomorrow" | "monday"; when: () => Date }[] = [
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
        id: "monday",
        when: () => {
            const when = new Date();
            when.setDate(when.getDate() + ((8 - when.getDay()) % 7 || 7));
            when.setHours(8, 0, 0, 0);
            return when;
        }
    }
];

/**
 * The countdown after Send, as a pill in the corner the composer folded into.
 *
 * Small on purpose: the message is written, and the only things left to decide
 * are to take it back or to stop waiting. It closes itself when it reaches zero
 * rather than sitting there saying "sent", because a composer that stays open
 * after a message has gone is one somebody sends twice. A message scheduled for
 * next week says when instead of counting down to it.
 */
function QueuedPill({
    until,
    onUndo,
    onSendNow,
    onDone
}: {
    until: number;
    onUndo: () => void;
    onSendNow: () => void;
    onDone: () => void;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("mailCompose");
    const [left, setLeft] = useState(() => secondsUntil(until));
    // Anything further out than a minute is a scheduled message rather than a
    // send in progress, and counting down to Thursday would be absurd. Decided
    // once: a clock read on every render would flip it as the minute ran out.
    const [scheduled] = useState(() => until - Date.now() > 60_000);
    // Held in a ref so the countdown is not restarted by a parent re-render.
    const done = useRef(onDone);
    done.current = onDone;

    useEffect(() => {
        if (scheduled) return;
        const timer = setInterval(() => {
            const remaining = secondsUntil(until);
            setLeft(remaining);
            if (remaining === 0) done.current();
        }, 250);
        return () => clearInterval(timer);
    }, [until, scheduled]);

    const waiting = scheduled || left > 0;

    // The corner is this pill's while it is counting down, and what it holds -
    // Undo - stops existing when the countdown does. A card drawn over that is
    // worse than one drawn over a message somebody can still edit.
    const pill = useRef<HTMLDivElement | null>(null);
    useDockedCorner(pill, true);

    return (
        <div
            ref={pill}
            className={cn(
                "fixed start-[calc(1rem+var(--safe-start))] end-[calc(1rem+var(--safe-end))] bottom-[calc(1rem+var(--safe-bottom))] z-[42] flex items-center gap-1 rounded-full border border-border bg-elevated py-1 ps-4 pe-1 shadow-modal md:inset-x-auto md:end-[calc(1.5rem+var(--safe-end))]",
                "animate-in fade-in slide-in-from-bottom-2 zoom-in-95 duration-300 motion-reduce:animate-none"
            )}
        >
            {scheduled ? (
                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
                <Send className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <p
                className="min-w-0 flex-1 truncate px-1 text-[13px] tabular-nums md:flex-none"
                role="status"
                aria-live="polite"
            >
                {scheduled
                    ? t("compose.scheduledFor", { time: format.dateTime(new Date(until)) })
                    : left > 0
                      ? t("compose.sendingIn", { seconds: left })
                      : t("compose.sending")}
            </p>
            {waiting ? (
                <>
                    <Button size="sm" variant="ghost" className="rounded-full" onClick={onUndo}>
                        {scheduled ? t("compose.bringBack") : t("compose.undo")}
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        className="rounded-full"
                        onClick={onSendNow}
                    >
                        {t("compose.sendNow")}
                    </Button>
                </>
            ) : null}
            {scheduled ? (
                <Button
                    size="icon"
                    variant="ghost"
                    className="rounded-full"
                    aria-label={t("compose.closePill")}
                    title={t("compose.closePill")}
                    onClick={onDone}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            ) : null}
        </div>
    );
}

/** Whole seconds left until a moment, never below zero. */
function secondsUntil(until: number): number {
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}
