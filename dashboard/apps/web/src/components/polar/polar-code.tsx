"use client";

/**
 * Polar's Code side.
 *
 * A Chat / Code switch at the top of Polar, the way the chat apps that also run
 * coding agents lay theirs out. Code is the same chat - the same welcome, the
 * same composer, the same thread and the same history in the sidebar - with the
 * repository, the branch and the agent as pickers on the composer, the way the
 * model picker sits on Chat's.
 *
 * Code never answers with the chat model. Sending starts an Agents session
 * through the Agents app's own `startSessionAction` - the same harness, Enigma
 * included, the same checks and the same row - and the thread is that session's
 * own messages and events, with the full session page one click away.
 *
 * The history is the person's own sessions, each task once, a page at a time
 * (`lib/polar/code-history`), listed beside their chats by `PolarThreads`.
 *
 * Somebody who cannot use Agents sees Code switched off with the reason, and
 * somebody who can only read sessions can follow them but not start one.
 */

import Link from "next/link";
import { runAction } from "@/lib/run-action";
import { fromWire } from "@/lib/app-bundles/wire";
import { readPoll, useUnmountSignal } from "@/lib/poll-fetch";
import { mergeCodeRows } from "@/lib/polar/code-history";
import { readStored, writeStored } from "@/lib/polar/stored";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { Work } from "@/components/polar/elements/work";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, cn, Input, SegmentedControl, Select } from "@polaris/ui";
import { ConversationEmptyState } from "@/components/polar/elements/conversation";
import { PolarThreadFrame, PolarWelcome } from "@/components/polar/polar-layout";
import { Message, MessageContent, MessageResponse } from "@/components/polar/elements/message";
import {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    useTransition,
    type ReactNode
} from "react";
import {
    PromptInput,
    PromptInputFooter,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputTools
} from "@/components/polar/elements/prompt-input";
import type {
    PolarCodeAccess,
    PolarCodeChoices,
    PolarCodeEntry,
    PolarCodeOverview,
    PolarCodeRow,
    PolarCodeThread
} from "@/lib/polar/code";
import {
    Bot,
    Code2,
    ExternalLink,
    FolderGit2,
    GitBranch,
    MessageSquare,
    TriangleAlert
} from "lucide-react";

export type PolarMode = "chat" | "code";

const MODE_KEY = "polar.mode";
const OVERVIEW_KEY = "polar.code.overview.v2";
const SESSIONS_PAGE = "/apps/agents/sessions";
/** The repository picker's "none": a workspace with nothing checked out. */
const NO_REPO = "workspace";
/** How often the history is asked again while Code is on screen. */
const LIST_MS = 10_000;
/** How often a live session's thread is asked again. */
const THREAD_MS = 3000;
/** A session title is at most this long (the start schema's own bound). */
const TITLE_MAX = 80;
/** The most a prompt may say; the start schema has the final word. */
const PROMPT_MAX = 20_000;

/** A change sent to one of the `/api/polar/code` routes; rejects when it was
 *  not answered, the way `runAction` expects. */
async function postCode<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    const answer = (await response.json()) as { value?: unknown };
    return fromWire(answer.value) as T;
}

