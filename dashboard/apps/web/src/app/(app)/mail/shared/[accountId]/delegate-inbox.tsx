"use client";

/**
 * A lent mailbox's inbox, its open message and what the delegate may do with
 * them (`lib/mailbox/delegate-act`). Every button is drawn at every level and
 * disabled with the reason where the level does not reach it, so a delegate
 * can see what asking the holder for more would give them. The server asks the
 * grant again on every call; what is hidden here is only what is pointless.
 *
 * Marks, stars and moves are optimistic, as everywhere else in Mail: the row
 * changes at once and comes back, with the reason, if the server refuses.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useBusy } from "../../use-busy";
import { useMemo, useState, type ReactNode } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Input, Textarea, cn, useToast } from "@polaris/ui";
import {
    Archive,
    Mail,
    MailOpen,
    Paperclip,
    Reply,
    ShieldAlert,
    SquarePen,
    Star,
    Trash2
} from "lucide-react";
import {
    delegateActAction,
    delegateCancelAction,
    delegateDiscardAction,
    delegateRetryAction,
    delegateSendAction
} from "./actions";

export type DelegateLevel = "view" | "respond" | "manage";

export interface DelegateRowView {
    readonly id: string;
    readonly subject: string;
    readonly from: string;
    readonly snippet: string;
    readonly sentAt: string;
    readonly hasAttachments: boolean;
    readonly seen: boolean;
    readonly flagged: boolean;
}

export interface DelegateMessageView extends DelegateRowView {
    readonly fromLine: string;
    readonly replyAddress: string;
    readonly to: string[];
    readonly cc: string[];
    readonly bodyText: string | null;
}

export interface DelegateDraftView {
    readonly id: string;
    readonly subject: string;
    readonly to: string[];
    readonly state: string;
    readonly failure: string;
    readonly permanent: boolean;
}

const LADDER: readonly DelegateLevel[] = ["view", "respond", "manage"];

function reaches(level: DelegateLevel, wanted: DelegateLevel): boolean {
    return LADDER.indexOf(level) >= LADDER.indexOf(wanted);
}

/** Recipients typed as one line, comma or semicolon separated. */
function recipients(line: string): { name: string; address: string }[] {
    return line
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((address) => ({ name: "", address }));
}

