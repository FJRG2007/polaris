"use client";

/**
 * The workspace beside a Code thread: the session's files, a live preview of
 * the web servers it runs, what it changed, and its terminal - what v0, bolt
 * and OpenHands put next to the chat.
 *
 * Each part is the Agents app's own, read from the same checkout: the changes
 * are `SessionChanges`, the terminal is the one the session page attaches to.
 * The files are read from the running container as the agent has them, saved
 * or not, and a file is read when it is opened, never all of them up front.
 */

import * as ui from "@polaris/ui";
import { languageForFile } from "@/lib/code-language";
import { CodeSurface } from "@/components/code-surface";
import type { SessionView } from "@/lib/agents/session-service";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ClientMessages } from "@/components/i18n/client-namespaces";
import { TerminalPanel } from "@/app/(app)/apps/deploy/terminal-panel";
import * as polls from "@/components/agents/sessions/sessions-polls";
import type { FileAnswer, FilesAnswer } from "@/lib/agents/session-files";
import type { PreviewPortsAnswer } from "@/lib/agents/session-preview";
import { SessionChanges } from "@/components/agents/sessions/session-changes";
import { openAgentInterfaceAction } from "@/components/agents/sessions/actions";
import {
    ExternalLink,
    FileCode2,
    FolderTree,
    GitCompare,
    Globe,
    RefreshCw,
    RotateCw,
    Search,
    SquareTerminal
} from "lucide-react";

type Pane = "files" | "preview" | "changes" | "terminal";

/** How often the file list is read again while the agent works. */
const FILES_MS = 20_000;
/** How often the session is asked which web servers it runs: a server the
 *  agent just started shows up within this. */
const PORTS_MS = 5_000;

/** The preview's own frame. The page is the agent's, so it never shares
 *  Polaris's origin: no `allow-same-origin`, here or in the response. */
const PREVIEW_FRAME_SANDBOX =
    "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export function PolarCodeWorkspace({
    open,
    onOpenChange,
    session,
    branch,
    live
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    session: SessionView;
    /** The branch to name, empty until the session changed something. */
    branch: string;
    live: boolean;
}) {
    const t = useTranslations("polar");
    const [pane, setPane] = useState<Pane>("files");
    return (
        <ui.Dialog open={open} onOpenChange={onOpenChange}>
            <ui.SheetContent className="sm:w-[min(72rem,calc(100vw-1rem))]">
                <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
                    <ui.DialogHeader className="pr-10">
                        <ui.DialogTitle className="truncate" title={session.title}>
                            {session.title}
                        </ui.DialogTitle>
                        <ui.DialogDescription className="truncate">
                            {session.repoFullName
                                ? branch
                                    ? `${session.repoFullName} - ${branch}`
                                    : session.repoFullName
                                : t("code.pane.noRepo")}
                        </ui.DialogDescription>
                    </ui.DialogHeader>
                    <ui.SegmentedControl
                        className="self-start"
                        aria-label={t("code.pane.title")}
                        value={pane}
                        onValueChange={(next) => setPane(next)}
                        options={[
                            {
                                value: "files",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <FolderTree className="size-4" />
                                        {t("code.pane.files")}
                                    </span>
                                )
                            },
                            {
                                value: "preview",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <Globe className="size-4" />
                                        {t("code.pane.preview")}
                                    </span>
                                )
                            },
                            {
                                value: "changes",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <GitCompare className="size-4" />
                                        {t("code.pane.changes")}
                                    </span>
                                )
                            },
                            {
                                value: "terminal",
                                label: (
                                    <span className="flex items-center gap-1.5">
                                        <SquareTerminal className="size-4" />
                                        {t("code.pane.terminal")}
                                    </span>
                                )
                            }
                        ]}
                    />
                    <div className="min-h-0 flex-1 overflow-hidden">
                        {pane === "files" ? (
                            <FilesPane sessionId={session.id} live={live} />
                        ) : pane === "preview" ? (
                            <PreviewPane sessionId={session.id} live={live} />
                        ) : pane === "changes" ? (
                            <div className="h-full overflow-y-auto overscroll-contain">
                                {/* Code lives under Polar, whose routes hand down no Agents catalog. */}
                                <ClientMessages
                                    namespaces={["agents"]}
                                    fallback={<ui.Skeleton className="h-24 w-full" />}
                                >
                                    <SessionChanges session={session} />
                                </ClientMessages>
                            </div>
                        ) : live ? (
                            <div className="flex h-full min-h-0 flex-col gap-2">
                                <InterfaceButton sessionId={session.id} />
                                <TerminalPanel
                                    target={{ kind: "agent", sessionId: session.id }}
                                    label={session.title}
                                    height="h-full min-h-80"
                                />
                            </div>
                        ) : (
                            <ui.EmptyState
                                icon={<SquareTerminal className="size-5" />}
                                title={t("code.pane.terminalEnded")}
                            />
                        )}
                    </div>
                </div>
            </ui.SheetContent>
        </ui.Dialog>
    );
}

/**
 * The agent's own interface, opened in the terminal beside the runner that
 * answers the thread's prompts. The terminal below switches to it.
 */
