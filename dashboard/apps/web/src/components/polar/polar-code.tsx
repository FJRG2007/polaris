"use client";

/**
 * Polar's Code side.
 *
 * A Chat / Code switch at the top of Polar, the way the chat apps that also run
 * coding agents lay theirs out. Code is the same chat - the same welcome, the
 * same composer (`polar-composer`), the same thread and the same history in the
 * sidebar - with the agent where Chat's composer has its model, and the
 * repository and branch in a bar above the task (`polar-code-context`).
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
import { preferredAgent } from "@/lib/polar/code-agent";
import { fromWire } from "@/lib/app-bundles/wire";
import { readPoll, sendAction, useUnmountSignal } from "@/lib/poll-fetch";
import { mergeCodeRows } from "@/lib/polar/code-history";
import { readStored, writeStored } from "@/lib/polar/stored";
import type { AgentOption } from "@/lib/agents/agent-readiness";
import { Work } from "@/components/polar/elements/work";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, cn, SegmentedControl } from "@polaris/ui";
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
import type { GithubAppGap } from "@/lib/github-app-reach";
import type { VoiceNotice } from "@/components/polar/polar-voice";
import { GithubAppGapNotice } from "@/components/github-app-gap";
import * as core from "@polaris/core";
import type { ModelChoice } from "@/lib/polar/shared";
import { usePolarUploads } from "@/components/polar/polar-uploads";
import { POLAR_ATTACHMENT_MOST, POLAR_ATTACHMENT_TYPES } from "@/lib/polar/shared";
import {
    firstModel,
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import { PolarComposer, type PolarVoiceKit } from "@/components/polar/polar-composer";
import {
    AgentPicker,
    CodeBranchChip,
    CodeRepoBar,
    CodeSessionBar,
    NO_REPO,
    readRepo
} from "@/components/polar/polar-code-context";
import type {
    PolarCodeAccess,
    PolarCodeChoices,
    PolarCodeEntry,
    PolarCodeOverview,
    PolarCodeRow,
    PolarCodeThread
} from "@/lib/polar/code";
import { Code2, ExternalLink, MessageSquare, TriangleAlert } from "lucide-react";

export type PolarMode = "chat" | "code";

const MODE_KEY = "polar.mode";
const OVERVIEW_KEY = "polar.code.overview.v2";
const SESSIONS_PAGE = "/apps/agents/sessions";
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
    /** Takes a finished session out of the list at once, and puts it back
     *  when the server refuses. False when it was put back. */
    readonly remove: (id: string) => Promise<boolean>;
    /** Renames a session at once, and puts the old name back on a refusal. */
    readonly rename: (id: string, title: string) => Promise<boolean>;
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
export function usePolarCode({ enabled = true }: { enabled?: boolean } = {}): PolarCodeState {
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

    useEffect(() => {
        if (enabled) refresh();
    }, [enabled, refresh]);

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

    const edit = useCallback(
        (body: { action: "delete" | "rename"; sessionId: string; title?: string }) =>
            sendAction<{ ok: boolean }>("/api/polar/code/edit", body, signal())
                .then((answer) => answer.ok)
                .catch(() => false),
        [signal]
    );

    const remove = useCallback(
        async (id: string) => {
            const row = rows?.find((each) => each.id === id);
            if (!row) return false;
            setRows((current) => current?.filter((each) => each.id !== id) ?? null);
            setSelected((current) => (current === id ? null : current));
            const ok = await edit({ action: "delete", sessionId: id });
            if (!ok) setRows((current) => mergeCodeRows(current, [row]));
            // The cached first page must not bring it back on the next visit.
            else refresh();
            return ok;
        },
        [rows, edit, refresh]
    );

    const rename = useCallback(
        async (id: string, title: string) => {
            const before = rows?.find((each) => each.id === id)?.title;
            if (before === undefined || before === title) return true;
            const retitle = (value: string) =>
                setRows(
                    (current) =>
                        current?.map((each) => (each.id === id ? { ...each, title: value } : each)) ??
                        null
                );
            retitle(title);
            const ok = await edit({ action: "rename", sessionId: id, title });
            if (!ok) retitle(before);
            return ok;
        },
        [rows, edit]
    );

    const mode: PolarMode = picked === "code" && access !== "none" ? "code" : "chat";

    useEffect(() => {
        if (!enabled || mode !== "code") return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") refresh();
        }, LIST_MS);
        return () => clearInterval(timer);
    }, [enabled, mode, refresh]);

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
        () => ({ rows, more: next !== null, loadingMore, loadMore, remove, rename }),
        [rows, next, loadingMore, loadMore, remove, rename]
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

