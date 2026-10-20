"use client";

/**
 * Polar's Code side.
 *
 * A Chat / Code switch at the top of Polar, the way the chat apps that also run
 * coding agents lay theirs out: Chat is the conversation it always was; Code is
 * the person's agent sessions, a composer that asks for the repository, the
 * branch and the agent, and a thread that follows the session as it works.
 *
 * Code never answers with the chat model. Sending starts an Agents session
 * through the Agents app's own `startSessionAction` - the same harness, Enigma
 * included, the same checks and the same row - and the thread is that session's
 * own messages and events, with the full session page one click away.
 *
 * Somebody who cannot use Agents sees Code switched off with the reason, and
 * somebody who can only read sessions can follow them but not start one.
 */

import Link from "next/link";
import { runAction } from "@/lib/run-action";
import { readPoll, useUnmountSignal } from "@/lib/poll-fetch";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MessageAction } from "@/components/polar/elements/message";
import { Button, cn, Input, SegmentedControl, Select, Textarea } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { PolarCodeOverview, PolarCodeRow, PolarCodeThread } from "@/app/(app)/polar/code-actions";
import { ArrowLeft, ArrowUp, Code2, ExternalLink, MessageSquare, Plus, TriangleAlert } from "lucide-react";
import {
    promptSessionAction,
    sessionChoicesAction,
    startSessionAction
} from "@/app/(app)/apps/agents/sessions/actions";

export type PolarMode = "chat" | "code";

const MODE_KEY = "polar.mode";
const OVERVIEW_KEY = "polar.code.overview";
const SESSIONS_PAGE = "/apps/agents/sessions";
/** The repository picker's "none": a workspace with nothing checked out. */
const NO_REPO = "workspace";
/** How often the list is asked again while Code is on screen. */
const LIST_MS = 10_000;
/** How often a live session's thread is asked again. */
const THREAD_MS = 3000;
/** A session title is at most this long (the start schema's own bound). */
const TITLE_MAX = 80;

function readStored(storage: () => Storage, key: string): string | null {
    try {
        return storage().getItem(key);
    } catch {
        return null;
    }
}

function writeStored(storage: () => Storage, key: string, value: string): void {
    try {
        storage().setItem(key, value);
    } catch {
        // A private window or blocked storage: the switch still works, it is only
        // not remembered.
    }
}

