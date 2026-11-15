"use client";

/**
 * Ported from frontend/src/renderer/components/PRTabPane.tsx, PRComments.tsx,
 * PRCommentComposer.tsx and PRActions.tsx of Agent Orchestrator (Apache-2.0,
 * commit e4ded08c6f15): the layout and the reading order, not the code.
 *
 * A session's pull request tab: its checks, then its reviews, comments,
 * threads and commits oldest first, a reply on any comment, the merge, and -
 * when the session links none yet - linking one that already exists.
 *
 * The last answer read in this tab paints first and is read again behind it;
 * a reply shows at once and is taken back with its text restored if GitHub
 * refuses it.
 */

import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useDisplayFormat } from "@/components/display-format";
import type { SessionView } from "@/lib/agents/session-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type * as timelines from "@/lib/agents/session-pr-timeline";
import { COMMENT_MAX, replyQuote } from "@/lib/agents/pr-reply-quote";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton,
    Textarea
} from "@polaris/ui";
import {
    CheckCircle2,
    CircleDot,
    ExternalLink,
    GitCommitHorizontal,
    GitMerge,
    GitPullRequest,
    Link2,
    Loader2,
    MessageSquare,
    MinusCircle,
    RefreshCw,
    Reply,
    XCircle
} from "lucide-react";
import { SessionMergeDialog } from "./session-merge-dialog";
import {
    claimSessionPullAction,
    replySessionPullAction,
    sessionPullTabAction,
    type SessionPullTabView
} from "./actions";

const REFRESH_MS = 30_000;
const STORAGE_PREFIX = "polaris.session-pr.";

/** The last answer per session, for this tab's first paint. */
const memory = new Map<string, SessionPullTabView>();

function cachedView(sessionId: string): SessionPullTabView | null {
    const hit = memory.get(sessionId);
    if (hit) return hit;
    try {
        const raw = sessionStorage.getItem(STORAGE_PREFIX + sessionId);
        return raw ? (JSON.parse(raw) as SessionPullTabView) : null;
    } catch {
        return null;
    }
}

function rememberView(sessionId: string, view: SessionPullTabView | null) {
    if (view) memory.set(sessionId, view);
    else memory.delete(sessionId);
    try {
        if (view) sessionStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(view));
        else sessionStorage.removeItem(STORAGE_PREFIX + sessionId);
    } catch {
        // Storage full or blocked: the in-memory copy still serves this tab.
    }
}

/** A reply shown before GitHub has it. */
interface PendingReply {
    key: string;
    threadId: string | null;
    body: string;
}