/** What a new task offers - repositories and agents - read once Code may start
 *  one, and again on a refresh (after adding repositories on GitHub). */
function useCodeChoices(canStart: boolean) {
    const [choices, setChoices] = useState<Choices | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [repoId, setRepoId] = useState("");
    // The pick as of now, for a refresh that lands after it changed.
    const picked = useRef(repoId);
    useEffect(() => {
        picked.current = repoId;
    }, [repoId]);
    const [agentKey, setAgentKey] = useState("");

    const load = useCallback(() => {
        setRefreshing(true);
        void runAction(() => readPoll<Choices | null>("/api/polar/code/choices", {}), setError)
            .then((loaded) => {
                if (!loaded) return;
                setError(null);
                setChoices(loaded);
                // A pick that is gone (a repository disconnected meanwhile) falls back.
                // One past the first page is asked about by id rather than taken
                // for gone because the page does not hold it.
                const fallback = loaded.repos[0]?.id ?? NO_REPO;
                const current = picked.current;
                if (current === "") setRepoId(fallback);
                else if (current !== NO_REPO && !loaded.repos.some((repo) => repo.id === current))
                    void readRepo(current)
                        .then((found) => {
                            if (!found) setRepoId((now) => (now === current ? fallback : now));
                        })
                        .catch(() => undefined);
                const ready = preferredAgent(loaded.agents);
                setAgentKey((current) =>
                    loaded.agents.some((agent) => agent.key === current)
                        ? current
                        : (ready?.key ?? "")
                );
            })
            .finally(() => setRefreshing(false));
    }, []);

    useEffect(() => {
        if (canStart) load();
    }, [canStart, load]);

    return { choices, error, refreshing, load, repoId, setRepoId, agentKey, setAgentKey };
}

/**
 * The Code side, in Chat's own frame: a new task opens on the same welcome as a
 * new chat, and a session reads as a chat thread with the composer under it.
 * Where the task works sits in a bar above it; the history is the sidebar's,
 * beside the chats.
 */