function InterfaceButton({ sessionId }: { sessionId: string }) {
    const t = useTranslations("polar");
    const [said, setSaid] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const open = () =>
        startTransition(async () => {
            const answer = await openAgentInterfaceAction(sessionId).catch(() => ({
                error: t("code.pane.interfaceFailed"),
                outcome: undefined
            }));
            if (answer.error) setSaid(answer.error);
            else if (answer.outcome === "interactive") setSaid(t("code.pane.interfaceAlready"));
            else if (answer.outcome === "busy") setSaid(t("code.pane.interfaceBusy"));
            else setSaid(null);
        });
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ui.Button type="button" size="sm" variant="outline" onClick={open} disabled={busy}>
                <SquareTerminal className="size-4 shrink-0" aria-hidden />
                {t("code.pane.openInterface")}
            </ui.Button>
            {said ? (
                <p role="status" className="min-w-0 text-xs text-muted-foreground">
                    {said}
                </p>
            ) : null}
        </div>
    );
}

function FilesPane({ sessionId, live }: { sessionId: string; live: boolean }) {
    const t = useTranslations("polar");
    const [list, setList] = useState<FilesAnswer | null>(null);
    const [failed, setFailed] = useState(false);
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<string | null>(null);

    const read = useCallback(
        (signal?: AbortSignal) => {
            polls
                .sessionFiles(sessionId, signal)
                .then((result) => {
                    if (result?.answer) {
                        setList(result.answer);
                        setFailed(false);
                    } else setFailed(true);
                })
                .catch(() => setFailed(true));
        },
        [sessionId]
    );

    useEffect(() => {
        const controller = new AbortController();
        read(controller.signal);
        if (!live) return () => controller.abort();
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") read(controller.signal);
        }, FILES_MS);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [read, live]);

    const shown = useMemo(() => {
        if (list?.kind !== "files") return [];
        const needle = query.trim().toLowerCase();
        const matched = needle
            ? list.paths.filter((path) => path.toLowerCase().includes(needle))
            : list.paths;
        // Drawn a page at a time: a repository of twenty thousand files is a
        // list nobody scrolls, and the search is how one is found.
        return matched.slice(0, 500);
    }, [list, query]);

    if (list?.kind === "unavailable") {
        return <ui.EmptyState icon={<FolderTree className="size-5" />} title={t("code.pane.filesUnavailable")} />;
    }

    return (
        <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
            <div className="flex min-h-0 w-full shrink-0 flex-col gap-2 md:w-72">
                <div className="flex items-center gap-2">
                    <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <ui.Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("code.pane.search")}
                            aria-label={t("code.pane.search")}
                            className="pl-8"
                        />
                    </div>
                    <ui.Button
                        variant="ghost"
                        size="icon"
                        onClick={() => read()}
                        aria-label={t("code.pane.refresh")}
                        title={t("code.pane.refresh")}
                    >
                        <RefreshCw className="size-4" />
                    </ui.Button>
                </div>
                <div className="max-h-48 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border md:max-h-none">
                    {list === null ? (
                        failed ? (
                            <p role="alert" className="p-3 text-sm text-muted-foreground">
                                {t("code.pane.filesFailed")}
                            </p>
                        ) : (
                            <div className="space-y-1.5 p-2" aria-busy>
                                {[0, 1, 2, 3, 4].map((key) => (
                                    <ui.Skeleton key={key} className="h-5 w-full" />
                                ))}
                            </div>
                        )
                    ) : shown.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">
                            {query ? t("code.pane.noMatch") : t("code.pane.empty")}
                        </p>
                    ) : (
                        <ul className="py-1">
                            {shown.map((path) => (
                                <li key={path}>
                                    <button
                                        type="button"
                                        onClick={() => setPicked(path)}
                                        title={path}
                                        className={ui.cn(
                                            "flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-card-hover",
                                            picked === path && "bg-card-hover font-medium"
                                        )}
                                    >
                                        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 truncate" dir="rtl">
                                            <bdi>{path}</bdi>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {list?.kind === "files" && (list.truncated || list.paths.length > shown.length) ? (
                    <p className="text-xs text-muted-foreground">
                        {t("code.pane.more", { shown: shown.length, total: list.paths.length })}
                    </p>
                ) : null}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border border-border">
                {picked ? (
                    <FileView key={picked} sessionId={sessionId} path={picked} />
                ) : (
                    <ui.EmptyState icon={<FileCode2 className="size-5" />} title={t("code.pane.pick")} />
                )}
            </div>
        </div>
    );
}

function PreviewPane({ sessionId, live }: { sessionId: string; live: boolean }) {
    const t = useTranslations("polar");
    const [answer, setAnswer] = useState<PreviewPortsAnswer | null>(null);
    const [failed, setFailed] = useState(false);
    const [port, setPort] = useState<number | null>(null);
    // Bumped by Reload: a new frame, since the page's own origin is opaque and
    // nothing outside it can tell it to reload.
    const [version, setVersion] = useState(0);

    const read = useCallback(
        (signal?: AbortSignal) => {
            polls
                .sessionPreview(sessionId, signal)
                .then((result) => {
                    if (result?.answer) {
                        setAnswer(result.answer);
                        setFailed(false);
                    } else setFailed(true);
                })
                .catch(() => setFailed(true));
        },
        [sessionId]
    );

    useEffect(() => {
        if (!live) return;
        const controller = new AbortController();
        read(controller.signal);
        const timer = window.setInterval(() => {
            if (document.visibilityState === "visible") read(controller.signal);
        }, PORTS_MS);
        return () => {
            controller.abort();
            window.clearInterval(timer);
        };
    }, [read, live]);

    const open = useMemo(() => (answer?.kind === "ports" ? answer.open : []), [answer]);
    // The first server, until the one picked stops answering.
    useEffect(() => {
        if (open.length === 0) return;
        if (port === null || !open.includes(port)) setPort(open[0]!);
    }, [open, port]);

    if (!live) return <ui.EmptyState icon={<Globe className="size-5" />} title={t("code.preview.ended")} />;
    if (answer?.kind === "unavailable") {
        return <ui.EmptyState icon={<Globe className="size-5" />} title={t("code.preview.unavailable")} />;
    }
    if (!answer) {
        return failed ? (
            <p role="alert" className="p-3 text-sm text-muted-foreground">
                {t("code.preview.failed")}
            </p>
        ) : (
            <div className="flex h-full flex-col gap-2" aria-busy>
                <ui.Skeleton className="h-8 w-64 max-w-full" />
                <ui.Skeleton className="min-h-40 w-full flex-1" />
            </div>
        );
    }

    const inside =
        answer.inside.length > 0 ? (
            <p className="text-xs text-muted-foreground">
                {t("code.preview.inside", { ports: answer.inside.join(", ") })}
            </p>
        ) : null;
    if (open.length === 0 || port === null) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2">
                <ui.EmptyState
                    icon={<Globe className="size-5" />}
                    title={t("code.preview.none")}
                    description={t("code.preview.noneHint")}
                />
                {inside}
            </div>
        );
    }

    const path = `${answer.base}/${port}/`;
    const address = `${window.location.origin}${path}`;
    return (
        <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div
                    role="group"
                    aria-label={t("code.preview.ports")}
                    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
                >
                    {open.map((one) => (
                        <ui.Button
                            key={one}
                            size="sm"
                            variant={one === port ? "secondary" : "ghost"}
                            aria-pressed={one === port}
                            onClick={() => setPort(one)}
                            className="shrink-0"
                        >
                            {t("code.preview.port", { port: one })}
                        </ui.Button>
                    ))}
                </div>
                <ui.Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setVersion((n) => n + 1)}
                    aria-label={t("code.preview.reload")}
                    title={t("code.preview.reload")}
                >
                    <RotateCw className="size-4" />
                </ui.Button>
                <ui.CopyButton value={address} label={t("code.preview.address")} className="p-2" />
                <a
                    href={path}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t("code.preview.openTab")}
                    title={t("code.preview.openTab")}
                    className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                >
                    <ExternalLink className="size-4" />
                </a>
            </div>
            <iframe
                key={`${port}:${version}`}
                src={path}
                title={t("code.preview.frame", { port })}
                sandbox={PREVIEW_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                className="min-h-0 w-full flex-1 rounded-md border border-border bg-white"
            />
            <p className="text-xs text-muted-foreground">{t("code.preview.hotReload")}</p>
            {inside}
        </div>
    );
}