/** A title for a session started from a prompt: its first line, cut to fit. */
export function titleFromPrompt(prompt: string): string {
    const line = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 3).trimEnd()}...` : line;
}

export interface PolarCodeState {
    /** What is on screen: Chat unless Code was picked and is open to this account. */
    readonly mode: PolarMode;
    readonly setMode: (mode: PolarMode) => void;
    /** Null until the first answer, unless an earlier one is cached in this tab. */
    readonly overview: PolarCodeOverview | null;
    readonly refresh: () => void;
}

/** The switch's state and the Code side's data, owned by Polar's chat. */
export function usePolarCode(): PolarCodeState {
    const [picked, setPicked] = useState<PolarMode>("chat");
    const [overview, setOverview] = useState<PolarCodeOverview | null>(null);
    const signal = useUnmountSignal();

    useEffect(() => {
        if (readStored(() => window.localStorage, MODE_KEY) === "code") setPicked("code");
        const cached = readStored(() => window.sessionStorage, OVERVIEW_KEY);
        if (!cached) return;
        try {
            setOverview(JSON.parse(cached) as PolarCodeOverview);
        } catch {
            // A cache from another build: the first answer replaces it.
        }
    }, []);

    const refresh = useCallback(() => {
        readPoll<PolarCodeOverview>("/api/polar/code", {}, signal())
            .then((answer) => {
                setOverview(answer);
                writeStored(() => window.sessionStorage, OVERVIEW_KEY, JSON.stringify(answer));
            })
            // Keep what was on screen: the next ask tries again.
            .catch(() => undefined);
    }, [signal]);

    useEffect(() => refresh(), [refresh]);

    const open = overview?.access !== "none";
    const mode: PolarMode = picked === "code" && open ? "code" : "chat";

    useEffect(() => {
        if (mode !== "code") return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, LIST_MS);
        return () => clearInterval(timer);
    }, [mode, refresh]);

    const setMode = useCallback((next: PolarMode) => {
        setPicked(next);
        writeStored(() => window.localStorage, MODE_KEY, next);
    }, []);

    return useMemo(() => ({ mode, setMode, overview, refresh }), [mode, setMode, overview, refresh]);
}

/** Chat / Code, beside Polar's name. */
export function PolarModeSwitch({ code }: { code: PolarCodeState }) {
    const t = useTranslations("polar");
    const closed = code.overview?.access === "none";
    return (
        <SegmentedControl<PolarMode>
            size="sm"
            aria-label={t("code.switchLabel")}
            value={code.mode}
            onValueChange={code.setMode}
            options={[
                {
                    value: "chat",
                    label: (
                        <span className="flex items-center gap-1">
                            <MessageSquare className="size-3.5 shrink-0" aria-hidden />
                            {t("code.chat")}
                        </span>
                    ),
                    title: t("code.chat")
                },
                {
                    value: "code",
                    label: (
                        <span className="flex items-center gap-1">
                            <Code2 className="size-3.5 shrink-0" aria-hidden />
                            {t("code.code")}
                        </span>
                    ),
                    title: closed ? t("code.noAccess") : t("code.code"),
                    disabled: closed
                }
            ]}
        />
    );
}

/** The Code side: the session list beside (or above) a new task or a session. */
export function PolarCode({ code, split }: { code: PolarCodeState; split: boolean }) {
    const t = useTranslations("polar");
    const [selected, setSelected] = useState<string | null>(null);
    const overview = code.overview;
    const access = overview?.access ?? "none";
    const sessions = overview?.sessions ?? null;

    const open = (id: string | null) => setSelected(id);
    const started = (id: string) => {
        setSelected(id);
        code.refresh();
    };

    const list = <SessionList sessions={sessions} activeId={selected} onOpen={open} />;
    const home = <CodeHome canStart={access === "manage"} onStarted={started} />;

    if (split) {
        return (
            <div className="flex min-h-0 min-w-0 flex-1">
                <aside className="flex w-56 shrink-0 flex-col border-r border-border">
                    <div className="px-2 pt-2">
                        <NewRow onClick={() => open(null)} />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">{list}</div>
                </aside>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {selected ? (
                        <CodeThread sessionId={selected} canPrompt={access === "manage"} onBack={null} />
                    ) : (
                        home
                    )}
                </div>
            </div>
        );
    }

    if (selected)
        return (
            <CodeThread sessionId={selected} canPrompt={access === "manage"} onBack={() => open(null)} />
        );
    return (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {home}
            <div className="px-3 pb-3">
                <h3 className="px-2 pb-1 pt-3 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
                    {t("code.recents")}
                </h3>
                {list}
            </div>
        </div>
    );
}

function NewRow({ onClick }: { onClick: () => void }) {
    const t = useTranslations("polar");
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-muted"
        >
            <Plus className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{t("code.newTask")}</span>
        </button>
    );
}

function SessionList({
    sessions,
    activeId,
    onOpen
}: {
    sessions: readonly PolarCodeRow[] | null;
    activeId: string | null;
    onOpen: (id: string) => void;
}) {
    const t = useTranslations("polar");
    if (sessions === null)
        return (
            <div className="space-y-2 p-2">
                {[0, 1, 2].map((key) => (
                    <div key={key} className="h-6 rounded bg-muted motion-safe:animate-pulse" />
                ))}
            </div>
        );
    if (sessions.length === 0)
        return <p className="px-2 py-2 text-xs text-muted-foreground">{t("code.empty")}</p>;
    return (
        <ul className="space-y-0.5">
            {sessions.map((session) => (
                <li key={session.id}>
                    <button
                        type="button"
                        onClick={() => onOpen(session.id)}
                        aria-current={session.id === activeId ? "true" : undefined}
                        title={session.title}
                        className={cn(
                            "flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left hover:bg-muted",
                            session.id === activeId && "bg-muted"
                        )}
                    >
                        <span className="w-full min-w-0 truncate text-sm text-foreground" title={session.title}>{session.title}</span>
                        <span className="flex w-full min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <StateDot state={session.state} />
                            <span className="shrink-0">{session.stateLabel}</span>
                            <span className="min-w-0 truncate">{session.repo || t("code.workspace")}</span>
                        </span>
                    </button>
                </li>
            ))}
        </ul>
    );
}

const DOT: Record<PolarCodeRow["state"], string> = {
    starting: "bg-muted-foreground",
    working: "bg-violet-400 motion-safe:animate-pulse",
    waiting: "bg-warning",
    idle: "bg-success",
    stopped: "bg-muted-foreground/50",
    failed: "bg-danger"
};

function StateDot({ state }: { state: PolarCodeRow["state"] }) {
    return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />;
}

type Choices = Awaited<ReturnType<typeof sessionChoicesAction>>;

/** A new task: what to do, and where - repository, branch and agent. */
function CodeHome({ canStart, onStarted }: { canStart: boolean; onStarted: (id: string) => void }) {
    const t = useTranslations("polar");
    const [choices, setChoices] = useState<Choices | null>(null);
    const [prompt, setPrompt] = useState("");
    const [repoId, setRepoId] = useState("");
    const [baseRef, setBaseRef] = useState("");
    const [agentKey, setAgentKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        if (!canStart) return;
        void runAction(() => sessionChoicesAction(), setError).then((loaded) => {
            if (!loaded) return;
            setChoices(loaded);
            setRepoId((current) => current || (loaded.repos[0]?.id ?? NO_REPO));
            const ready = loaded.agents.find((agent) => agent.readiness !== "missing") ?? loaded.agents[0];
            setAgentKey((current) => current || (ready?.key ?? ""));
        });
    }, [canStart]);

    const agent: AgentOption | null = choices?.agents.find((option) => option.key === agentKey) ?? null;
    const workspace = repoId === NO_REPO;
    const unlinked = agent?.readiness === "missing" ? agent : null;
    const ready = canStart && choices !== null && agent !== null && !unlinked && prompt.trim().length > 0;

    const submit = () => {
        if (!ready || busy || !agent) return;
        setError(null);
        const text = prompt.trim();
        startTransition(() => {
            void runAction(
                () =>
                    startSessionAction({
                        repoId: workspace ? null : repoId,
                        title: titleFromPrompt(text),
                        cli: agent.cli,
                        accountId: agent.accountId,
                        useMachineLogin: agent.machine,
                        place: "local",
                        sharedHome: false,
                        hostId: null,
                        baseRef: workspace ? "" : baseRef.trim(),
                        prompt: text,
                        taskId: null,
                        unattended: null,
                        // Code in Polar is the harness's work: Enigma on, the rest
                        // following the repository and the instance.
                        enigma: { enabled: true }
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                // Created but not started still opens: the reason is on it.
                if (result.id) {
                    setPrompt("");
                    onStarted(result.id);
                }
                if (result.error) setError(result.error);
            });
        });
    };

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-3 pt-6">
            <h2 className="text-center text-lg font-semibold text-foreground">{t("code.heading")}</h2>
            {!canStart ? (
                <p className="text-center text-sm text-muted-foreground">{t("code.readOnly")}</p>
            ) : null}
            <div className="rounded-xl border border-border bg-background p-2">
                <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                    disabled={!canStart || busy}
                    rows={3}
                    aria-label={t("code.promptLabel")}
                    placeholder={t("code.placeholder")}
                    className="min-h-[4.5rem] resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
                />
                <div className="flex justify-end">
                    <Button
                        type="button"
                        size="icon-sm"
                        aria-label={t("code.start")}
                        title={t("code.start")}
                        aria-disabled={!ready || busy}
                        onClick={submit}
                        className={cn((!ready || busy) && "opacity-50")}
                    >
                        <ArrowUp className="size-4" />
                    </Button>
                </div>
            </div>
            {canStart ? (
                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        aria-label={t("code.repository")}
                        value={repoId}
                        onValueChange={setRepoId}
                        disabled={choices === null || busy}
                        placeholder={t("code.repository")}
                        className="h-8 w-auto min-w-0 max-w-full flex-1 basis-40 text-xs"
                        options={[
                            { value: NO_REPO, label: t("code.workspace") },
                            ...(choices?.repos ?? []).map((repo) => ({ value: repo.id, label: repo.name }))
                        ]}
                    />
                    {workspace ? null : (
                        <Input
                            aria-label={t("code.branch")}
                            value={baseRef}
                            onChange={(event) => setBaseRef(event.target.value)}
                            disabled={busy}
                            placeholder={t("code.branchPlaceholder")}
                            className="h-8 min-w-0 flex-1 basis-32 text-xs"
                        />
                    )}
                    <Select
                        aria-label={t("code.agent")}
                        value={agentKey}
                        onValueChange={setAgentKey}
                        disabled={choices === null || busy}
                        placeholder={t("code.agent")}
                        className="h-8 w-auto min-w-0 max-w-full flex-1 basis-40 text-xs"
                        options={(choices?.agents ?? []).map((option) => ({
                            value: option.key,
                            label: option.account ? `${option.label} - ${option.account}` : option.label
                        }))}
                    />
                </div>
            ) : null}
            {unlinked ? (
                <p className="text-xs text-muted-foreground">
                    {t("code.signIn", { agent: unlinked.label })}{" "}
                    <Link href="/apps/agents/settings" className="underline">
                        {t("code.openSettings")}
                    </Link>
                </p>
            ) : null}
            {choices !== null && choices.repos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t("code.noRepos")}{" "}
                    <Link href="/apps/agents/repos" className="underline">
                        {t("code.connectRepo")}
                    </Link>
                </p>
            ) : null}
            {error ? (
                <p role="alert" className="flex items-start gap-1.5 text-xs text-danger">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 break-words">{error}</span>
                </p>
            ) : null}
        </div>
    );
}

/** One session, followed while it runs. */
function CodeThread({
    sessionId,
    canPrompt,
    onBack
}: {
    sessionId: string;
    canPrompt: boolean;
    onBack: (() => void) | null;
}) {
    const t = useTranslations("polar");
    // Undefined while the first answer is on its way; null when it is not there.
    const [thread, setThread] = useState<PolarCodeThread | null | undefined>(undefined);
    const [reply, setReply] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const bottom = useRef<HTMLDivElement>(null);
    const signal = useUnmountSignal();

    const read = useCallback(() => {
        readPoll<PolarCodeThread | null>("/api/polar/code/thread", { sessionId }, signal())
            .then(setThread)
            .catch(() => setThread((current) => current ?? null));
    }, [sessionId, signal]);

    useEffect(() => {
        setThread(undefined);
        read();
    }, [read]);

    const live = thread?.session.live ?? false;
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") read();
        }, THREAD_MS);
        return () => clearInterval(timer);
    }, [live, read]);

    const count = thread?.entries.length ?? 0;
    useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [count]);

    const send = () => {
        const text = reply.trim();
        if (!text || busy) return;
        setError(null);
        startTransition(() => {
            void runAction(() => promptSessionAction({ sessionId, text }), setError).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else setReply("");
                read();
            });
        });
    };

    const session = thread?.session;
    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
                {onBack ? (
                    <MessageAction label={t("code.back")} onClick={onBack}>
                        <ArrowLeft />
                    </MessageAction>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" title={session?.title}>
                    {session?.title ?? ""}
                </span>
                {session ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <StateDot state={session.state} />
                        {session.stateLabel}
                    </span>
                ) : null}
                <Link
                    href={`${SESSIONS_PAGE}/${sessionId}`}
                    aria-label={t("code.openSession")}
                    title={t("code.openSession")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <ExternalLink className="size-4" />
                </Link>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
                {thread === undefined ? (
                    <div className="space-y-2">
                        {[0, 1, 2, 3].map((key) => (
                            <div key={key} className="h-5 rounded bg-muted motion-safe:animate-pulse" />
                        ))}
                    </div>
                ) : thread === null ? (
                    <p className="text-sm text-muted-foreground">{t("code.gone")}</p>
                ) : (
                    <>
                        {session && (session.repo || session.branch) ? (
                            <p className="mb-3 truncate text-xs text-muted-foreground" title={session.branch}>
                                {session.repo || t("code.workspace")}
                                {session.branch ? ` - ${session.branch}` : ""}
                            </p>
                        ) : null}
                        {thread.entries.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("code.quiet")}</p>
                        ) : (
                            <ol className="space-y-2">
                                {thread.entries.map((entry, index) =>
                                    entry.type === "message" ? (
                                        <li
                                            key={`${entry.at}-${index}`}
                                            className={cn(
                                                "max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm",
                                                entry.role === "user"
                                                    ? "ml-auto w-fit bg-muted text-foreground"
                                                    : "text-foreground"
                                            )}
                                        >
                                            {entry.text}
                                        </li>
                                    ) : (
                                        <li
                                            key={`${entry.at}-${index}`}
                                            className="flex min-w-0 gap-1.5 text-xs text-muted-foreground"
                                        >
                                            <span className="shrink-0 font-medium">{entry.text}</span>
                                            {entry.detail ? (
                                                <span className="min-w-0 truncate" title={entry.detail}>
                                                    {entry.detail}
                                                </span>
                                            ) : null}
                                        </li>
                                    )
                                )}
                            </ol>
                        )}
                        {thread.error ? (
                            <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-danger">
                                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                                <span className="min-w-0 break-words">{thread.error}</span>
                            </p>
                        ) : null}
                    </>
                )}
                <div ref={bottom} />
            </div>
            {thread ? (
                <div className="shrink-0 border-t border-border p-2">
                    {!live ? (
                        <p className="px-1 text-xs text-muted-foreground">{t("code.ended")}</p>
                    ) : !canPrompt ? (
                        <p className="px-1 text-xs text-muted-foreground">{t("code.readOnly")}</p>
                    ) : (
                        <div className="flex items-end gap-2">
                            <Textarea
                                value={reply}
                                onChange={(event) => setReply(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                                        event.preventDefault();
                                        send();
                                    }
                                }}
                                rows={1}
                                disabled={busy}
                                aria-label={t("code.reply")}
                                placeholder={t("code.reply")}
                                className="min-h-9 flex-1 resize-none"
                            />
                            <Button
                                type="button"
                                size="icon-sm"
                                aria-label={t("code.send")}
                                title={t("code.send")}
                                aria-disabled={!reply.trim() || busy}
                                onClick={send}
                                className={cn((!reply.trim() || busy) && "opacity-50")}
                            >
                                <ArrowUp className="size-4" />
                            </Button>
                        </div>
                    )}
                    {error ? (
                        <p role="alert" className="mt-1 px-1 text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
