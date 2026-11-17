"use client";

/**
 * What the session changed, and the pull request that ships it.
 *
 * The file list and each diff are read from the session's own checkout, so they
 * show what the agent has right now, committed or not. The list refreshes while
 * the agent works; a diff is read when somebody opens its file, never all of them
 * up front - a session that touched two hundred files is two hundred reads.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { CopyButton } from "@/components/copy-button";
import { CodeSurface } from "@/components/code-surface";
import type { SessionView } from "@/lib/agents/session-service";
import { TOUCH_TARGET } from "@/components/use-phone";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useConfirm } from "@/components/confirm-dialog";
import { splitHunks, type ChangedFile, type FileDiff } from "@/lib/agents/session-changes";
import type { ChangesAnswer, DiffAnswer } from "@/lib/agents/session-review";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    Check,
    ExternalLink,
    FileDiff as FileDiffIcon,
    GitPullRequest,
    Loader2,
    MessageSquare,
    RefreshCw,
    Send,
    Undo2
} from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Skeleton,
    Textarea,
    cn
} from "@polaris/ui";
import {
    openSessionPullRequestAction,
    revertSessionChangeAction,
    sendDiffSelectionAction,
    sendReviewCommentsAction,
    sessionFileDiffAction,
    sessionShipAction,
    type SessionShipView
} from "./actions";
import * as polls from "./sessions-polls";
import { DiffReview, commentKey } from "./diff-review";
import type { DiffSelection, LineComment } from "@/lib/agents/session-review-loop";

/** How often the list is read again while the agent is still working. */
const REFRESH_MS = 15_000;
/** The same, when the caller says each time the agent writes: only a fallback
 *  for a notice that never came. */
const FOLLOWED_REFRESH_MS = 60_000;
/** How long a burst of writes is gathered into one read. */
const WAKE_SETTLE_MS = 500;

/** The files whose counts moved between two reads, or that are new in the
 *  second. */
export function movedFiles(before: readonly ChangedFile[] | null, after: readonly ChangedFile[]): Set<string> {
    if (!before) return new Set();
    const was = new Map(before.map((file) => [file.path, `${file.added}:${file.removed}`]));
    return new Set(
        after.filter((file) => was.get(file.path) !== `${file.added}:${file.removed}`).map((file) => file.path)
    );
}

/** A file's counts, which an acceptance is held against: a file the agent
 *  changes again after it was accepted is shown as changed again. */
const countsOf = (file: ChangedFile) => `${file.added}:${file.removed}`;

/** What accepting and reverting need from the list, for the open file. */
interface FileActions {
    accepted: boolean;
    toggleFile: () => void;
    revertFile: () => void;
    acceptedHunks: ReadonlySet<string>;
    toggleHunk: (id: string) => void;
    revertHunk: (index: number, id: string) => void;
    busy: boolean;
}

interface ReadDiff {
    generation: number;
    diff: FileDiff | "unreachable";
}

interface Listing {
    total: number;
    files: ChangedFile[];
    next: number | null;
}