/** A title for a session started from a prompt: its first line, cut to fit. */
export function titleFromPrompt(prompt: string): string {
    const line = prompt.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 3).trimEnd()}...` : line;
}

/** One block of a session's thread: something somebody said, or the run of
 *  steps the agent took between two messages, folded the way Chat folds an
 *  answer's tool calls. */
export type CodeBlock =
    | { readonly kind: "message"; readonly entry: PolarCodeEntry }
    | { readonly kind: "work"; readonly entries: readonly PolarCodeEntry[] };

/** The thread's entries as Chat draws them: each message on its own, and the
 *  events between two messages folded into one block. */
export function codeBlocks(entries: readonly PolarCodeEntry[]): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    for (const entry of entries) {
        const last = blocks.at(-1);
        if (entry.type === "message") blocks.push({ kind: "message", entry });
        else if (last?.kind === "work")
            blocks[blocks.length - 1] = { kind: "work", entries: [...last.entries, entry] };
        else blocks.push({ kind: "work", entries: [entry] });
    }
    return blocks;
}

/** The person's own sessions as the sidebar lists them, a page at a time. */
export interface PolarCodeHistory {
    /** Null until the first answer, unless an earlier one is cached in this tab. */
    readonly rows: readonly PolarCodeRow[] | null;
    readonly more: boolean;
    readonly loadingMore: boolean;
    readonly loadMore: () => void;
}

export interface PolarCodeState {
    /** What is on screen: Chat unless Code was picked and is open to this account. */
    readonly mode: PolarMode;
    readonly setMode: (mode: PolarMode) => void;
    /** Null until it is known. */
    readonly access: PolarCodeAccess | null;
    readonly history: PolarCodeHistory;
    /** The session on screen, or null for a new task. */
    readonly selected: string | null;
    /** Opens a session on the Code side, or a new task with null. */
    readonly open: (id: string | null) => void;
    readonly refresh: () => void;
}

/** The switch's state and the Code side's data, owned by Polar's chat. */
export function usePolarCode(): PolarCodeState {
    const [picked, setPicked] = useState<PolarMode>("chat");
    const [access, setAccess] = useState<PolarCodeAccess | null>(null);
    const [rows, setRows] = useState<readonly PolarCodeRow[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [selected, setSelected] = useState<string | null>(null);
    /** Whether a page past the first was read: a refresh then keeps them. */
    const paged = useRef(false);
    const signal = useUnmountSignal();

    const took = useCallback((answer: PolarCodeOverview) => {
        setAccess(answer.access);
        setRows((current) => mergeCodeRows(paged.current ? current : null, answer.sessions));
        if (!paged.current) setNext(answer.next ?? null);
    }, []);

    useEffect(() => {
        if (readStored(MODE_KEY) === "code") setPicked("code");
        const cached = readStored(OVERVIEW_KEY, "session");
        if (!cached) return;
        try {
            took(JSON.parse(cached) as PolarCodeOverview);
        } catch {
            // A cache from another build: the first answer replaces it.
        }
    }, [took]);

    const refresh = useCallback(() => {
        readPoll<PolarCodeOverview>("/api/polar/code", {}, signal())
            .then((answer) => {
                took(answer);
                writeStored(OVERVIEW_KEY, JSON.stringify(answer), "session");
            })
            // Keep what was on screen: the next ask tries again.
            .catch(() => undefined);
    }, [signal, took]);

    useEffect(() => refresh(), [refresh]);

    const loadMore = useCallback(() => {
        if (!next || loadingMore) return;
        setLoadingMore(true);
        readPoll<PolarCodeOverview>("/api/polar/code", { after: next }, signal())
            .then((answer) => {
                paged.current = true;
                setRows((current) => mergeCodeRows(current, answer.sessions));
                setNext(answer.next ?? null);
            })
            .catch(() => undefined)
            .finally(() => setLoadingMore(false));
    }, [next, loadingMore, signal]);

    const mode: PolarMode = picked === "code" && access !== "none" ? "code" : "chat";

    useEffect(() => {
        if (mode !== "code") return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, LIST_MS);
        return () => clearInterval(timer);
    }, [mode, refresh]);

    const setMode = useCallback((value: PolarMode) => {
        setPicked(value);
        writeStored(MODE_KEY, value);
    }, []);

    const open = useCallback(
        (id: string | null) => {
            setSelected(id);
            setMode("code");
        },
        [setMode]
    );

    const history = useMemo(
        () => ({ rows, more: next !== null, loadingMore, loadMore }),
        [rows, next, loadingMore, loadMore]
    );

    return useMemo(
        () => ({ mode, setMode, access, history, selected, open, refresh }),
        [mode, setMode, access, history, selected, open, refresh]
    );
}

/** Chat / Code, beside Polar's name. */
export function PolarModeSwitch({ code }: { code: PolarCodeState }) {
    const t = useTranslations("polar");
    const closed = code.access === "none";
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
                            <span className="polar-mode-label">{t("code.chat")}</span>
                        </span>
                    ),
                    title: t("code.chat")
                },
                {
                    value: "code",
                    label: (
                        <span className="flex items-center gap-1">
                            <Code2 className="size-3.5 shrink-0" aria-hidden />
                            <span className="polar-mode-label">{t("code.code")}</span>
                        </span>
                    ),
                    title: closed ? t("code.noAccess") : t("code.code"),
                    disabled: closed
                }
            ]}
        />
    );
}

/**
 * The Code side, in Chat's own frame: a new task opens on the same welcome as a
 * new chat, and a session reads as a chat thread with the composer under it.
 * The history is the sidebar's, beside the chats.
 */
export function PolarCodeView({
    code,
    fullPage,
    avatar
}: {
    code: PolarCodeState;
    fullPage: boolean;
    /** Polar's avatar at the welcome's size, as Chat draws it. */
    avatar: ReactNode;
}) {
    const t = useTranslations("polar");
    const canStart = code.access === "manage";
    const started = (id: string) => {
        code.open(id);
        code.refresh();
    };

    if (code.selected)
        return (
            <CodeThread
                key={code.selected}
                sessionId={code.selected}
                canPrompt={canStart}
                fullPage={fullPage}
            />
        );

    const composer = (
        <CodeStart canStart={canStart} pending={code.access === null} onStarted={started} />
    );
    if (fullPage)
        return (
            <PolarWelcome avatar={avatar} title={t("code.heading")}>
                {composer}
            </PolarWelcome>
        );
    return (
        <PolarThreadFrame fullPage={false} dock={composer}>
            <ConversationEmptyState icon={avatar} description={t("code.heading")} />
        </PolarThreadFrame>
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

export function StateDot({ state }: { state: PolarCodeRow["state"] }) {
    return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} />;
}

/** A picker on the composer's tool row, drawn the way the model picker is. */
const PICKER =
    "h-7 w-auto min-w-0 max-w-full gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-card-hover hover:text-foreground";

type Choices = PolarCodeChoices;

/** A notice under the composer: a hint, or an error that says what went wrong. */
function Notice({ error, children }: { error?: boolean; children: ReactNode }) {
    return (
        <p
            role={error ? "alert" : undefined}
            className={cn(
                "flex min-w-0 items-start gap-1.5 px-1 text-xs",
                error ? "text-danger-ink" : "text-muted-foreground"
            )}
        >
            {error ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : null}
            <span className="min-w-0 break-words">{children}</span>
        </p>
    );
}

/** A new task: Chat's composer, with where to work as pickers on it. */
function CodeStart({
    canStart,
    pending,
    onStarted
}: {
    canStart: boolean;
    pending: boolean;
    onStarted: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    const [choices, setChoices] = useState<Choices | null>(null);
    const [prompt, setPrompt] = useState("");
    const [repoId, setRepoId] = useState("");
    const [baseRef, setBaseRef] = useState("");
    const [agentKey, setAgentKey] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();

    useEffect(() => {
        if (!canStart) return;
        void runAction(
            () => readPoll<Choices | null>("/api/polar/code/choices", {}),
            setError
        ).then((loaded) => {
            if (!loaded) return;
            setChoices(loaded);
            setRepoId((current) => current || (loaded.repos[0]?.id ?? NO_REPO));
            const ready =
                loaded.agents.find((agent) => agent.readiness !== "missing") ?? loaded.agents[0];
            setAgentKey((current) => current || (ready?.key ?? ""));
        });
    }, [canStart]);

    const agent: AgentOption | null =
        choices?.agents.find((option) => option.key === agentKey) ?? null;
    const workspace = repoId === NO_REPO;
    const unlinked = agent?.readiness === "missing" ? agent : null;
    const ready =
        canStart && choices !== null && agent !== null && !unlinked && prompt.trim().length > 0;

    const submit = () => {
        if (!ready || busy || !agent) return;
        setError(null);
        const text = prompt.trim();
        startTransition(() => {
            void runAction(
                () =>
                    postCode<{ id?: string; error?: string }>("/api/polar/code/start", {
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
        <div className="flex min-w-0 flex-col gap-2">
            <PromptInput onSubmit={submit} aria-busy={pending || undefined}>
                <label htmlFor={inputId} className="sr-only">
                    {t("code.promptLabel")}
                </label>
                <PromptInputTextarea
                    id={inputId}
                    value={prompt}
                    maxLength={PROMPT_MAX}
                    disabled={!canStart || busy}
                    placeholder={t("code.placeholder")}
                    onChange={(event) => setPrompt(event.target.value)}
                    onSubmitKey={submit}
                />
                <PromptInputFooter className="items-end">
                    <PromptInputTools className="flex-wrap">
                        {canStart ? (
                            <>
                                <Select
                                    aria-label={t("code.repository")}
                                    value={repoId}
                                    onValueChange={setRepoId}
                                    disabled={choices === null || busy}
                                    placeholder={t("code.repository")}
                                    className={cn(PICKER, "max-w-[14rem]")}
                                    options={[
                                        {
                                            value: NO_REPO,
                                            label: t("code.workspace"),
                                            icon: <FolderGit2 className="size-3.5" />
                                        },
                                        ...(choices?.repos ?? []).map((repo) => ({
                                            value: repo.id,
                                            label: repo.name,
                                            icon: <FolderGit2 className="size-3.5" />
                                        }))
                                    ]}
                                />
                                {workspace ? null : (
                                    <span className="flex h-7 min-w-0 items-center gap-1 rounded-md px-2 text-muted-foreground focus-within:bg-card-hover hover:bg-card-hover">
                                        <GitBranch className="size-3.5 shrink-0" aria-hidden />
                                        <Input
                                            aria-label={t("code.branch")}
                                            title={t("code.branch")}
                                            value={baseRef}
                                            onChange={(event) => setBaseRef(event.target.value)}
                                            disabled={busy}
                                            placeholder={t("code.branchPlaceholder")}
                                            className="h-6 w-28 min-w-0 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                                        />
                                    </span>
                                )}
                                <Select
                                    aria-label={t("code.agent")}
                                    value={agentKey}
                                    onValueChange={setAgentKey}
                                    disabled={choices === null || busy}
                                    placeholder={t("code.agent")}
                                    className={cn(PICKER, "max-w-[14rem]")}
                                    options={(choices?.agents ?? []).map((option) => ({
                                        value: option.key,
                                        label: option.account
                                            ? `${option.label} - ${option.account}`
                                            : option.label,
                                        icon: <Bot className="size-3.5" />
                                    }))}
                                />
                            </>
                        ) : null}
                    </PromptInputTools>
                    <PromptInputSubmit
                        busy={false}
                        disabled={!ready || busy}
                        sendLabel={t("code.start")}
                        stopLabel={t("code.start")}
                        onStop={() => undefined}
                    />
                </PromptInputFooter>
            </PromptInput>
            {!canStart && !pending ? <Notice>{t("code.readOnly")}</Notice> : null}
            {unlinked ? (
                <Notice>
                    {t("code.signIn", { agent: unlinked.label })}{" "}
                    <Link href="/apps/agents/settings" className="text-primary hover:underline">
                        {t("code.openSettings")}
                    </Link>
                </Notice>
            ) : null}
            {choices !== null && choices.repos.length === 0 ? (
                <Notice>
                    {t("code.noRepos")}{" "}
                    <Link href="/apps/agents/repos" className="text-primary hover:underline">
                        {t("code.connectRepo")}
                    </Link>
                </Notice>
            ) : null}
            {error ? <Notice error>{error}</Notice> : null}
        </div>
    );
}

/** One session, followed while it runs, drawn as a chat thread. */
function CodeThread({
    sessionId,
    canPrompt,
    fullPage
}: {
    sessionId: string;
    canPrompt: boolean;
    fullPage: boolean;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    // Undefined while the first answer is on its way; null when it is not there.
    const [thread, setThread] = useState<PolarCodeThread | null | undefined>(undefined);
    const [failed, setFailed] = useState(false);
    const [reply, setReply] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const signal = useUnmountSignal();

    const read = useCallback(() => {
        readPoll<PolarCodeThread | null>("/api/polar/code/thread", { sessionId }, signal())
            .then((answer) => {
                setThread(answer);
                setFailed(false);
            })
            .catch(() => setFailed(true));
    }, [sessionId, signal]);

    useEffect(() => read(), [read]);

    const live = thread?.session.live ?? false;
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") read();
        }, THREAD_MS);
        return () => clearInterval(timer);
    }, [live, read]);

    const send = () => {
        const text = reply.trim();
        if (!text || busy) return;
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/prompt", { sessionId, text }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else setReply("");
                read();
            });
        });
    };

    const session = thread?.session;
    const blocks = useMemo(() => codeBlocks(thread?.entries ?? []), [thread]);

    const dock = !thread ? null : !live ? (
        <Notice>{t("code.ended")}</Notice>
    ) : !canPrompt ? (
        <Notice>{t("code.readOnly")}</Notice>
    ) : (
        <div className="flex min-w-0 flex-col gap-2">
            <PromptInput onSubmit={send}>
                <label htmlFor={inputId} className="sr-only">
                    {t("code.reply")}
                </label>
                <PromptInputTextarea
                    id={inputId}
                    value={reply}
                    maxLength={PROMPT_MAX}
                    disabled={busy}
                    placeholder={t("code.reply")}
                    onChange={(event) => setReply(event.target.value)}
                    onSubmitKey={send}
                />
                <PromptInputFooter>
                    <PromptInputTools />
                    <PromptInputSubmit
                        busy={false}
                        disabled={!reply.trim() || busy}
                        sendLabel={t("code.send")}
                        stopLabel={t("code.send")}
                        onStop={() => undefined}
                    />
                </PromptInputFooter>
            </PromptInput>
            {error ? <Notice error>{error}</Notice> : null}
        </div>
    );

    return (
        <PolarThreadFrame fullPage={fullPage} dock={dock}>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {session ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                        <StateDot state={session.state} />
                        {session.stateLabel}
                    </span>
                ) : null}
                <span
                    className="min-w-0 flex-1 truncate"
                    title={
                        session ? `${session.title}\n${session.repo} ${session.branch}` : undefined
                    }
                >
                    {session
                        ? `${session.repo || t("code.workspace")}${session.branch ? ` - ${session.branch}` : ""}`
                        : ""}
                </span>
                <Link
                    href={`${SESSIONS_PAGE}/${sessionId}`}
                    aria-label={t("code.openSession")}
                    title={t("code.openSession")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                >
                    <ExternalLink className="size-4" />
                </Link>
            </div>
            {thread === undefined && failed ? (
                <div className="flex flex-col items-start gap-2">
                    <p role="alert" className="text-sm text-muted-foreground">
                        {t("code.unreachable")}
                    </p>
                    <Button type="button" size="sm" variant="outline" onClick={read}>
                        {t("code.retry")}
                    </Button>
                </div>
            ) : thread === undefined ? (
                <div className="space-y-2" aria-busy>
                    {[0, 1, 2].map((key) => (
                        <div key={key} className="h-5 rounded bg-muted motion-safe:animate-pulse" />
                    ))}
                </div>
            ) : thread === null ? (
                <p className="text-sm text-muted-foreground">{t("code.gone")}</p>
            ) : (
                <>
                    {blocks.map((block, index) =>
                        block.kind === "message" ? (
                            <CodeMessage key={`${block.entry.at}-${index}`} entry={block.entry} />
                        ) : (
                            <Work
                                key={`${block.entries[0]?.at}-${index}`}
                                messageId={`code:${sessionId}:${index}`}
                                streaming={live && index === blocks.length - 1}
                                current={block.entries.at(-1)?.text ?? null}
                                tools={block.entries.length}
                                failed={0}
                                seconds={null}
                                summary={t("code.steps", { count: block.entries.length })}
                            >
                                <ol className="space-y-1">
                                    {block.entries.map((entry, line) => (
                                        <li
                                            key={`${entry.at}-${line}`}
                                            className="flex min-w-0 gap-1.5"
                                        >
                                            <span className="shrink-0 font-medium">
                                                {entry.text}
                                            </span>
                                            {entry.detail ? (
                                                <span
                                                    className="min-w-0 truncate"
                                                    title={entry.detail}
                                                >
                                                    {entry.detail}
                                                </span>
                                            ) : null}
                                        </li>
                                    ))}
                                </ol>
                            </Work>
                        )
                    )}
                    {thread.entries.length === 0 && live ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <ThinkingOrb state="breathing" size={20} decorative />
                            <Shimmer>{t("code.quiet")}</Shimmer>
                        </div>
                    ) : null}
                    {thread.error ? <Notice error>{thread.error}</Notice> : null}
                </>
            )}
        </PolarThreadFrame>
    );
}

/** A message of the session, in Chat's bubbles: the person's words as typed,
 *  the agent's as Markdown. */
function CodeMessage({ entry }: { entry: PolarCodeEntry }) {
    const from = entry.role === "user" ? "user" : "assistant";
    return (
        <Message from={from}>
            <MessageContent from={from}>
                {from === "user" ? (
                    <p className="whitespace-pre-wrap">{entry.text}</p>
                ) : (
                    <MessageResponse>{entry.text}</MessageResponse>
                )}
            </MessageContent>
        </Message>
    );
}
