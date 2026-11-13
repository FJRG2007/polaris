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
import { fromWire } from "@/lib/app-bundles/wire";
import { readPoll, sendAction, useUnmountSignal } from "@/lib/poll-fetch";
import { mergeCodeRows } from "@/lib/polar/code-history";
import { readStored, writeStored } from "@/lib/polar/stored";
import { CODE_AGENT_STORAGE_KEY, customAgentKey } from "@/lib/polar/agents/shared";
import type { EnginePolicy } from "@/lib/polar/agents/code-sources";
import {
    AUTOMATIC_PICK,
    CODE_PICK_STORAGE_KEY,
    isAutomaticPick,
    migrateStoredAgent,
    polarSourcesFor,
    POLAR_RUNTIME,
    readStoredPick,
    resolveCodeEngine,
    type CodePick,
    type CodeSource
} from "@/lib/polar/agents/code-sources";
import { CodeModelPicker } from "@/components/polar/code-model-picker";
import { CodeView } from "@/components/json-view";
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
    useLayoutEffect,
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
import { automaticChoice, type ModelChoice } from "@/lib/polar/shared";
import { usePolarUploads } from "@/components/polar/polar-uploads";
import { POLAR_ATTACHMENT_MOST, POLAR_ATTACHMENT_TYPES } from "@/lib/polar/shared";
import {
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import { PolarComposer, type PolarVoiceKit } from "@/components/polar/polar-composer";
import { useCodeSlash } from "@/components/polar/polar-code-slash";
import { usePolarCommands } from "@/components/polar/polar-commands";
import { ContextBar } from "@/components/polar/polar-context";
import { estimateTokens } from "@/lib/polar/compaction";
import {
    CodeIssueChip,
    CodeSkillChip,
    CodePersonaChip,
    type PickedIssue,
    CodeWhereChip,
    CodeSessionBar,
    NO_REPO,
    PERMISSION_MODE_KEY,
    PermissionModePicker,
    readPermissionMode,
    readRepo,
    useRepoName
} from "@/components/polar/polar-code-context";
import type { PendingPermission } from "@/lib/agents/session-permissions";
import type { PolarCodeTask } from "@/lib/polar/code-task";
import type {
    PolarCodeAccess,
    PolarCodeChoices,
    PolarCodeEntry,
    PolarCodeOverview,
    PolarCodeRow,
    PolarCodeThread
} from "@/lib/polar/code";
import type { SessionView } from "@/lib/agents/session-service";
import { Code2, MessageSquare, PanelRight, ShieldCheck, TriangleAlert } from "lucide-react";
import dynamic from "next/dynamic";

/** Loaded after the thread, not with it: its terminal is not needed to read one. */
const PolarCodeWorkspace = dynamic(
    () => import("@/components/polar/polar-code-workspace").then((module) => module.PolarCodeWorkspace),
    { ssr: false }
);

/** A session's pull request and its Share button, in the Agents app's words.
 *  Drawn only where somebody can steer the session, so loaded there. */
const SessionTools = dynamic(
    () =>
        Promise.all([
            import("@/components/agents/sessions/session-pull"),
            import("@/components/agents/sessions/share-button"),
            import("@/components/i18n/client-namespaces")
        ]).then(([pull, share, i18n]) =>
            function SessionTools({ session }: { session: SessionView }) {
                return (
                    <i18n.ClientMessages namespaces={["agents"]} fallback={null}>
                        {session.pullRequest ? <pull.SessionPull session={session} /> : null}
                        <share.SessionShareButton sessionId={session.id} title={session.title} />
                    </i18n.ClientMessages>
                );
            }
        ),
    { ssr: false }
);

export type PolarMode = "chat" | "code";

/** A Code task Polar answers itself, handed to Chat: what to send, on which
 *  model, about which repository (none for an empty workspace). */
export interface PolarTask {
    text: string;
    choice: ModelChoice;
    code: PolarCodeTask | null;
}

const MODE_KEY = "polar.mode";
const OVERVIEW_KEY = "polar.code.overview.v2";
/** The persona picked last ("agent:<id>"), or a pick kept before Code was
 *  model-first, migrated on the first load (`migrateStoredAgent`). */
const AGENT_KEY = CODE_AGENT_STORAGE_KEY;
/** The repository picked last, "No repository" included, for the next visit. */
const REPO_KEY = "polar.code.repo";
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

/** How often an open Code asks again for its spare, well inside the spare's
 *  shortest expiry so it never lapses while somebody is still typing. */
const WARM_EVERY_MS = 50_000;

/**
 * Keep a session machine waiting while Code is open (`session-spares`): asked
 * once on opening and again while the tab is in view. A spare is nearly free
 * while it waits, and it is what lets a sent message start in seconds. Best
 * effort - a failure only means the session starts the ordinary way.
 */
function useSpareWarmup(enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        const ask = () => {
            if (document.visibilityState !== "visible") return;
            void fetch("/api/polar/code/warm", { method: "POST" }).catch(() => undefined);
        };
        ask();
        const timer = window.setInterval(ask, WARM_EVERY_MS);
        document.addEventListener("visibilitychange", ask);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", ask);
        };
    }, [enabled]);
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

    // Before the first paint, so a panel that was left on Code opens on it
    // with the access it had, instead of drawing Chat for a frame and
    // swapping (test/polar/code-start-layout.test.tsx).
    useLayoutEffect(() => {
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

/** The choices read last in this tab, so the side panel and the full page open
 *  on them at once instead of filling in a moment later. Read again behind. */
let choicesCache: Choices | null = null;
/** Told to every open Code when the repository pick changes in this tab; the
 *  `storage` event tells the other tabs. */
const REPO_EVENT = "polar:code-repo";

/** The repository a Code opens on: the one picked last when the choices are
 *  already known, else nothing until they are. */
export function initialRepo(cached: Choices | null, stored: string | null): string {
    if (!cached || !stored) return "";
    return stored === NO_REPO || cached.repos.some((repo) => repo.id === stored) ? stored : "";
}

/** What a new task offers - repositories and agents - read once Code may start
 *  one, and again on a refresh (after adding repositories on GitHub). */
function useCodeChoices(canStart: boolean) {
    // The cache is empty on a page's first load, so this matches the server's
    // render; it is only filled on screens opened after it.
    const [choices, setChoices] = useState<Choices | null>(() => choicesCache);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [repoId, setRepoId] = useState(() =>
        initialRepo(choicesCache, choicesCache ? readStored(REPO_KEY) : null)
    );
    // The pick as of now, for a refresh that lands after it changed.
    const picked = useRef(repoId);
    useEffect(() => {
        picked.current = repoId;
    }, [repoId]);
    const [pick, setPick] = useState<CodePick | null>(null);
    const [persona, setPersona] = useState<string | null>(null);

    const load = useCallback(() => {
        setRefreshing(true);
        void runAction(() => readPoll<Choices | null>("/api/polar/code/choices", {}), setError)
            .then((loaded) => {
                if (!loaded) return;
                setError(null);
                choicesCache = loaded;
                setChoices(loaded);
                // A pick that is gone (a repository disconnected meanwhile) falls back.
                // One past the first page is asked about by id rather than taken
                // for gone because the page does not hold it.
                const fallback = loaded.repos[0]?.id ?? NO_REPO;
                // The first load starts on the one picked last, checked like any pick.
                const current = picked.current || readStored(REPO_KEY) || "";
                if (current === "") setRepoId(fallback);
                else if (current === NO_REPO || loaded.repos.some((repo) => repo.id === current))
                    setRepoId((now) => now || current);
                else
                    void readRepo(current)
                        .then((found) => {
                            setRepoId((now) =>
                                !found && (now === current || now === "")
                                    ? fallback
                                    : now || current
                            );
                        })
                        .catch(() => setRepoId((now) => now || fallback));
                // The pick kept last; one kept as an agent before Code was
                // model-first maps to its source; else Automatic, which needs
                // nothing started. A persona opened from the agent settings
                // ("New task") brings its own pick.
                const legacy = readStored(AGENT_KEY) ?? "";
                const stored = readStoredPick(readStored(CODE_PICK_STORAGE_KEY));
                const migrated = migrateStoredAgent(legacy, loaded.code?.sources ?? [], loaded.code?.personas ?? []);
                const opened = legacy.startsWith("agent:") ? migrated : null;
                setPersona((current) => current ?? opened?.persona ?? null);
                setPick(
                    (current) => current ?? opened?.pick ?? stored ?? migrated.pick ?? AUTOMATIC_PICK
                );
                if (!stored && migrated.pick) {
                    writeStored(CODE_PICK_STORAGE_KEY, JSON.stringify(migrated.pick));
                }
            })
            .finally(() => setRefreshing(false));
    }, []);

    useEffect(() => {
        if (canStart) load();
    }, [canStart, load]);

    const choosePick = useCallback((next: CodePick) => {
        setPick(next);
        writeStored(CODE_PICK_STORAGE_KEY, JSON.stringify(next));
    }, []);
    const choosePersona = useCallback((id: string | null) => {
        setPersona(id);
        writeStored(AGENT_KEY, id ? customAgentKey(id) : POLAR_RUNTIME);
    }, []);

    const pickRepo = useCallback((id: string) => {
        setRepoId(id);
        writeStored(REPO_KEY, id);
        window.dispatchEvent(new CustomEvent(REPO_EVENT, { detail: id }));
    }, []);
    // A pick made in another Code - the full page, the side panel, another
    // tab - is this one's too, "No repository" like any other.
    useEffect(() => {
        const follow = (id: unknown) => {
            if (typeof id === "string" && id !== "") setRepoId(id);
        };
        const local = (event: Event) => follow((event as CustomEvent<unknown>).detail);
        const other = (event: StorageEvent) => {
            if (event.key === REPO_KEY) follow(event.newValue);
        };
        window.addEventListener(REPO_EVENT, local);
        window.addEventListener("storage", other);
        return () => {
            window.removeEventListener(REPO_EVENT, local);
            window.removeEventListener("storage", other);
        };
    }, []);

    return {
        choices,
        error,
        refreshing,
        load,
        repoId,
        setRepoId: pickRepo,
        pick,
        setPick: choosePick,
        persona,
        setPersona: choosePersona
    };
}

/**
 * The Code side, in Chat's own frame: a new task opens on the same welcome as a
 * new chat, and a session reads as a chat thread with the composer under it.
 * Where the task works is a chip under the composer; the history is the
 * sidebar's, beside the chats.
 */
export function PolarCodeView({
    code,
    fullPage,
    avatar,
    voiceKit,
    providers,
    onPolarTask
}: {
    code: PolarCodeState;
    fullPage: boolean;
    /** Polar's avatar at the welcome's size, as Chat draws it. */
    avatar: ReactNode;
    /** Chat's microphone, so dictation works here exactly as it does there. */
    voiceKit: PolarVoiceKit;
    /** Chat's providers and models, for an agent that takes one. */
    providers: ModelSelectorProvider[] | null;
    /** A task Polar answers itself, handed to Chat with its repository. */
    onPolarTask: (task: PolarTask) => void;
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
                onOpen={code.open}
            />
        );

    const composer = (
        <CodeStart
            canStart={canStart}
            pending={code.access === null}
            choices={picks.choices}
            choicesError={picks.error}
            repoId={picks.repoId}
            onRepo={(id) => {
                // A branch belongs to the repository it was picked in.
                if (id !== picks.repoId) setBaseRef("");
                picks.setRepoId(id);
            }}
            onRefresh={picks.load}
            refreshing={picks.refreshing}
            baseRef={baseRef}
            onBaseRef={setBaseRef}
            pick={picks.pick}
            onPick={picks.setPick}
            persona={picks.persona}
            onPersona={picks.setPersona}
            voiceKit={voiceKit}
            providers={providers}
            onStarted={started}
            onPolarTask={onPolarTask}
        />
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

/** Chat's providers, kept to Polar's own list when it must keep to it. */
function narrowProviders(
    providers: ModelSelectorProvider[] | null,
    policy: EnginePolicy | null
): ModelSelectorProvider[] | null {
    if (!providers || !policy || policy.modelPolicy !== "required" || policy.models.length === 0) {
        return providers;
    }
    return providers
        .map((provider) => ({
            ...provider,
            models: provider.models.filter((model) =>
                policy.models.some(
                    (entry) => entry.provider === model.provider && entry.model === model.model
                )
            )
        }))
        .filter((provider) => provider.models.length > 0);
}

/** A new task: Chat's composer, with one model picker where Chat has its own. */
function CodeStart({
    canStart,
    pending,
    choices,
    choicesError,
    repoId,
    onRepo,
    onRefresh,
    refreshing,
    baseRef,
    onBaseRef,
    pick: picked,
    onPick,
    persona: personaId,
    onPersona,
    voiceKit,
    providers,
    onStarted,
    onPolarTask
}: {
    canStart: boolean;
    pending: boolean;
    choices: Choices | null;
    choicesError: string | null;
    repoId: string;
    onRepo: (id: string) => void;
    onRefresh: () => void;
    refreshing: boolean;
    baseRef: string;
    onBaseRef: (branch: string) => void;
    pick: CodePick | null;
    onPick: (pick: CodePick) => void;
    persona: string | null;
    onPersona: (id: string | null) => void;
    voiceKit: PolarVoiceKit;
    /** Chat's own list of providers and models, for an agent that takes one. */
    providers: ModelSelectorProvider[] | null;
    onStarted: (id: string, text: string) => void;
    onPolarTask: (task: PolarTask) => void;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [gap, setGap] = useState<GithubAppGap | null>(null);
    const [busy, startTransition] = useTransition();
    const parts = useCodeComposerParts(busy);
    // Full access until the stored pick is read: the server render has no storage.
    const [mode, setMode] = useState<core.SessionPermissionMode>("full");
    useEffect(() => setMode(readPermissionMode(readStored(PERMISSION_MODE_KEY))), []);
    const chooseMode = (next: core.SessionPermissionMode) => {
        setMode(next);
        writeStored(PERMISSION_MODE_KEY, next);
    };
    // What the task starts from besides the words: an issue of the repository
    // (dropped when the repository changes) and one of the person's skills.
    const [issuePick, setIssue] = useState<{ repoId: string; issue: PickedIssue } | null>(null);
    const issue = issuePick?.repoId === repoId ? issuePick.issue : null;
    const [skill, setSkill] = useState<string | null>(null);
    const own = usePolarCommands().commands;
    const slash = useCodeSlash({
        value: prompt,
        onValueChange: setPrompt,
        skills: choices?.skills ?? [],
        own,
        onSkill: setSkill
    });
    // What was just sent, shown at once as the first message of the session
    // while the machine for it comes up, rather than a composer that only
    // greys out for the minute that can take.
    const [sent, setSent] = useState<string | null>(null);
    // Again after a send: the next session gets a spare of its own.
    useSpareWarmup(sent === null);

    // The sources: the person's accounts and keys from the server, and Polar's
    // own keys from the chat's list (an API key already listed is not twice).
    const workspace = repoId === NO_REPO;
    const polarSources = useMemo(
        () =>
            polarSourcesFor(
                narrowProviders(providers, choices?.code?.polarPolicy ?? null) ?? [],
                choices?.code?.sources ?? []
            ),
        [providers, choices]
    );
    const sources: CodeSource[] | null = choices
        ? [...(choices.code?.sources ?? []), ...polarSources]
        : null;
    const persona = choices?.code?.personas.find((entry) => entry.id === personaId) ?? null;
    const current = picked ?? AUTOMATIC_PICK;
    const auto = isAutomaticPick(current);
    const source = auto ? null : (sources?.find((entry) => entry.key === current.source) ?? null);
    // A session is needed for anything Polar's chat cannot take: an issue, a
    // skill, files, or one of the person's agents.
    const needsSession =
        issue !== null || skill !== null || persona !== null || parts.uploads.ids.length > 0;
    // Automatic with a session runs on the first model of Polar's keys.
    const first = auto && needsSession ? (polarSources[0] ?? null) : null;
    const runOn = source ?? first;
    const runModel = source
        ? { provider: current.provider, model: current.model }
        : first
          ? { provider: first.models[0]?.provider ?? "", model: first.models[0]?.model ?? null }
          : null;
    const resolved = runOn
        ? resolveCodeEngine(runOn, runModel, { needsSession })
        : auto && sources !== null && polarSources.length > 0
          ? { cli: POLAR_RUNTIME, accountId: null, useMachineLogin: false, modelChoice: null }
          : null;
    const polar = resolved?.cli === POLAR_RUNTIME;
    const tool = resolved && !polar ? resolved.cli : null;
    // Only a tool whose questions are answered from here is given a mode.
    const asksMode = tool !== null && core.takesPermissionMode(tool);
    const model: ModelChoice | null = polar
        ? auto
            ? automaticChoice()
            : runOn && runModel?.model
              ? {
                    kind: "language",
                    provider: runOn.polarProvider ?? runModel.provider,
                    model: runModel.model,
                    intelligence: "balanced",
                    payer: runOn.payer
                }
              : null
        : null;
    const fetchedName = useRepoName(repoId, choices?.repos ?? []);
    const repoName = choices?.repos.find((repo) => repo.id === repoId)?.name ?? fetchedName;
    const noModel = choices !== null && providers !== null && resolved === null;
    const ready =
        canStart &&
        choices !== null &&
        resolved !== null &&
        (!polar || model !== null) &&
        (!polar || workspace || repoName !== null) &&
        !parts.uploads.uploading &&
        !parts.uploads.failed &&
        // An agent can start from the issue alone; Polar answers words.
        (prompt.trim().length > 0 || (!polar && issue !== null));

    const submit = () => {
        if (!ready || busy) return;
        if (polar && model) {
            const text = slash.expand(prompt.trim());
            setPrompt("");
            onPolarTask({
                text,
                choice: model,
                code: workspace || !repoName ? null : { repo: repoName, branch: baseRef.trim() }
            });
            return;
        }
        if (!tool || !runOn) return;
        setError(null);
        setGap(null);
        const text = slash.expand(prompt.trim());
        const started = { issue, skill };
        setSent(text || (issue ? `#${issue.number} ${issue.title}` : ""));
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
                            title: titleFromPrompt(
                                text || (issue ? `#${issue.number} ${issue.title}` : "")
                            ),
                            // The source and model; the server resolves the
                            // engine again from this person's own sources.
                            pick: {
                                source: runOn.key,
                                provider: runModel?.provider ?? "",
                                model: runModel?.model ?? null
                            },
                            // One of the person's own agents: its instructions
                            // lead the task (`polarCodeStart`).
                            agentId: persona?.id ?? null,
                            attachments: parts.uploads.ids,
                            place: "local",
                            sharedHome: false,
                            hostId: null,
                            baseRef: workspace ? "" : baseRef.trim(),
                            prompt: text,
                            taskId: null,
                            unattended: null,
                            permissionMode: asksMode ? mode : null,
                            issueNumber: workspace ? null : (started.issue?.number ?? null),
                            skill: started.skill,
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
                    setIssue(null);
                    setSkill(null);
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
            <div className="relative">
            {slash.list}
            <PolarComposer
                textareaProps={slash.textareaProps}
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
                sendable={!polar && issue !== null}
                picker={
                    canStart || pending ? (
                        <>
                            <CodeModelPicker
                                sources={sources}
                                value={current}
                                onChange={onPick}
                                automatic={polarSources.length > 0}
                                disabled={busy || pending}
                            />
                            {asksMode ? (
                                <PermissionModePicker
                                    value={mode}
                                    onChange={chooseMode}
                                    disabled={busy}
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
                    sendLabel: polar ? t("actions.send") : t("code.start"),
                    stopLabel: t("code.start"),
                    onStop: () => undefined
                }}
            />
            </div>
            {/* Drawn from the first paint, switched off until access and the
                choices are read, so nothing under the composer moves when they
                land (test/polar/code-start-layout.test.tsx). */}
            {canStart || pending ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
                    <CodeWhereChip
                        choices={choices}
                        repoId={repoId}
                        onRepo={onRepo}
                        onRefresh={onRefresh}
                        refreshing={refreshing}
                        branch={baseRef}
                        onBranch={onBaseRef}
                        disabled={busy || pending}
                    />
                    {repoId !== NO_REPO ? (
                        <CodeIssueChip
                            repoId={repoId}
                            issue={issue}
                            onIssue={(next) => setIssue(next ? { repoId, issue: next } : null)}
                            disabled={busy || repoId === ""}
                        />
                    ) : null}
                    <CodeSkillChip
                        skills={choices?.skills ?? []}
                        skill={skill}
                        onSkill={setSkill}
                        disabled={busy || choices === null}
                    />
                    {(choices?.code?.personas.length ?? 0) > 0 ? (
                        <CodePersonaChip
                            personas={choices?.code?.personas ?? []}
                            persona={persona?.id ?? null}
                            onPersona={(id) => {
                                onPersona(id);
                                // An agent set up on a model opens on it.
                                const chosen = choices?.code?.personas.find((entry) => entry.id === id);
                                if (chosen?.pick) onPick(chosen.pick);
                            }}
                            disabled={busy}
                        />
                    ) : null}
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
            {choices !== null && choices.repos.length === 0 ? (
                <Notice>
                    {t("code.noRepos")}{" "}
                    <Link href="/automations/code-review" className="text-primary hover:underline">
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
    voiceKit,
    onOpen
}: {
    sessionId: string;
    /** What the task was started with here, shown until the session has it. */
    firstPrompt: string | null;
    canPrompt: boolean;
    fullPage: boolean;
    voiceKit: PolarVoiceKit;
    /** Open another session in this thread's place: the one a stopped session
     *  is continued in. */
    onOpen: (sessionId: string) => void;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    // Undefined while the first answer is on its way; null when it is not there.
    const [thread, setThread] = useState<PolarCodeThread | null | undefined>(undefined);
    // The files, the changes and the terminal, beside the thread.
    const [workspace, setWorkspace] = useState(false);
    const [failed, setFailed] = useState(false);
    const [reply, setReply] = useState("");
    const own = usePolarCommands().commands;
    // A running session has its skill already; only the person's commands apply.
    const slash = useCodeSlash({ value: reply, onValueChange: setReply, skills: [], own, onSkill: null });
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
        const text = slash.expand(reply.trim());
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

    /** Carry on in a new session on the same branch, with the conversation so
     *  far where the agent can take it, and open it here. */
    const carryOn = () => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ id?: string; error?: string }>("/api/polar/code/continue", { sessionId }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.id) onOpen(result.id);
                else setError(result.error ?? t("code.continueFailed"));
            });
        });
    };

    const dock = !thread ? null : !live ? (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Notice>{t("code.ended")}</Notice>
                {thread.canManage && canPrompt ? (
                    <Button type="button" size="sm" variant="outline" onClick={carryOn} disabled={busy}>
                        {t("code.continue")}
                    </Button>
                ) : null}
            </div>
            {error ? <Notice error>{error}</Notice> : null}
        </div>
    ) : !canPrompt ? (
        <Notice>{t("code.readOnly")}</Notice>
    ) : (
        <div className="flex min-w-0 flex-col gap-2">
            {thread.permission ? (
                <CodePermission
                    key={thread.permission.id}
                    asked={thread.permission}
                    onAnswered={read}
                />
            ) : null}
            {thread.context ? (
                // How full the agent's own conversation is: the tool compacts it
                // itself, so there is nothing here to press.
                <ContextBar
                    used={thread.context.used}
                    draft={estimateTokens(reply)}
                    window={thread.context.window}
                    canCompact={false}
                    onCompact={null}
                />
            ) : null}
            <div className="relative">
            {slash.list}
            <PolarComposer
                textareaProps={slash.textareaProps}
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
            </div>
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
                {thread?.canManage ? (
                    <button
                        type="button"
                        onClick={() => setWorkspace(true)}
                        aria-label={t("code.pane.open")}
                        title={t("code.pane.open")}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                    >
                        <PanelRight className="size-4" />
                    </button>
                ) : null}
                {thread?.canManage ? <SessionTools session={thread.view} /> : null}
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
            {thread?.canManage ? (
                <PolarCodeWorkspace
                    open={workspace}
                    onOpenChange={setWorkspace}
                    session={thread.view}
                    live={live}
                />
            ) : null}
        </>
    );
}
/** The agent's question, put where the reply goes: what it wants to do, and
 *  the three answers its own prompt has. */
function CodePermission({
    asked,
    onAnswered
}: {
    asked: PendingPermission;
    onAnswered: () => void;
}) {
    const t = useTranslations("polar");
    const [error, setError] = useState<string | null>(null);
    const [busy, startTransition] = useTransition();
    const answer = (choice: "allow" | "always" | "deny") => {
        setError(null);
        startTransition(() => {
            void runAction(
                () =>
                    sendAction<{ status?: string; error?: string }>(
                        "/api/agents/sessions/permission",
                        { requestId: asked.id, choice }
                    ),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                onAnswered();
            });
        });
    };
    return (
        <section
            aria-label={t("code.permission.title")}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3"
        >
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 truncate">
                    {t("code.permission.asks", { tool: asked.tool })}
                </span>
            </p>
            {asked.detail ? (
                <CodeView
                    value={asked.detail}
                    language={asked.tool === "Bash" ? "bash" : "plaintext"}
                    label={asked.tool}
                    className="max-h-40 min-w-0 text-xs"
                />
            ) : null}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Button type="button" size="sm" onClick={() => answer("allow")} disabled={busy}>
                    {t("code.permission.allow")}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => answer("always")}
                    disabled={busy}
                >
                    {t("code.permission.always")}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => answer("deny")}
                    disabled={busy}
                >
                    {t("code.permission.deny")}
                </Button>
            </div>
            {error ? <Notice error>{error}</Notice> : null}
        </section>
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