export function SessionChanges({
    session,
    wake
}: {
    session: SessionView;
    /** Moves each time the agent finishes a write, when the caller is told
     *  (the session's live stream): the list and the open diff are read again
     *  then, rather than on a timer. */
    wake?: string | null;
}) {
    const t = useTranslations("agents");
    const [listing, setListing] = useState<Listing | null>(null);
    // The files the agent changed in the last read, marked until the next.
    const [moved, setMoved] = useState<ReadonlySet<string>>(() => new Set());
    const followed = wake !== undefined;
    const [problem, setProblem] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [more, setMore] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [diffs, setDiffs] = useState<Record<string, ReadDiff>>({});
    const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
    // Bumped on every list read: a diff read before it is shown until the one
    // read after it arrives, rather than blanking the pane.
    const [generation, setGeneration] = useState(0);
    const over = core.isSessionOver(session.state);
    const [comments, setComments] = useState<LineComment[]>([]);
    const [reviewing, setReviewing] = useState(false);
    const [sending, startSending] = useTransition();
    const [reviewNote, setReviewNote] = useState<{ tone: "ok" | "error"; text: string } | null>(
        null
    );
    // Files and hunks somebody accepted: kept in the checkout, marked, and
    // folded out of the way. A file is held to the counts it was accepted at.
    const [acceptedFiles, setAcceptedFiles] = useState<ReadonlyMap<string, string>>(() => new Map());
    const [acceptedHunks, setAcceptedHunks] = useState<ReadonlySet<string>>(() => new Set());
    const [reverting, setReverting] = useState(false);
    const [confirm, confirmElement] = useConfirm();
    const reads = useRef(0);
    // The list as it was last read, to tell what the agent just changed.
    const last = useRef<ChangedFile[] | null>(null);
    const shown = useRef(0);

    /** The words for an answer that is not a list. */
    const wordsFor = useCallback(
        (
            answer:
                Exclude<ChangesAnswer, { kind: "listing" }> | Exclude<DiffAnswer, { kind: "diff" }>
        ) =>
            answer.kind === "unavailable"
                ? t(`session.changes.unavailable.${answer.reason}`, { branch: session.branch })
                : t("session.changes.unreachable"),
        [session.branch, t]
    );

    const load = useCallback(async () => {
        const read = ++reads.current;
        const result = await runAction(
            () => polls.sessionChanges({ sessionId: session.id, offset: 0 }),
            setProblem
        );
        // A slower answer to an older read must not paint over a newer one.
        if (read !== reads.current) return;
        setLoading(false);
        if (!result) return;
        if (result.error || !result.answer) {
            setProblem(result.error ?? t("session.changes.unreachable"));
            return;
        }
        const answer = result.answer;
        if (answer.kind !== "listing") {
            setProblem(wordsFor(answer));
            return;
        }
        if (answer.listing.kind !== "ok") {
            setProblem(t(`session.changes.${answer.listing.kind}`));
            return;
        }
        let { total, next } = answer.listing;
        const files = [...answer.listing.files];
        // The pages somebody already opened stay open.
        while (next && files.length < shown.current) {
            const page = await polls
                .sessionChanges({ sessionId: session.id, offset: next })
                .catch(() => null);
            if (read !== reads.current) return;
            if (page?.answer?.kind !== "listing" || page.answer.listing.kind !== "ok") break;
            files.push(...page.answer.listing.files);
            total = page.answer.listing.total;
            next = page.answer.listing.next;
        }
        setProblem(null);
        shown.current = files.length;
        const changed = movedFiles(last.current, files);
        last.current = files;
        setMoved(changed);
        // Following the agent: with nothing open, its newest change opens.
        if (followed && changed.size > 0)
            setSelected((current) => current ?? files.find((file) => changed.has(file.path))?.path ?? null);
        setListing({ total, files, next });
        setGeneration(read);
    }, [followed, session.id, t, wordsFor]);
    // The newest read, for the timers: a parent drawn again (each time the
    // thread is read) must not read the list again by itself.
    const latestLoad = useRef(load);
    latestLoad.current = load;

    useEffect(() => {
        void latestLoad.current();
        if (over) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void latestLoad.current();
        }, followed ? FOLLOWED_REFRESH_MS : REFRESH_MS);
        return () => clearInterval(timer);
    }, [followed, over, session.id]);

    // Each write the agent finishes: the list again, and with it the open
    // diff. The write already on screen when this opened is not one.
    const seenWake = useRef(wake);
    useEffect(() => {
        if (!followed || wake === seenWake.current) return;
        const timer = setTimeout(() => {
            seenWake.current = wake;
            void latestLoad.current();
        }, WAKE_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [followed, wake]);

    const loadMore = async () => {
        if (!listing?.next) return;
        const read = reads.current;
        setMore(true);
        const result = await runAction(
            () => polls.sessionChanges({ sessionId: session.id, offset: listing.next }),
            setProblem
        );
        setMore(false);
        if (read !== reads.current) return;
        const answer = result?.answer;
        if (answer?.kind === "listing" && answer.listing.kind === "ok") {
            const page = answer.listing;
            setListing((current) => {
                if (!current) return current;
                const files = [...current.files, ...page.files];
                shown.current = files.length;
                return { total: page.total, files, next: page.next };
            });
        }
    };

    const open = useCallback(
        async (path: string) => {
            const at = generation;
            setSelected(path);
            setPending((current) => new Set(current).add(path));
            const result = await runAction(
                () => sessionFileDiffAction({ sessionId: session.id, path }),
                setProblem
            );
            setPending((current) => {
                const rest = new Set(current);
                rest.delete(path);
                return rest;
            });
            const answer = result?.answer;
            setDiffs((current) => ({
                ...current,
                [path]: {
                    generation: at,
                    diff: answer?.kind === "diff" ? answer.diff : "unreachable"
                }
            }));
        },
        [generation, session.id]
    );

    // The open file is read again after a refresh, its last diff on screen
    // until the new one is in.
    useEffect(() => {
        if (!selected || pending.has(selected) || !listing) return;
        if (diffs[selected]?.generation !== generation) void open(selected);
    }, [diffs, generation, listing, open, pending, selected]);

    const refresh = () => {
        setLoading(true);
        void load();
    };

    const isAccepted = (file: ChangedFile) => acceptedFiles.get(file.path) === countsOf(file);
    const toggleFile = (file: ChangedFile) =>
        setAcceptedFiles((current) => {
            const next = new Map(current);
            if (next.get(file.path) === countsOf(file)) next.delete(file.path);
            else next.set(file.path, countsOf(file));
            return next;
        });
    const toggleHunk = (path: string, id: string) =>
        setAcceptedHunks((current) => {
            const next = new Set(current);
            const key = `${path}\n${id}`;
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });

    /** Put a file, or one hunk of it, back as the branch started - after asking,
     *  because what the agent wrote there is gone once it is done. */
    const revert = async (path: string, hunk?: { index: number; id: string }) => {
        if (reverting) return;
        const ok = await confirm({
            title: hunk ? t("session.changes.revertHunkTitle") : t("session.changes.revertFileTitle", { path }),
            description: hunk
                ? t("session.changes.revertHunkDescription", { path })
                : t("session.changes.revertFileDescription"),
            confirmLabel: t("session.changes.revert"),
            danger: true
        });
        if (!ok) return;
        setReverting(true);
        const result = await runAction(
            () => revertSessionChangeAction({ sessionId: session.id, path, hunk }),
            setProblem
        );
        setReverting(false);
        if (!result) return;
        const answer = result.answer;
        if (result.error || !answer) return setProblem(result.error ?? t("session.changes.unreachable"));
        if (answer.kind === "unavailable")
            return setProblem(
                answer.reason === "over"
                    ? t("session.changes.revertOver")
                    : t(`session.changes.unavailable.${answer.reason}`, { branch: session.branch })
            );
        if (answer.kind === "unreachable") return setProblem(t("session.changes.unreachable"));
        setProblem(
            answer.result === "reverted" || answer.result === "gone"
                ? null
                : answer.result === "stale"
                  ? t("session.changes.revertStale")
                  : answer.result === "large"
                    ? t("session.changes.revertLarge")
                    : t("session.changes.revertFailed")
        );
        await load();
    };

    const addComment = (comment: LineComment) => {
        setReviewNote(null);
        setComments((list) => [
            ...list.filter((row) => commentKey(row) !== commentKey(comment)),
            comment
        ]);
    };
    const removeComment = (key: string) =>
        setComments((list) => list.filter((row) => commentKey(row) !== key));
    const sendReview = () =>
        startSending(async () => {
            const sent = comments;
            const result = await runAction(
                () => sendReviewCommentsAction({ sessionId: session.id, comments: sent }),
                (text) => setReviewNote({ tone: "error", text })
            );
            if (!result) return;
            if (result.error) {
                setReviewNote({ tone: "error", text: result.error });
                return;
            }
            setComments((list) => list.filter((row) => !sent.includes(row)));
            setReviewNote({ tone: "ok", text: t("session.review.sent") });
        });
    const sendSelection = async (selection: DiffSelection, note: string): Promise<boolean> => {
        const result = await runAction(
            () => sendDiffSelectionAction({ sessionId: session.id, selection, note }),
            (text) => setReviewNote({ tone: "error", text })
        );
        if (!result) return false;
        if (result.error) {
            setReviewNote({ tone: "error", text: result.error });
            return false;
        }
        setReviewNote({ tone: "ok", text: t("session.selection.sent") });
        return true;
    };
    const commentFiles = new Set(comments.map((row) => row.path)).size;

    return (
        <Card>
            <CardBody className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                    <FileDiffIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {listing
                            ? t("session.changes.summary", { count: listing.total })
                            : t("session.views.changes")}
                    </span>
                    <Button size="sm" className={TOUCH_TARGET} variant="ghost" onClick={refresh} disabled={loading}>
                        <RefreshCw className={cn("size-4 shrink-0", loading && "animate-spin")} />
                        {t("session.changes.refresh")}
                    </Button>
                </div>

                {comments.length > 0 || reviewNote ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2">
                        <span
                            className={cn(
                                "min-w-0 flex-1 text-sm",
                                comments.length === 0 && reviewNote?.tone === "error" && "text-danger"
                            )}
                        >
                            {comments.length > 0
                                ? t("session.review.waiting", {
                                      count: comments.length,
                                      files: commentFiles
                                  })
                                : reviewNote?.text}
                        </span>
                        {comments.length > 0 ? (
                            <>
                                <Button
                                    size="sm"
                                    className={TOUCH_TARGET}
                                    variant="ghost"
                                    onClick={() => setComments([])}
                                    disabled={sending}
                                >
                                    {t("session.review.discard")}
                                </Button>
                                <Button size="sm" className={TOUCH_TARGET} onClick={sendReview} disabled={sending || over}>
                                    {sending ? (
                                        <Loader2 className="size-4 shrink-0 animate-spin" />
                                    ) : (
                                        <Send className="size-4 shrink-0" />
                                    )}
                                    {t("session.review.send")}
                                </Button>
                            </>
                        ) : null}
                        {comments.length > 0 && reviewNote?.tone === "error" ? (
                            <p className="w-full text-xs text-danger">{reviewNote.text}</p>
                        ) : null}
                    </div>
                ) : null}

                {problem && !listing ? (
                    <p className="text-sm text-muted-foreground">{problem}</p>
                ) : loading && !listing ? (
                    <div className="space-y-2">
                        {[0, 1, 2, 3].map((row) => (
                            <Skeleton key={row} className="h-7 w-full" />
                        ))}
                    </div>
                ) : listing && listing.files.length === 0 ? (
                    <EmptyState
                        bare
                        title={t("session.changes.empty")}
                        description={t("session.changes.emptyMore")}
                    />
                ) : listing ? (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                        <ul className="max-h-[70vh] min-w-0 space-y-0.5 overflow-y-auto overscroll-contain max-sm:max-h-[40vh]">
                            {listing.files.map((file) => (
                                <li key={file.path}>
                                    <button
                                        type="button"
                                        onClick={() => void open(file.path)}
                                        title={file.path}
                                        className={cn(
                                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-start text-xs hover:bg-muted [@media(pointer:coarse)]:min-h-11",
                                            selected === file.path && "bg-muted",
                                            isAccepted(file) && "text-muted-foreground"
                                        )}
                                    >
                                        {isAccepted(file) ? (
                                            <Check
                                                className="size-3.5 shrink-0 text-success"
                                                role="img"
                                                aria-label={t("session.changes.accepted")}
                                            />
                                        ) : null}
                                        {moved.has(file.path) ? (
                                            <span
                                                className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                                                role="img"
                                                aria-label={t("session.changes.justChanged")}
                                                title={t("session.changes.justChanged")}
                                            />
                                        ) : null}
                                        <span
                                            className="min-w-0 flex-1 truncate font-mono"
                                            title={file.path}
                                        >
                                            {file.path}
                                        </span>
                                        {file.added === null ? (
                                            <span className="min-w-0 max-w-full shrink-0 truncate text-muted-foreground" title={t("session.changes.binaryCount")}>
                                                {t("session.changes.binaryCount")}
                                            </span>
                                        ) : (
                                            <span className="shrink-0 font-mono">
                                                <span className="text-success">+{file.added}</span>{" "}
                                                <span className="text-danger">
                                                    -{file.removed ?? 0}
                                                </span>
                                            </span>
                                        )}
                                    </button>
                                </li>
                            ))}
                            {listing.next ? (
                                <li>
                                    <Button
                                        size="sm"
                                        className={TOUCH_TARGET}
                                        variant="ghost"
                                        onClick={() => void loadMore()}
                                        disabled={more}
                                    >
                                        {more ? (
                                            <Loader2 className="size-4 shrink-0 animate-spin" />
                                        ) : null}
                                        {t("session.changes.more")}
                                    </Button>
                                </li>
                            ) : null}
                        </ul>
                        <DiffPane
                            path={selected}
                            diff={selected ? diffs[selected]?.diff : undefined}
                            loading={selected ? pending.has(selected) : false}
                            retry={() => selected && void open(selected)}
                            actions={(() => {
                                const file = listing.files.find((row) => row.path === selected);
                                if (over || !file) return null;
                                const prefix = `${file.path}\n`;
                                return {
                                    accepted: isAccepted(file),
                                    toggleFile: () => toggleFile(file),
                                    revertFile: () => void revert(file.path),
                                    acceptedHunks: new Set(
                                        [...acceptedHunks]
                                            .filter((key) => key.startsWith(prefix))
                                            .map((key) => key.slice(prefix.length))
                                    ),
                                    toggleHunk: (id: string) => toggleHunk(file.path, id),
                                    revertHunk: (index: number, id: string) => void revert(file.path, { index, id }),
                                    busy: reverting
                                };
                            })()}
                            review={
                                over
                                    ? null
                                    : {
                                          on: reviewing,
                                          toggle: () => setReviewing((on) => !on),
                                          comments: comments.filter((row) => row.path === selected),
                                          add: addComment,
                                          remove: removeComment,
                                          sendSelection
                                      }
                            }
                        />
                    </div>
                ) : null}
                {problem && listing ? <p className="text-xs text-danger">{problem}</p> : null}
                {confirmElement}
            </CardBody>
        </Card>
    );
}