export function PolarCodeView({
    code,
    fullPage,
    avatar,
    voiceKit,
    providers
}: {
    code: PolarCodeState;
    fullPage: boolean;
    /** Polar's avatar at the welcome's size, as Chat draws it. */
    avatar: ReactNode;
    /** Chat's microphone, so dictation works here exactly as it does there. */
    voiceKit: PolarVoiceKit;
    /** Chat's providers and models, for an agent that takes one. */
    providers: ModelSelectorProvider[] | null;
}) {
    const t = useTranslations("polar");
    const canStart = code.access === "manage";
    const picks = useCodeChoices(canStart);
    const [baseRef, setBaseRef] = useState("");
    // The words a task was started with, for the session they started: they are
    // stored on it only once the agent is up, and until then its thread would
    // otherwise open empty.
    const [opening, setOpening] = useState<{ id: string; text: string } | null>(null);
    const started = (id: string, text: string) => {
        setOpening({ id, text });
        code.open(id);
        code.refresh();
    };

    if (code.selected)
        return (
            <CodeThread
                key={code.selected}
                sessionId={code.selected}
                firstPrompt={opening?.id === code.selected ? opening.text : null}
                canPrompt={canStart}
                fullPage={fullPage}
                voiceKit={voiceKit}
            />
        );

    const bar = canStart ? (
        <CodeRepoBar
            fullPage={fullPage}
            choices={picks.choices}
            repoId={picks.repoId}
            onRepo={(id) => {
                // A branch belongs to the repository it was picked in.
                if (id !== picks.repoId) setBaseRef("");
                picks.setRepoId(id);
            }}
            onRefresh={picks.load}
            refreshing={picks.refreshing}
            disabled={false}
        />
    ) : null;
    const composer = (
        <CodeStart
            canStart={canStart}
            pending={code.access === null}
            choices={picks.choices}
            choicesError={picks.error}
            repoId={picks.repoId}
            baseRef={baseRef}
            onBaseRef={setBaseRef}
            agentKey={picks.agentKey}
            onAgent={picks.setAgentKey}
            voiceKit={voiceKit}
            providers={providers}
            onStarted={started}
        />
    );
    if (fullPage)
        return (
            <>
                {bar}
                <PolarWelcome avatar={avatar} title={t("code.heading")}>
                    {composer}
                </PolarWelcome>
            </>
        );
    return (
        <>
            {bar}
            <PolarThreadFrame fullPage={false} dock={composer}>
                <ConversationEmptyState icon={avatar} description={t("code.heading")} />
            </PolarThreadFrame>
        </>
    );
}