export function SessionPullTab({ session }: { session: SessionView }) {
    const t = useTranslations("agents");
    const router = useRouter();
    const [claimed, setClaimed] = useState<number | null>(null);
    const number = claimed ?? session.pullRequest?.number ?? null;
    const [view, setView] = useState<SessionPullTabView | null>(() =>
        number === null ? null : cachedView(session.id)
    );
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [pending, setPending] = useState<PendingReply[]>([]);
    const [merging, setMerging] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(
        async (fresh: boolean) => {
            setRefreshing(true);
            const result = await runAction(() => sessionPullTabAction({ sessionId: session.id, fresh }), setError);
            setRefreshing(false);
            setLoaded(true);
            if (!result) return;
            if (result.error) {
                setError(result.error);
                return;
            }
            setError(null);
            if (result.view === undefined) return;
            setView(result.view);
            rememberView(session.id, result.view);
        },
        [session.id]
    );

    useEffect(() => {
        if (number === null) return;
        void load(false);
    }, [load, number]);

    const open = view?.timeline.state === "open";
    useEffect(() => {
        if (number === null || !open) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load(false);
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [load, number, open]);

    /** Posts a reply, shown at once. Null when it went through, else the
     *  sentence to show; the composer then gets its text back. */
    const send = async (body: string, threadId: string | null): Promise<string | null> => {
        const key = `${Date.now()}-${Math.random()}`;
        setPending((list) => [...list, { key, threadId, body }]);
        const result = await runAction(
            () => replySessionPullAction({ sessionId: session.id, body, ...(threadId ? { threadId } : {}) }),
            () => undefined
        );
        const failure = !result ? t("session.pr.errors.invalid") : (result.error ?? null);
        if (failure) {
            setPending((list) => list.filter((one) => one.key !== key));
            return failure;
        }
        await load(true);
        setPending((list) => list.filter((one) => one.key !== key));
        return null;
    };

    if (number === null) {
        return (
            <div className="flex flex-col gap-4 p-1">
                <EmptyState
                    icon={<GitPullRequest className="size-5" />}
                    title={t("session.checks.noPull")}
                    description={t("session.pr.claim.description")}
                />
                <div className="mx-auto w-full max-w-md">
                    <ClaimForm
                        sessionId={session.id}
                        onClaimed={(claimedNumber) => {
                            setClaimed(claimedNumber);
                            setNote(t("session.pr.claim.done", { number: claimedNumber }));
                            router.refresh();
                        }}
                    />
                </div>
            </div>
        );
    }

    if (!view) {
        return (
            <div className="flex flex-col gap-3 p-1">
                {error && loaded ? (
                    <ErrorLine message={error} onRetry={() => void load(true)} busy={refreshing} />
                ) : (
                    <>
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-40 w-full" />
                    </>
                )}
            </div>
        );
    }

    const { timeline } = view;
    const blockReason = view.mergeBlock ? t(`session.pr.mergeBlocks.${view.mergeBlock}`) : null;
    const stateLabel = timeline.draft && timeline.state === "open" ? "draft" : timeline.state;

    return (
        <div className="flex min-w-0 flex-col gap-4 p-1">
            <header className="flex min-w-0 flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant={timeline.state === "merged" ? "primary" : timeline.state === "open" ? "success" : "neutral"}>
                        {t(`session.pr.states.${stateLabel}`)}
                    </Badge>
                    <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={timeline.title}>
                        {timeline.title || `#${timeline.number}`}{" "}
                        <span className="font-normal text-muted-foreground">#{timeline.number}</span>
                    </h3>
                </div>
                <p
                    className="min-w-0 truncate text-xs text-muted-foreground"
                    title={t("session.pr.branches", { source: timeline.sourceBranch, target: timeline.targetBranch })}
                >
                    {t("session.pr.branches", { source: timeline.sourceBranch, target: timeline.targetBranch })}
                    {" - "}
                    {t(`session.pr.review.${timeline.review}`)}
                </p>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        onClick={() => setMerging(true)}
                        disabled={view.mergeBlock !== null}
                        title={blockReason ?? undefined}
                    >
                        <GitMerge className="size-4 shrink-0" />
                        {t("session.merge.open")}
                    </Button>
                    {timeline.url ? (
                        <Button size="sm" variant="ghost" asChild>
                            <a href={timeline.url} target="_blank" rel="noreferrer noopener">
                                <ExternalLink className="size-4 shrink-0" />
                                {t("session.pr.openOnGithub")}
                            </a>
                        </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => void load(true)} disabled={refreshing}>
                        <RefreshCw className={`size-4 shrink-0 ${refreshing ? "animate-spin" : ""}`} />
                        {t("session.pr.refresh")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setClaiming(true)}>
                        <Link2 className="size-4 shrink-0" />
                        {t("session.pr.claim.open")}
                    </Button>
                </div>
                {blockReason && view.mergeBlock !== "notOpen" ? (
                    <p className="text-xs text-muted-foreground">{blockReason}</p>
                ) : null}
                {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
                {error ? <ErrorLine message={error} onRetry={() => void load(true)} busy={refreshing} /> : null}
            </header>

            <ChecksSection checks={timeline.checks} />

            <section className="flex min-w-0 flex-col gap-2">
                <h4 className="text-sm font-semibold">{t("session.pr.activity")}</h4>
                {timeline.entries.length === 0 && pending.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("session.pr.empty")}</p>
                ) : (
                    <ol className="flex min-w-0 flex-col gap-2">
                        {timeline.entries.map((entry) => (
                            <li key={`${entry.kind}-${entry.id}`} className="min-w-0">
                                <Entry
                                    entry={entry}
                                    canReply={view.canReply}
                                    pending={pending.filter((one) => one.threadId === (entry.kind === "thread" ? entry.id : "-"))}
                                    send={send}
                                />
                            </li>
                        ))}
                        {pending
                            .filter((one) => one.threadId === null)
                            .map((one) => (
                                <li key={one.key} className="min-w-0">
                                    <PendingCard body={one.body} />
                                </li>
                            ))}
                    </ol>
                )}
                {view.canReply ? (
                    <Composer
                        placeholder={t("session.pr.commentPlaceholder")}
                        submitLabel={t("session.pr.comment")}
                        onSubmit={(body) => send(body, null)}
                    />
                ) : null}
            </section>

            {merging ? (
                <SessionMergeDialog
                    sessionId={session.id}
                    number={timeline.number}
                    sha={timeline.headSha || undefined}
                    description={
                        timeline.checks.failed > 0 || timeline.checks.pending > 0
                            ? t("session.merge.checksNotGreen")
                            : t("session.merge.description")
                    }
                    onClose={() => setMerging(false)}
                    onMerged={() => {
                        setMerging(false);
                        setNote(t("session.merge.done", { number: timeline.number }));
                        void load(true);
                        router.refresh();
                    }}
                />
            ) : null}
            {claiming ? (
                <Dialog open onOpenChange={(next) => !next && setClaiming(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("session.pr.claim.title")}</DialogTitle>
                            <DialogDescription>{t("session.pr.claim.description")}</DialogDescription>
                        </DialogHeader>
                        <ClaimForm
                            sessionId={session.id}
                            onClaimed={(claimedNumber) => {
                                setClaiming(false);
                                setClaimed(claimedNumber);
                                setView(null);
                                rememberView(session.id, null);
                                setNote(t("session.pr.claim.done", { number: claimedNumber }));
                                router.refresh();
                            }}
                        />
                    </DialogContent>
                </Dialog>
            ) : null}
        </div>
    );
}

function ErrorLine({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
    const t = useTranslations("agents");
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p role="alert" className="min-w-0 text-sm text-danger">
                {message}
            </p>
            <Button size="sm" variant="ghost" onClick={onRetry} disabled={busy}>
                <RefreshCw className={`size-4 shrink-0 ${busy ? "animate-spin" : ""}`} />
                {t("session.pr.refresh")}
            </Button>
        </div>
    );
}

function CheckIcon({ state }: { state: timelines.CheckState }) {
    if (state === "failed") return <XCircle className="size-4 shrink-0 text-danger" />;
    if (state === "pending") return <CircleDot className="size-4 shrink-0 text-warning" />;
    if (state === "passed") return <CheckCircle2 className="size-4 shrink-0 text-success" />;
    return <MinusCircle className="size-4 shrink-0 text-muted-foreground" />;
}

function ChecksSection({ checks }: { checks: timelines.PullTimeline["checks"] }) {
    const t = useTranslations("agents");
    const summary =
        checks.list.length === 0
            ? t("session.checks.none")
            : t("session.checks.tally", { passed: checks.passed, failed: checks.failed, pending: checks.pending });
    const state: timelines.CheckState =
        checks.failed > 0 ? "failed" : checks.pending > 0 ? "pending" : checks.passed > 0 ? "passed" : "unknown";
    return (
        <section className="flex min-w-0 flex-col gap-2">
            <h4 className="text-sm font-semibold">{t("session.pr.checksTitle")}</h4>
            <details className="group min-w-0 rounded-md bg-muted/40" open={checks.failed > 0}>
                <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                    <CheckIcon state={state} />
                    <span className="min-w-0 truncate" title={summary}>{summary}</span>
                </summary>
                {checks.list.length > 0 ? (
                    <ul className="max-h-72 space-y-0.5 overflow-y-auto overscroll-contain px-1 pb-2">
                        {checks.list.map((check, index) => (
                            <li key={`${check.name}-${index}`} className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm">
                                <CheckIcon state={check.state} />
                                {check.url ? (
                                    <a
                                        href={check.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="min-w-0 flex-1 truncate hover:underline"
                                        title={check.name}
                                    >
                                        {check.name}
                                    </a>
                                ) : (
                                    <span className="min-w-0 flex-1 truncate" title={check.name}>
                                        {check.name}
                                    </span>
                                )}
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t(`session.pr.checkStates.${check.state}`)}
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </details>
        </section>
    );
}

function Who({ author, at }: { author: timelines.TimelineAuthor; at: string }) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    return (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="min-w-0 truncate font-medium text-foreground" title={author.login}>
                {author.login}
            </span>
            {author.bot ? (
                <span className="shrink-0 rounded-sm border border-border px-1 text-[10px]">{t("session.pr.bot")}</span>
            ) : null}
            {at ? <span className="shrink-0">{format.dateTime(at)}</span> : null}
        </span>
    );
}

function Body({ text }: { text: string }) {
    return (
        <p className="line-clamp-[12] min-w-0 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{text}</p>
    );
}

function PendingCard({ body }: { body: string }) {
    const t = useTranslations("agents");
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 opacity-70" aria-busy="true">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3 shrink-0 animate-spin" />
                <span className="font-medium text-foreground">{t("session.pr.you")}</span>
                {t("session.pr.sending")}
            </span>
            <Body text={body} />
        </div>
    );
}

function Entry({
    entry,
    canReply,
    pending,
    send
}: {
    entry: timelines.TimelineEntry;
    canReply: boolean;
    pending: PendingReply[];
    send: (body: string, threadId: string | null) => Promise<string | null>;
}) {
    const t = useTranslations("agents");
    const format = useDisplayFormat();
    const [replying, setReplying] = useState(false);

    if (entry.kind === "commit") {
        return (
            <div className="flex min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
                <GitCommitHorizontal className="size-4 shrink-0" />
                {entry.url ? (
                    <a href={entry.url} target="_blank" rel="noreferrer noopener" className="shrink-0 font-mono hover:underline">
                        {entry.sha.slice(0, 7)}
                    </a>
                ) : (
                    <span className="shrink-0 font-mono">{entry.sha.slice(0, 7)}</span>
                )}
                <span className="min-w-0 flex-1 truncate text-foreground" title={entry.headline}>
                    {entry.headline}
                </span>
                {entry.author ? <span className="hidden max-w-32 shrink-0 truncate sm:inline">{entry.author}</span> : null}
                {entry.at ? <span className="hidden shrink-0 sm:inline">{format.dateTime(entry.at)}</span> : null}
            </div>
        );
    }

    if (entry.kind === "thread") {
        const first = entry.comments[0]!;
        const where = entry.line !== null ? t("session.pr.onLine", { path: entry.path, line: entry.line }) : entry.path;
        return (
            <div className={`flex min-w-0 flex-col gap-2 rounded-md px-3 py-2 ${entry.resolved ? "bg-muted/20" : "bg-muted/40"}`}>
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <MessageSquare className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate font-mono" title={where}>
                        {where}
                    </span>
                    {entry.resolved ? <Badge>{t("session.pr.resolved")}</Badge> : null}
                </div>
                {entry.comments.map((comment) => (
                    <div key={comment.id} className="flex min-w-0 flex-col gap-1">
                        <Who author={comment.author} at={comment.at} />
                        <Body text={comment.body} />
                    </div>
                ))}
                {entry.more > 0 && first.url ? (
                    <a href={first.url} target="_blank" rel="noreferrer noopener" className="text-xs text-muted-foreground hover:underline">
                        {t("session.pr.moreReplies", { count: entry.more })}
                    </a>
                ) : null}
                {pending.map((one) => (
                    <PendingCard key={one.key} body={one.body} />
                ))}
                {canReply ? (
                    replying ? (
                        <Composer
                            autoFocus
                            placeholder={t("session.pr.replyPlaceholder")}
                            submitLabel={t("session.pr.send")}
                            onCancel={() => setReplying(false)}
                            onSubmit={async (body) => {
                                const failure = await send(body, entry.id);
                                if (!failure) setReplying(false);
                                return failure;
                            }}
                        />
                    ) : (
                        <ReplyButton onClick={() => setReplying(true)} />
                    )
                ) : null}
            </div>
        );
    }

    const isReview = entry.kind === "review";
    return (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Who author={entry.author} at={entry.at} />
                <span className="text-xs text-muted-foreground">
                    {isReview ? t(`session.pr.reviewStates.${entry.state}`) : t("session.pr.commented")}
                </span>
                {entry.url ? (
                    <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ms-auto shrink-0 text-muted-foreground hover:text-foreground"
                        aria-label={t("session.pr.openOnGithub")}
                        title={t("session.pr.openOnGithub")}
                    >
                        <ExternalLink className="size-3.5" />
                    </a>
                ) : null}
            </div>
            {entry.body ? <Body text={entry.body} /> : null}
            {canReply ? (
                replying ? (
                    <Composer
                        autoFocus
                        initial={replyQuote(entry.author.login, entry.body)}
                        placeholder={t("session.pr.replyPlaceholder")}
                        submitLabel={t("session.pr.send")}
                        onCancel={() => setReplying(false)}
                        onSubmit={async (body) => {
                            const failure = await send(body, null);
                            if (!failure) setReplying(false);
                            return failure;
                        }}
                    />
                ) : (
                    <ReplyButton onClick={() => setReplying(true)} />
                )
            ) : null}
        </div>
    );
}

function ReplyButton({ onClick }: { onClick: () => void }) {
    const t = useTranslations("agents");
    return (
        <Button size="sm" variant="ghost" className="self-start" onClick={onClick}>
            <Reply className="size-4 shrink-0" />
            {t("session.pr.reply")}
        </Button>
    );
}

/** A comment box. Cleared the moment it is sent; given its text back when the
 *  send fails, with the reason under it. */
function Composer({
    initial = "",
    placeholder,
    submitLabel,
    autoFocus,
    onCancel,
    onSubmit
}: {
    initial?: string;
    placeholder: string;
    submitLabel: string;
    autoFocus?: boolean;
    onCancel?: () => void;
    onSubmit: (body: string) => Promise<string | null>;
}) {
    const tcommon = useTranslations("common");
    const [text, setText] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const ref = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!autoFocus || !ref.current) return;
        const box = ref.current;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }, [autoFocus]);

    const body = text.trim();
    const submit = () => {
        if (!body || busy) return;
        const sent = text;
        setText("");
        setError(null);
        startTransition(async () => {
            const failure = await onSubmit(body);
            if (failure) {
                setText(sent);
                setError(failure);
            }
        });
    };

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <Textarea
                ref={ref}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        submit();
                    }
                }}
                placeholder={placeholder}
                aria-label={placeholder}
                maxLength={COMMENT_MAX}
                rows={3}
                className="min-h-20"
            />
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
                {onCancel ? (
                    <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
                        {tcommon("actions.cancel")}
                    </Button>
                ) : null}
                <Button size="sm" onClick={submit} disabled={!body || busy} aria-disabled={!body || busy}>
                    {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                    {submitLabel}
                </Button>
            </div>
        </div>
    );
}

