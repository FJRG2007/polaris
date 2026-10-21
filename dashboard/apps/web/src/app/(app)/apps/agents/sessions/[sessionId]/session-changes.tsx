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
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ChangedFile, FileDiff } from "@/lib/agents/session-changes";
import type { ChangesAnswer, DiffAnswer } from "@/lib/agents/session-review";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
    ExternalLink,
    FileDiff as FileDiffIcon,
    GitPullRequest,
    Loader2,
    RefreshCw
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
    sessionChangesAction,
    sessionFileDiffAction,
    sessionShipAction,
    type SessionShipView
} from "../actions";

/** How often the list is read again while the agent is still working. */
const REFRESH_MS = 15_000;

interface Listing {
    total: number;
    files: ChangedFile[];
    next: number | null;
}

export function SessionChanges({ session }: { session: SessionView }) {
    const t = useTranslations("agents");
    const [listing, setListing] = useState<Listing | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [more, setMore] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    const [diffs, setDiffs] = useState<Record<string, FileDiff | "unreachable">>({});
    const [diffLoading, setDiffLoading] = useState(false);
    const over = core.isSessionOver(session.state);
    const reads = useRef(0);

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
            () => sessionChangesAction({ sessionId: session.id, offset: 0 }),
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
        setProblem(null);
        const { total, files, next } = answer.listing;
        setListing({ total, files, next });
        // What was read before is stale the moment the list is: the agent is
        // what changes these files.
        setDiffs({});
    }, [session.id, t, wordsFor]);

    useEffect(() => {
        void load();
        if (over) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, REFRESH_MS);
        return () => clearInterval(timer);
    }, [load, over]);

    const loadMore = async () => {
        if (!listing?.next) return;
        setMore(true);
        const result = await runAction(
            () => sessionChangesAction({ sessionId: session.id, offset: listing.next }),
            setProblem
        );
        setMore(false);
        const answer = result?.answer;
        if (answer?.kind === "listing" && answer.listing.kind === "ok") {
            const page = answer.listing;
            setListing((current) =>
                current
                    ? {
                          total: page.total,
                          files: [...current.files, ...page.files],
                          next: page.next
                      }
                    : current
            );
        }
    };

    const open = useCallback(
        async (path: string) => {
            setSelected(path);
            setDiffLoading(true);
            const result = await runAction(
                () => sessionFileDiffAction({ sessionId: session.id, path }),
                setProblem
            );
            setDiffLoading(false);
            const answer = result?.answer;
            setDiffs((current) => ({
                ...current,
                [path]: answer?.kind === "diff" ? answer.diff : "unreachable"
            }));
        },
        [session.id]
    );

    // The open file is read again after a refresh rather than going blank.
    useEffect(() => {
        if (selected && !(selected in diffs) && !diffLoading && listing) void open(selected);
    }, [diffs, diffLoading, listing, open, selected]);

    const refresh = () => {
        setLoading(true);
        void load();
    };

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
                    <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
                        <RefreshCw className={cn("size-4 shrink-0", loading && "animate-spin")} />
                        {t("session.changes.refresh")}
                    </Button>
                </div>

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
                    <div className="grid gap-3 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
                        <ul className="max-h-[70vh] min-w-0 space-y-0.5 overflow-y-auto">
                            {listing.files.map((file) => (
                                <li key={file.path}>
                                    <button
                                        type="button"
                                        onClick={() => void open(file.path)}
                                        title={file.path}
                                        className={cn(
                                            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted",
                                            selected === file.path && "bg-muted"
                                        )}
                                    >
                                        <span
                                            className="min-w-0 flex-1 truncate font-mono"
                                            title={file.path}
                                        >
                                            {file.path}
                                        </span>
                                        {file.added === null ? (
                                            <span className="shrink-0 text-muted-foreground">
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
                            diff={selected ? diffs[selected] : undefined}
                            loading={diffLoading}
                            retry={() => selected && void open(selected)}
                        />
                    </div>
                ) : null}
                {problem && listing ? <p className="text-xs text-danger">{problem}</p> : null}
            </CardBody>
        </Card>
    );
}

function DiffPane({
    path,
    diff,
    loading,
    retry
}: {
    path: string | null;
    diff: FileDiff | "unreachable" | undefined;
    loading: boolean;
    retry: () => void;
}) {
    const t = useTranslations("agents");
    if (!path) return <p className="text-sm text-muted-foreground">{t("session.changes.pick")}</p>;

    const said = (text: string, again = false) => (
        <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{text}</p>
            {again ? (
                <Button size="sm" variant="ghost" onClick={retry}>
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
            </div>
            <div className="flex max-h-[70vh] min-h-24 min-w-0 flex-col">
                {loading || diff === undefined ? (
                    <div className="space-y-2 p-4">
                        {[0, 1, 2, 3, 4].map((row) => (
                            <Skeleton key={row} className="h-4 w-full" />
                        ))}
                    </div>
                ) : diff === "unreachable" ? (
                    <div className="p-4">{said(t("session.changes.unreachable"), true)}</div>
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

    if (view.pull) {
        return (
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
        );
    }

    if (view.blocked) {
        const reason = t(`session.ship.refusals.${view.blocked}`);
        return (
            <Button
                size="sm"
                variant="ghost"
                disabled
                title={reason}
                aria-label={`${t("session.ship.open")}. ${reason}`}
            >
                <GitPullRequest className="size-4 shrink-0" />
                {t("session.ship.open")}
            </Button>
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
        <>
            <Button size="sm" variant="secondary" onClick={start}>
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
        </>
    );
}