const DOT: Record<PolarCodeRow["state"], string> = {
    queued: "bg-muted-foreground/50",
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

/** Chat's composer as Code takes it: the same files (copied into the session's
 *  working directory) and the same microphone; no voice conversation for an
 *  agent session (said on the button). */
function useCodeComposerParts(busy: boolean) {
    const t = useTranslations("polar");
    const [notice, setNotice] = useState<VoiceNotice | null>(null);
    const uploads = usePolarUploads();
    return {
        notice,
        setNotice,
        uploads,
        attach: {
            files: uploads.files,
            error: uploads.error,
            accept: POLAR_ATTACHMENT_TYPES,
            disabled: busy || uploads.files.length >= POLAR_ATTACHMENT_MOST,
            onFiles: uploads.add,
            onFailed: uploads.setError,
            onRemove: uploads.remove,
            onRetry: uploads.retry
        },
        voiceMode: { refusal: t("code.noVoice") }
    };
}

/** A new task: Chat's composer, with the agent where Chat has its model. */
function CodeStart({
    canStart,
    pending,
    choices,
    choicesError,
    repoId,
    baseRef,
    onBaseRef,
    agentKey,
    onAgent,
    voiceKit,
    providers,
    onStarted
}: {
    canStart: boolean;
    pending: boolean;
    choices: Choices | null;
    choicesError: string | null;
    repoId: string;
    baseRef: string;
    onBaseRef: (branch: string) => void;
    agentKey: string;
    onAgent: (key: string) => void;
    voiceKit: PolarVoiceKit;
    /** Chat's own list of providers and models, for an agent that takes one. */
    providers: ModelSelectorProvider[] | null;
    onStarted: (id: string, text: string) => void;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [gap, setGap] = useState<GithubAppGap | null>(null);
    const [busy, startTransition] = useTransition();
    const parts = useCodeComposerParts(busy);
    const [picked, setPicked] = useState<ModelChoice | null>(null);
    // What was just sent, shown at once as the first message of the session
    // while the machine for it comes up, rather than a composer that only
    // greys out for the minute that can take.
    const [sent, setSent] = useState<string | null>(null);

    const agent: AgentOption | null =
        choices?.agents.find((option) => option.key === agentKey) ?? null;
    const workspace = repoId === NO_REPO;
    // A tool that takes its model from Polaris signs in with that provider's
    // key, so its own sign-in does not matter.
    const takesModel = agent !== null && core.MODEL_CHOICE_AGENT_CLIS.includes(agent.cli);
    const model = takesModel ? (picked ?? firstModel(providers)) : null;
    const unlinked = agent?.readiness === "missing" && !takesModel ? agent : null;
    const noModel = takesModel && model === null && providers !== null;
    const ready =
        canStart &&
        choices !== null &&
        agent !== null &&
        !unlinked &&
        (!takesModel || model !== null) &&
        !parts.uploads.uploading &&
        !parts.uploads.failed &&
        prompt.trim().length > 0;

    const submit = () => {
        if (!ready || busy || !agent) return;
        setError(null);
        setGap(null);
        const text = prompt.trim();
        setSent(text);
        setPrompt("");
        // Back into the composer when the session was not created, so nothing
        // typed is lost to a failure.
        const restore = () => {
            setSent(null);
            setPrompt((current) => current || text);
        };
        startTransition(() => {
            void runAction(
                () =>
                    postCode<{ id?: string; error?: string; githubGap?: GithubAppGap }>(
                        "/api/polar/code/start",
                        {
                            repoId: workspace ? null : repoId,
                            title: titleFromPrompt(text),
                            cli: agent.cli,
                            accountId: takesModel ? null : agent.accountId,
                            useMachineLogin: takesModel ? false : agent.machine,
                            modelChoice: model
                                ? { provider: model.provider, model: model.model, payer: model.payer }
                                : null,
                            attachments: parts.uploads.ids,
                            place: "local",
                            sharedHome: false,
                            hostId: null,
                            baseRef: workspace ? "" : baseRef.trim(),
                            prompt: text,
                            taskId: null,
                            unattended: null,
                            // Code in Polar is the harness's work: Enigma on, the
                            // rest following the repository and the instance.
                            enigma: { enabled: true }
                        }
                    ),
                setError
            ).then((result) => {
                if (!result?.id) restore();
                if (!result) return;
                // Created but not started still opens: the reason is on it.
                if (result.id) {
                    setSent(null);
                    parts.uploads.clear();
                    onStarted(result.id, text);
                }
                if (result.githubGap) setGap(result.githubGap);
                else if (result.error) setError(result.error);
            });
        });
    };

    const shownError = error ?? choicesError;
    return (
        <div className="flex min-w-0 flex-col gap-2" aria-busy={pending || sent !== null || undefined}>
            {sent !== null ? (
                <div className="flex min-w-0 flex-col gap-3 pb-2">
                    <Message from="user">
                        <MessageContent from="user">
                            <p className="whitespace-pre-wrap">{sent}</p>
                        </MessageContent>
                    </Message>
                    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                        <ThinkingOrb state="breathing" size={20} decorative />
                        <Shimmer>{t("code.starting")}</Shimmer>
                    </div>
                </div>
            ) : null}
            <PolarComposer
                kit={voiceKit}
                notice={parts.notice}
                onNotice={parts.setNotice}
                inputId={inputId}
                label={t("code.promptLabel")}
                value={prompt}
                onValueChange={setPrompt}
                placeholder={t("code.placeholder")}
                disabled={!canStart || busy}
                maxLength={PROMPT_MAX}
                onSubmit={submit}
                picker={
                    canStart ? (
                        <>
                            <AgentPicker
                                agents={choices?.agents ?? null}
                                value={agentKey}
                                onChange={onAgent}
                                disabled={busy}
                            />
                            {takesModel ? (
                                <ModelSelector
                                    providers={providers ?? []}
                                    choice={model}
                                    onChoice={setPicked}
                                    forCode
                                />
                            ) : null}
                        </>
                    ) : null
                }
                attach={parts.attach}
                voiceMode={parts.voiceMode}
                submit={{
                    busy: false,
                    disabled: !ready || busy,
                    sendLabel: t("code.start"),
                    stopLabel: t("code.start"),
                    onStop: () => undefined
                }}
            />
            {canStart && repoId && repoId !== NO_REPO ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
                    <CodeBranchChip
                        repoId={repoId}
                        branch={baseRef}
                        onBranch={onBaseRef}
                        disabled={busy}
                    />
                </div>
            ) : null}
            {!canStart && !pending ? <Notice>{t("code.readOnly")}</Notice> : null}
            {noModel ? (
                <Notice>
                    {t("code.noModel")}{" "}
                    <Link href="/account/ai-keys" className="text-primary hover:underline">
                        {t("code.addKey")}
                    </Link>
                </Notice>
            ) : null}
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
            {gap ? <GithubAppGapNotice gap={gap} onCheckAgain={submit} checking={busy} /> : null}
            {shownError ? <Notice error>{shownError}</Notice> : null}
        </div>
    );
}

/** One session, followed while it runs, drawn as a chat thread. */
function CodeThread({
    sessionId,
    firstPrompt,
    canPrompt,
    fullPage,
    voiceKit
}: {
    sessionId: string;
    /** What the task was started with here, shown until the session has it. */
    firstPrompt: string | null;
    canPrompt: boolean;
    fullPage: boolean;
    voiceKit: PolarVoiceKit;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    // Undefined while the first answer is on its way; null when it is not there.
    const [thread, setThread] = useState<PolarCodeThread | null | undefined>(undefined);
    const [failed, setFailed] = useState(false);
    const [reply, setReply] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const parts = useCodeComposerParts(busy);
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
        if (!text || busy || parts.uploads.uploading || parts.uploads.failed) return;
        const attachments = parts.uploads.ids;
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/prompt", {
                        sessionId,
                        text,
                        attachments
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.error) setError(result.error);
                else {
                    setReply("");
                    parts.uploads.clear();
                }
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
            <PolarComposer
                kit={voiceKit}
                notice={parts.notice}
                onNotice={parts.setNotice}
                inputId={inputId}
                label={t("code.reply")}
                value={reply}
                onValueChange={setReply}
                placeholder={t("code.reply")}
                disabled={busy}
                maxLength={PROMPT_MAX}
                onSubmit={send}
                picker={null}
                attach={parts.attach}
                voiceMode={parts.voiceMode}
                submit={{
                    busy: false,
                    disabled:
                        !reply.trim() || busy || parts.uploads.uploading || parts.uploads.failed,
                    sendLabel: t("code.send"),
                    stopLabel: t("code.send"),
                    onStop: () => undefined
                }}
            />
            {error ? <Notice error>{error}</Notice> : null}
        </div>
    );

    return (
        <>
            <CodeSessionBar
                fullPage={fullPage}
                repo={session?.repo ?? ""}
                branch={session?.branch ?? ""}
            >
                {session ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                        <StateDot state={session.state} />
                        {session.stateLabel}
                    </span>
                ) : null}
                <Link
                    href={`${SESSIONS_PAGE}/${sessionId}`}
                    aria-label={t("code.openSession")}
                    title={t("code.openSession")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                >
                    <ExternalLink className="size-4" />
                </Link>
            </CodeSessionBar>
            <PolarThreadFrame fullPage={fullPage} dock={dock}>
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
                            <div
                                key={key}
                                className="h-5 rounded bg-muted motion-safe:animate-pulse"
                            />
                        ))}
                    </div>
                ) : thread === null ? (
                    <p className="text-sm text-muted-foreground">{t("code.gone")}</p>
                ) : (
                    <>
                        {blocks.map((block, index) =>
                            block.kind === "message" ? (
                                <CodeMessage
                                    key={`${block.entry.at}-${index}`}
                                    entry={block.entry}
                                />
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
                        {firstPrompt && !thread.entries.some((entry) => entry.role === "user") ? (
                            <Message from="user">
                                <MessageContent from="user">
                                    <p className="whitespace-pre-wrap">{firstPrompt}</p>
                                </MessageContent>
                            </Message>
                        ) : null}
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
        </>
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