/** Links an existing pull request; offers to move it here when another live
 *  session has it. */
function ClaimForm({ sessionId, onClaimed }: { sessionId: string; onClaimed: (number: number) => void }) {
    const t = useTranslations("agents");
    const [ref, setRef] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [taken, setTaken] = useState(false);
    const [busy, startTransition] = useTransition();

    const claim = (takeover: boolean) =>
        startTransition(async () => {
            setError(null);
            const result = await runAction(
                () => claimSessionPullAction({ sessionId, ref: ref.trim(), takeover }),
                setError
            );
            if (!result) return;
            if (result.pull) {
                setTaken(false);
                onClaimed(result.pull.number);
                return;
            }
            setTaken(result.refusal === "taken");
            setError(result.error ?? t("session.pr.errors.invalid"));
        });

    const ready = ref.trim().length > 0;
    return (
        <form
            className="flex min-w-0 flex-col gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (ready && !busy) claim(false);
            }}
        >
            <label className="text-sm font-medium" htmlFor={`claim-${sessionId}`}>
                {t("session.pr.claim.label")}
            </label>
            <div className="flex min-w-0 flex-wrap gap-2">
                <Input
                    id={`claim-${sessionId}`}
                    value={ref}
                    onChange={(event) => {
                        setRef(event.target.value);
                        setTaken(false);
                        setError(null);
                    }}
                    placeholder={t("session.pr.claim.placeholder")}
                    maxLength={500}
                    className="min-w-0 flex-1 basis-48"
                />
                <Button type="submit" disabled={!ready || busy} aria-disabled={!ready || busy}>
                    {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Link2 className="size-4 shrink-0" />}
                    {busy ? t("session.pr.claim.linking") : t("session.pr.claim.submit")}
                </Button>
            </div>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            {taken ? (
                <Button type="button" variant="secondary" className="self-start" onClick={() => claim(true)} disabled={busy}>
                    {t("session.pr.claim.takeover")}
                </Button>
            ) : null}
        </form>
    );
}