function replySubject(subject: string): string {
    return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** What the composer holds while it is open. */
interface Draft {
    readonly to: string;
    readonly cc: string;
    readonly subject: string;
    readonly body: string;
    readonly inReplyToId: string | null;
}

export function DelegateInbox({
    accountId,
    address,
    level,
    sendAs,
    base,
    keep,
    rows,
    open,
    olderHref,
    drafts
}: {
    accountId: string;
    address: string;
    level: DelegateLevel;
    sendAs: boolean;
    base: string;
    keep: string;
    rows: readonly DelegateRowView[];
    open: DelegateMessageView | null;
    olderHref: string | null;
    drafts: readonly DelegateDraftView[];
}) {
    const t = useTranslations("mail");
    const toast = useToast();
    const router = useRouter();
    const [busy, startBusy] = useBusy();
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    const [marks, setMarks] = useState<Record<string, { seen?: boolean; flagged?: boolean }>>({});
    const [draft, setDraft] = useState<Draft | null>(null);
    const [touched, setTouched] = useState(false);
    const mayRespond = reaches(level, "respond");
    const mayManage = reaches(level, "manage");

    const shown = rows
        .filter((row) => !hidden.has(row.id))
        .map((row) => ({ ...row, ...marks[row.id] }));
    const current = open && !hidden.has(open.id) ? { ...open, ...marks[open.id] } : null;

    /** One action, applied at once and put back if the server says no. */
    function act(id: string, action: core.MailDelegateAction) {
        const moves = action === "archive" || action === "junk" || action === "trash";
        const mark =
            action === "read" || action === "unread"
                ? { seen: action === "read" }
                : action === "star" || action === "unstar"
                  ? { flagged: action === "star" }
                  : null;
        const before = marks[id];
        if (moves) setHidden((held) => new Set(held).add(id));
        if (mark) setMarks((held) => ({ ...held, [id]: { ...held[id], ...mark } }));
        startBusy(async () => {
            const answer = await delegateActAction({ accountId, messageIds: [id], action });
            if ("error" in answer) {
                if (moves) {
                    setHidden((held) => {
                        const next = new Set(held);
                        next.delete(id);
                        return next;
                    });
                }
                if (mark) setMarks((held) => ({ ...held, [id]: before ?? {} }));
                toast.show({ title: answer.error ?? t("delegate.errors.failed") });
                return;
            }
            if (moves) router.replace(`${base}${keep ? `?${keep.slice(1)}` : ""}`);
        });
    }

    const parsed = useMemo(
        () =>
            draft
                ? core.mailDelegateComposeSchema.safeParse({
                      accountId,
                      to: recipients(draft.to),
                      cc: recipients(draft.cc),
                      subject: draft.subject,
                      body: draft.body,
                      inReplyToId: draft.inReplyToId
                  })
                : null,
        [accountId, draft]
    );
    const problem = (field: string) =>
        touched && parsed && !parsed.success
            ? parsed.error.issues.find((issue) => issue.path[0] === field)
            : undefined;

    function send() {
        setTouched(true);
        if (!parsed?.success) return;
        startBusy(async () => {
            const answer = await delegateSendAction(parsed.data);
            const draftId = "draftId" in answer ? answer.draftId : undefined;
            if (!draftId) {
                toast.show({
                    title: ("error" in answer && answer.error) || t("delegate.errors.failed")
                });
                return;
            }
            setDraft(null);
            setTouched(false);
            toast.show({
                title: t("delegate.queued"),
                actions: [
                    {
                        label: t("delegate.undo"),
                        run: async () => {
                            const undone = await delegateCancelAction({
                                accountId,
                                draftId
                            });
                            router.refresh();
                            return "error" in undone
                                ? undone.error
                                : undone.undone
                                  ? null
                                  : t("delegate.tooLate");
                        }
                    }
                ]
            });
            router.refresh();
        });
    }

    function onDraft(run: () => Promise<{ error: string } | object>) {
        startBusy(async () => {
            const answer = await run();
            if ("error" in answer) toast.show({ title: answer.error });
            router.refresh();
        });
    }

    const needRespond = t("delegate.needsRespond");
    const needManage = t("delegate.needsManage");
    const tool = (
        label: string,
        icon: ReactNode,
        allowed: boolean,
        why: string,
        run: () => void
    ) => (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={allowed ? label : `${label} - ${why}`}
            disabled={!allowed || busy}
            onClick={run}
        >
            {icon}
        </Button>
    );

    return (
        <>
            <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {t(`delegate.levelNote.${level}`)}
                </p>
                <Button
                    size="sm"
                    variant="outline"
                    disabled={!mayRespond || busy}
                    title={mayRespond ? undefined : needRespond}
                    onClick={() => {
                        setTouched(false);
                        setDraft({ to: "", cc: "", subject: "", body: "", inReplyToId: null });
                    }}
                >
                    <SquarePen className="size-4 shrink-0" aria-hidden />
                    {t("delegate.write")}
                </Button>
            </div>

            {drafts.length > 0 ? (
                <section
                    aria-label={t("delegate.unsent")}
                    className="mb-4 rounded-md border border-border"
                >
                    <h2 className="border-b border-border px-3 py-2 text-xs font-medium">
                        {t("delegate.unsent")}
                    </h2>
                    <ul className="divide-y divide-border">
                        {drafts.map((one) => (
                            <li key={one.id} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm" title={one.subject}>
                                        {one.subject || t("delegate.noSubject")}
                                    </span>
                                    <span
                                        className="block truncate text-xs text-muted-foreground"
                                        title={one.to.join(", ")}
                                    >
                                        {one.to.join(", ")}
                                    </span>
                                    {one.failure ? (
                                        <span className="block break-words text-xs text-destructive">
                                            {one.failure}
                                        </span>
                                    ) : null}
                                </span>
                                <Badge variant={one.state === "failed" ? "warning" : "neutral"}>
                                    {t(
                                        `delegate.state.${one.state === "queued" || one.state === "sending" || one.state === "failed" ? one.state : "draft"}`
                                    )}
                                </Badge>
                                {one.state === "queued" ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() =>
                                            onDraft(() =>
                                                delegateCancelAction({ accountId, draftId: one.id })
                                            )
                                        }
                                    >
                                        {t("delegate.undo")}
                                    </Button>
                                ) : null}
                                {one.state === "failed" && !one.permanent ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={!mayRespond || busy}
                                        title={mayRespond ? undefined : needRespond}
                                        onClick={() =>
                                            onDraft(() =>
                                                delegateRetryAction({ accountId, draftId: one.id })
                                            )
                                        }
                                    >
                                        {t("delegate.retry")}
                                    </Button>
                                ) : null}
                                {one.state !== "sending" ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={busy}
                                        onClick={() =>
                                            onDraft(() =>
                                                delegateDiscardAction({ accountId, draftId: one.id })
                                            )
                                        }
                                    >
                                        {t("delegate.discard")}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {draft ? (
                <form
                    aria-label={t("delegate.compose")}
                    className="mb-4 grid min-w-0 gap-2 rounded-md border border-border p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        send();
                    }}
                >
                    <p className="text-xs text-muted-foreground">
                        {sendAs
                            ? t("delegate.fromAs", { address })
                            : t("delegate.fromOnBehalf", { address })}
                    </p>
                    <label className="grid gap-1 text-xs">
                        <span>
                            {t("delegate.to")} <span aria-hidden>*</span>
                        </span>
                        <Input
                            value={draft.to}
                            aria-invalid={Boolean(problem("to"))}
                            placeholder={t("delegate.toPlaceholder")}
                            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                            onBlur={() => setTouched(true)}
                        />
                        {problem("to") ? (
                            <span className="text-destructive">{t("delegate.errors.to")}</span>
                        ) : null}
                    </label>
                    <label className="grid gap-1 text-xs">
                        <span>{t("delegate.cc")}</span>
                        <Input
                            value={draft.cc}
                            aria-invalid={Boolean(problem("cc"))}
                            onChange={(event) => setDraft({ ...draft, cc: event.target.value })}
                        />
                        {problem("cc") ? (
                            <span className="text-destructive">{t("delegate.errors.to")}</span>
                        ) : null}
                    </label>
                    <label className="grid gap-1 text-xs">
                        <span>{t("delegate.subject")}</span>
                        <Input
                            value={draft.subject}
                            maxLength={500}
                            onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
                        />
                    </label>
                    <Textarea
                        value={draft.body}
                        rows={8}
                        aria-label={t("delegate.body")}
                        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                    />
                    <div className="flex flex-wrap justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                            {t("delegate.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={busy}
                            aria-disabled={Boolean(parsed && !parsed.success)}
                        >
                            {t("delegate.send")}
                        </Button>
                    </div>
                </form>
            ) : null}

            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <section aria-label={t("delegate.inbox")} className="min-w-0">
                    {shown.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("delegate.empty")}</p>
                    ) : (
                        <ul className="divide-y divide-border rounded-md border border-border">
                            {shown.map((row) => (
                                <li key={row.id}>
                                    <Link
                                        href={`${base}?m=${row.id}${keep}`}
                                        aria-current={current?.id === row.id ? "true" : undefined}
                                        className={cn(
                                            "block min-w-0 px-3 py-2 hover:bg-muted/50",
                                            current?.id === row.id && "bg-muted"
                                        )}
                                    >
                                        <span className="flex min-w-0 items-baseline gap-2">
                                            <span
                                                className={cn(
                                                    "min-w-0 flex-1 truncate text-sm",
                                                    row.seen ? "font-normal" : "font-semibold"
                                                )}
                                            >
                                                {row.from || t("delegate.unknownSender")}
                                            </span>
                                            {row.flagged ? (
                                                <Star
                                                    className="size-3.5 shrink-0 fill-current text-amber-500"
                                                    aria-label={t("delegate.starred")}
                                                />
                                            ) : null}
                                            {row.hasAttachments ? (
                                                <Paperclip
                                                    className="size-3.5 shrink-0 text-muted-foreground"
                                                    aria-label={t("delegate.attachments")}
                                                />
                                            ) : null}
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                <RelativeTime iso={row.sentAt} />
                                            </span>
                                        </span>
                                        <span className="block truncate text-sm">
                                            {row.subject || t("delegate.noSubject")}
                                        </span>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {row.snippet}
                                        </span>
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                    {olderHref ? (
                        <Link
                            href={olderHref}
                            className="mt-3 inline-block text-sm text-muted-foreground hover:text-foreground"
                        >
                            {t("delegate.older")}
                        </Link>
                    ) : null}
                </section>

                <section aria-label={t("delegate.message")} className="min-w-0">
                    {current ? (
                        <article className="min-w-0 rounded-md border border-border p-4">
                            <div
                                role="toolbar"
                                aria-label={t("delegate.actions")}
                                className="mb-2 flex flex-wrap items-center gap-1"
                            >
                                {tool(
                                    t("delegate.reply"),
                                    <Reply className="size-4 shrink-0" aria-hidden />,
                                    mayRespond && Boolean(current.replyAddress),
                                    needRespond,
                                    () => {
                                        setTouched(false);
                                        setDraft({
                                            to: current.replyAddress,
                                            cc: "",
                                            subject: replySubject(current.subject),
                                            body: "",
                                            inReplyToId: current.id
                                        });
                                    }
                                )}
                                {tool(
                                    current.seen ? t("delegate.markUnread") : t("delegate.markRead"),
                                    current.seen ? (
                                        <Mail className="size-4 shrink-0" aria-hidden />
                                    ) : (
                                        <MailOpen className="size-4 shrink-0" aria-hidden />
                                    ),
                                    mayManage,
                                    needManage,
                                    () => act(current.id, current.seen ? "unread" : "read")
                                )}
                                {tool(
                                    current.flagged ? t("delegate.unstar") : t("delegate.star"),
                                    <Star
                                        className={cn(
                                            "size-4 shrink-0",
                                            current.flagged && "fill-current text-amber-500"
                                        )}
                                        aria-hidden
                                    />,
                                    mayManage,
                                    needManage,
                                    () => act(current.id, current.flagged ? "unstar" : "star")
                                )}
                                {tool(
                                    t("delegate.archive"),
                                    <Archive className="size-4 shrink-0" aria-hidden />,
                                    mayManage,
                                    needManage,
                                    () => act(current.id, "archive")
                                )}
                                {tool(
                                    t("delegate.junk"),
                                    <ShieldAlert className="size-4 shrink-0" aria-hidden />,
                                    mayManage,
                                    needManage,
                                    () => act(current.id, "junk")
                                )}
                                {tool(
                                    t("delegate.trash"),
                                    <Trash2 className="size-4 shrink-0" aria-hidden />,
                                    mayManage,
                                    needManage,
                                    () => act(current.id, "trash")
                                )}
                            </div>
                            <h2 className="mb-2 break-words text-base font-semibold">
                                {current.subject || t("delegate.noSubject")}
                            </h2>
                            <dl className="mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                                <dt className="text-muted-foreground">{t("delegate.from")}</dt>
                                <dd className="break-words">{current.fromLine}</dd>
                                <dt className="text-muted-foreground">{t("delegate.to")}</dt>
                                <dd className="break-words">{current.to.join(", ")}</dd>
                                {current.cc.length > 0 ? (
                                    <>
                                        <dt className="text-muted-foreground">
                                            {t("delegate.cc")}
                                        </dt>
                                        <dd className="break-words">{current.cc.join(", ")}</dd>
                                    </>
                                ) : null}
                                <dt className="text-muted-foreground">{t("delegate.date")}</dt>
                                <dd>
                                    <RelativeTime iso={current.sentAt} />
                                </dd>
                            </dl>
                            <div className="whitespace-pre-wrap break-words text-sm">
                                {current.bodyText ?? current.snippet}
                            </div>
                            {current.bodyText === null ? (
                                <p className="mt-3 text-xs text-muted-foreground">
                                    {t("delegate.bodyPending")}
                                </p>
                            ) : null}
                        </article>
                    ) : (
                        <p className="text-sm text-muted-foreground">{t("delegate.pick")}</p>
                    )}
                </section>
            </div>
        </>
    );
}