function DiffPane({
    path,
    diff,
    loading,
    retry,
    actions = null,
    review
}: {
    path: string | null;
    diff: FileDiff | "unreachable" | undefined;
    loading: boolean;
    retry: () => void;
    /** Accepting and reverting, or null where nothing can be changed. */
    actions?: FileActions | null;
    /** Commenting on lines, or null once the agent can no longer read them. */
    review: {
        on: boolean;
        toggle: () => void;
        comments: readonly LineComment[];
        add: (comment: LineComment) => void;
        remove: (key: string) => void;
        sendSelection: (selection: DiffSelection, note: string) => Promise<boolean>;
    } | null;
}) {
    const t = useTranslations("agents");
    if (!path) return <p className="text-sm text-muted-foreground">{t("session.changes.pick")}</p>;

    const said = (text: string, again = false) => (
        <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{text}</p>
            {again ? (
                <Button size="sm" className={TOUCH_TARGET} variant="ghost" onClick={retry}>
                    {t("session.changes.retry")}
                </Button>
            ) : null}
        </div>
    );

    return (
        <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border">
            <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
                    {path}
                </span>
                <CopyButton value={path} />
                {actions && diff !== undefined && diff !== "unreachable" && diff.kind !== "gone" ? (
                    <>
                        <Button
                            size="sm"
                            className={TOUCH_TARGET}
                            variant={actions.accepted ? "secondary" : "ghost"}
                            onClick={actions.toggleFile}
                            aria-pressed={actions.accepted}
                            title={t("session.changes.acceptFile")}
                            aria-label={t("session.changes.acceptFile")}
                        >
                            <Check className="size-4 shrink-0" />
                            <span className="hidden sm:inline">
                                {actions.accepted ? t("session.changes.accepted") : t("session.changes.accept")}
                            </span>
                        </Button>
                        <Button
                            size="sm"
                            className={TOUCH_TARGET}
                            variant="ghost"
                            onClick={actions.revertFile}
                            disabled={actions.busy}
                            title={t("session.changes.revertFile")}
                            aria-label={t("session.changes.revertFile")}
                        >
                            {actions.busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                                <Undo2 className="size-4 shrink-0" />
                            )}
                            <span className="hidden sm:inline">{t("session.changes.revert")}</span>
                        </Button>
                    </>
                ) : null}
                {review && diff !== undefined && diff !== "unreachable" && diff.kind === "diff" ? (
                    <Button
                        size="sm"
                        className={TOUCH_TARGET}
                        variant={review.on ? "secondary" : "ghost"}
                        onClick={review.toggle}
                        aria-pressed={review.on}
                        title={review.on ? t("session.review.stop") : t("session.review.start")}
                        aria-label={review.on ? t("session.review.stop") : t("session.review.start")}
                    >
                        <MessageSquare className="size-4 shrink-0" />
                        <span className="hidden sm:inline">
                            {review.on ? t("session.review.stop") : t("session.review.start")}
                        </span>
                    </Button>
                ) : null}
            </div>
            <div className="flex max-h-[70vh] min-h-24 min-w-0 flex-col">
                {diff === undefined || (loading && diff === "unreachable") ? (
                    <div className="space-y-2 p-4">
                        {[0, 1, 2, 3, 4].map((row) => (
                            <Skeleton key={row} className="h-4 w-full" />
                        ))}
                    </div>
                ) : diff === "unreachable" ? (
                    <div className="p-4">{said(t("session.changes.unreachable"), true)}</div>
                ) : diff.kind === "diff" && review?.on ? (
                    <DiffReview
                        key={path}
                        path={path}
                        text={diff.text}
                        comments={review.comments}
                        onAdd={review.add}
                        onRemove={review.remove}
                        onSendSelection={review.sendSelection}
                    />
                ) : diff.kind === "diff" && actions ? (
                    <HunkList path={path} text={diff.text} actions={actions} />
                ) : diff.kind === "diff" ? (
                    <CodeSurface
                        code={diff.text.replace(/\n$/, "")}
                        language="diff"
                        ariaLabel={t("session.changes.diffOf", { path })}
                    />
                ) : (
                    <div className="p-4">
                        {diff.kind === "binary"
                            ? said(t("session.changes.binary"))
                            : diff.kind === "large"
                              ? said(t("session.changes.large"))
                              : diff.kind === "gone"
                                ? said(t("session.changes.gone"))
                                : diff.kind === "failed"
                                  ? said(t("session.changes.failed"), true)
                                  : said(t(`session.changes.${diff.kind}`))}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * A diff hunk by hunk, each with its own Accept and Revert, the way OpenCode
 * and the editors with an agent in them offer it. An accepted hunk folds down
 * to its `@@` line; it stays in the checkout either way.
 */
function HunkList({ path, text, actions }: { path: string; text: string; actions: FileActions }) {
    const t = useTranslations("agents");
    const { hunks } = splitHunks(text);
    if (hunks.length === 0)
        return (
            <CodeSurface
                code={text.replace(/\n$/, "")}
                language="diff"
                ariaLabel={t("session.changes.diffOf", { path })}
            />
        );
    return (
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
            {hunks.map((hunk, index) => {
                const accepted = actions.acceptedHunks.has(hunk.id);
                const head = hunk.text.slice(0, hunk.text.indexOf("\n"));
                return (
                    <section
                        key={`${index}:${hunk.id}`}
                        aria-label={t("session.changes.hunk", { number: index + 1 })}
                        className="border-b border-border last:border-b-0"
                    >
                        <div className="flex min-w-0 items-center gap-1 bg-muted px-2 py-0.5">
                            {accepted ? <Check className="size-3.5 shrink-0 text-success" /> : null}
                            <span
                                className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                                title={head}
                            >
                                {head}
                            </span>
                            <Button
                                size="sm"
                                className={TOUCH_TARGET}
                                variant={accepted ? "secondary" : "ghost"}
                                onClick={() => actions.toggleHunk(hunk.id)}
                                aria-pressed={accepted}
                                title={t("session.changes.acceptHunk")}
                                aria-label={t("session.changes.acceptHunk")}
                            >
                                <Check className="size-4 shrink-0" />
                                <span className="hidden sm:inline">
                                    {accepted ? t("session.changes.accepted") : t("session.changes.accept")}
                                </span>
                            </Button>
                            <Button
                                size="sm"
                                className={TOUCH_TARGET}
                                variant="ghost"
                                onClick={() => actions.revertHunk(index, hunk.id)}
                                disabled={actions.busy}
                                title={t("session.changes.revertHunk")}
                                aria-label={t("session.changes.revertHunk")}
                            >
                                <Undo2 className="size-4 shrink-0" />
                                <span className="hidden sm:inline">{t("session.changes.revert")}</span>
                            </Button>
                        </div>
                        {accepted ? null : (
                            <CodeSurface
                                code={hunk.text.replace(/\n$/, "")}
                                language="diff"
                                ariaLabel={t("session.changes.diffOf", { path })}
                            />
                        )}
                    </section>
                );
            })}
        </div>
    );
}

const STATE_VARIANT = { open: "success", merged: "primary", closed: "neutral" } as const;

/**
 * The session's pull request: its link and state once there is one, else the
 * button that opens it - or, where it cannot be offered, the button disabled
 * with the reason on it.
 */
export function ShipPullRequest({ session }: { session: SessionView }) {
    const t = useTranslations("agents");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [view, setView] = useState<SessionShipView | null>(null);
    const [dialog, setDialog] = useState(false);
    const [title, setTitle] = useState("");
    const [body, setBody] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    const load = useCallback(async () => {
        const result = await runAction(() => sessionShipAction(session.id), setError);
        if (result?.view) setView(result.view);
    }, [session.id]);

    useEffect(() => {
        void load();
    }, [load, session.pullRequest?.number]);

    // Nothing is drawn until the answer is in: the button's place is a few
    // pixels, and offering one that turns out to be refused is worse.
    if (!view) return null;

    // A closed or merged one does not stand for what the agent did after it:
    // the button is offered again beside it.
    const linked = view.pull ? (
        <span className="flex min-w-0 items-center gap-2">
            <a
                href={view.pull.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-w-0 items-center gap-1 text-sm text-primary hover:underline"
                title={view.pull.title || undefined}
            >
                <GitPullRequest className="size-4 shrink-0" />
                <span className="truncate">
                    {t("session.ship.view", { number: view.pull.number })}
                </span>
                <ExternalLink className="size-3.5 shrink-0" />
            </a>
            {view.pull.state ? (
                <Badge variant={STATE_VARIANT[view.pull.state]} className="shrink-0">
                    {t(`session.ship.states.${view.pull.state}`)}
                </Badge>
            ) : null}
            {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
        </span>
    ) : null;
    if (linked && view.pull?.state !== "closed" && view.pull?.state !== "merged") return linked;

    if (view.blocked) {
        const reason = t(`session.ship.refusals.${view.blocked}`);
        return (
            <span className="flex min-w-0 flex-wrap items-center gap-2">
                {linked}
                <Button
                    size="sm"
                    className={TOUCH_TARGET}
                    variant="ghost"
                    disabled
                    title={reason}
                    aria-label={`${t("session.ship.open")}. ${reason}`}
                >
                    <GitPullRequest className="size-4 shrink-0" />
                    {t("session.ship.open")}
                </Button>
            </span>
        );
    }

    const start = () => {
        setTitle(view.draft.title);
        setBody(view.draft.body);
        setError(null);
        setDialog(true);
    };

    const ready = title.trim().length > 0;
    const submit = () => {
        if (!ready || busy) return;
        setError(null);
        startTransition(async () => {
            const result = await runAction(
                () => openSessionPullRequestAction({ sessionId: session.id, title, body }),
                setError
            );
            if (!result) return;
            if (result.error || !result.pull) {
                setError(result.error ?? t("session.ship.refusals.github"));
                return;
            }
            setNote(
                result.pull.existing
                    ? t("session.ship.existing", { number: result.pull.number })
                    : t("session.ship.opened", { number: result.pull.number })
            );
            setDialog(false);
            await load();
            router.refresh();
        });
    };

    return (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
            {linked}
            <Button size="sm" className={TOUCH_TARGET} variant="secondary" onClick={start}>
                <GitPullRequest className="size-4 shrink-0" />
                {t("session.ship.open")}
            </Button>
            {dialog ? (
                <Dialog open onOpenChange={(open) => !open && !busy && setDialog(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("session.ship.dialogTitle")}</DialogTitle>
                            <DialogDescription>
                                {t("session.ship.dialogDescription", { branch: session.branch })}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label className="text-sm font-medium" htmlFor="ship-title">
                                    {t("session.ship.title")} *
                                </label>
                                <Input
                                    id="ship-title"
                                    value={title}
                                    maxLength={256}
                                    onChange={(event) => setTitle(event.target.value)}
                                    required
                                />
                            </div>
                            <div className="space-y-1">
                                <label className="text-sm font-medium" htmlFor="ship-body">
                                    {t("session.ship.body")}
                                </label>
                                <Textarea
                                    id="ship-body"
                                    rows={8}
                                    value={body}
                                    maxLength={60_000}
                                    onChange={(event) => setBody(event.target.value)}
                                />
                            </div>
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                        </div>
                        <DialogFooter>
                            <Button
                                variant="ghost"
                                onClick={() => setDialog(false)}
                                disabled={busy}
                            >
                                {tcommon("actions.cancel")}
                            </Button>
                            <Button onClick={submit} aria-disabled={!ready || busy} disabled={busy}>
                                {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                                {busy ? t("session.ship.opening") : t("session.ship.submit")}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            ) : null}
        </span>
    );
}