function FileView({ sessionId, path }: { sessionId: string; path: string }) {
    const t = useTranslations("polar");
    const [file, setFile] = useState<FileAnswer | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const controller = new AbortController();
        polls
            .sessionFile({ sessionId, path }, controller.signal)
            .then((result) => {
                if (result?.answer) setFile(result.answer);
                else setFailed(true);
            })
            .catch(() => setFailed(true));
        return () => controller.abort();
    }, [sessionId, path]);

    const name = path.split("/").at(-1) ?? path;
    if (file?.kind === "text") {
        return (
            <div className="flex h-full min-h-0 flex-col">
                <p className="truncate border-b border-border px-3 py-2 font-mono text-xs" title={path}>
                    {path}
                </p>
                <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                    <CodeSurface
                        code={file.text}
                        language={languageForFile(name)?.id ?? null}
                        ariaLabel={path}
                        readOnly
                    />
                </div>
            </div>
        );
    }
    const reason =
        failed || file?.kind === "unavailable"
            ? t("code.pane.fileFailed")
            : file?.kind === "binary"
              ? t("code.pane.binary")
              : file?.kind === "tooLarge"
                ? t("code.pane.tooLarge")
                : file?.kind === "missing"
                  ? t("code.pane.missing")
                  : null;
    if (reason) return <ui.EmptyState icon={<FileCode2 className="size-5" />} title={reason} description={path} />;
    return (
        <div className="space-y-2 p-3" aria-busy>
            {[0, 1, 2, 3, 4, 5].map((key) => (
                <ui.Skeleton key={key} className="h-4 w-full" />
            ))}
        </div>
    );
}
