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
import { REPLY_TO_KEY, readStored, takeStored, writeStored } from "@/lib/polar/stored";
import { CODE_AGENT_STORAGE_KEY, customAgentKey } from "@/lib/polar/agents/shared";
import type { EnginePolicy } from "@/lib/polar/agents/code-sources";
import {
    AUTOMATIC_PICK,
    CODE_PICK_STORAGE_KEY,
    isAutomaticPick,
    liveSourceFor,
    migrateStoredAgent,
    polarSourcesFor,
    POLAR_RUNTIME,
    readStoredPick,
    resolveCodeEngine,
    type CodePick,
    type CodeSource
} from "@/lib/polar/agents/code-sources";
import { CodeModelPicker } from "@/components/polar/code-model-picker";
import { neighbourSession, useCodeKeys, useStopTwice } from "@/components/polar/polar-code-keys";
import { useCodeTheme } from "@/components/polar/polar-display";
import { CodeAccountSwitch } from "@/components/polar/code-account-switch";
import { CodeAgentSwitch, canSwitchAgent } from "@/components/polar/code-agent-switch";
import { KNOWN_ENGINES } from "@/components/polar/session-engine";
import { CodeStartOptions } from "@/components/polar/code-start-options";
import { engineOptions, NATIVE_ENGINE } from "@/lib/polar/native/engine-choice";
import { CodeView } from "@/components/json-view";
import { Work } from "@/components/polar/elements/work";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { BusyVerb } from "@/components/polar/elements/busy-verb";
import { CodeBootLine } from "@/components/polar/polar-code-boot";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useDisplayFormat } from "@/components/display-format";
import { Button, cn, CopyIcon, SegmentedControl, useCopied, useToast } from "@polaris/ui";
import { ConversationEmptyState } from "@/components/polar/elements/conversation";
import { PolarThreadFrame, PolarWelcome } from "@/components/polar/polar-layout";
import { Suggestion, Suggestions } from "@/components/polar/elements/suggestion";
import { usePhraseMoment } from "@/components/polar/use-phrase-moment";
import * as greeting from "@/lib/polar/greeting";
import {
    Message,
    MessageAction,
    MessageActions,
    MessageContent,
    MessageResponse
} from "@/components/polar/elements/message";
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useId,
    useMemo,
    useRef,
    useState,
    useTransition,
    type Dispatch,
    type ReactNode,
    type RefObject,
    type SetStateAction
} from "react";
import type { GithubAppGap } from "@/lib/github-app-reach";
import type { VoiceNotice } from "@/components/polar/polar-voice";
import { GithubAppGapNotice } from "@/components/github-app-gap";
import * as core from "@polaris/core";
import { codePlaceTarget, placeOf, type CodePlaceTarget } from "@/lib/polar/code-place";
import * as acpProviders from "@/lib/agents/acp/providers";
import * as drafts from "@/lib/agents/draft-frames";
import { automaticChoice, type ModelChoice } from "@/lib/polar/shared";
import { usePolarUploads } from "@/components/polar/polar-uploads";
import { POLAR_ATTACHMENT_MOST, POLAR_ATTACHMENT_TYPES, POLAR_COMMAND_PROMPT_MAX } from "@/lib/polar/shared";
import {
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import { PolarComposer, type PolarVoiceKit } from "@/components/polar/polar-composer";
import { CodeVoiceCall, type VoiceWatch } from "@/components/polar/code-voice-call";
import type { RealtimeLink } from "@/lib/polar/realtime-link";
import { parseVoiceDelegation } from "@/lib/polar/voice-handoff";
import { useCodeSlash } from "@/components/polar/polar-code-slash";
import * as codeCommands from "@/lib/polar/code-commands";
import * as goals from "@/lib/polar/goals";
import { goalStateKey, PolarGoalBar } from "@/components/polar/polar-goal";
import { CommandForm, usePolarCommands, type CommandDraft } from "@/components/polar/polar-commands";
import { ContextBar } from "@/components/polar/polar-context";
import * as codeStatus from "@/lib/polar/code-status";
import {
    CodeContextCard,
    CodeExportMenu,
    CodeQueuedList,
    CodeStatusLine,
    downloadTranscript
} from "@/components/polar/polar-code-status";
import { estimateTokens } from "@/lib/polar/compaction";
import {
    CodeIssueChip,
    CodeSkillTag,
    CodePersonaChip,
    type PickedIssue,
    CodeWhereChip,
    CodeSessionBar,
    NO_REPO,
    CODE_EFFORT_KEY,
    codeEffort,
    PERMISSION_MODE_KEY,
    SURFACE_KEY,
    CODE_PLACE_KEY,
    CodePlacePicker,
    CodeFolderChip,
    useCodeComputers,
    useThisComputer,
    readCodeEffort,
    PermissionModePicker,
    SessionSurfacePicker,
    readPermissionMode,
    readRepo,
    REPOS_ROUTE,
    useRepoName
} from "@/components/polar/polar-code-context";
import { githubRepoOf } from "@/lib/agents/repo-ref";
import type { PendingPermission } from "@/lib/agents/session-permissions";
import { CodeAskCard, CodeTodos } from "@/components/polar/polar-code-asks";
import { CodeSubagents } from "@/components/polar/polar-code-subagents";
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
import {
    BookmarkPlus,
    Code2,
    Keyboard,
    MessageSquare,
    PanelRight,
    Pencil,
    Reply,
    RotateCcw,
    RotateCw,
    ShieldCheck,
    Square,
    TriangleAlert,
    Volume2,
    X
} from "lucide-react";
import * as answerActions from "@/components/polar/polar-answer-actions";
import type { PolarMark } from "@/lib/polar/answer-feedback";
import { pickedContext, PICKS_MAX, type PickedElement } from "@/lib/agents/preview-picker";
import { PickedChips } from "@/components/preview/picked-chips";
import dynamic from "next/dynamic";

/** `/memory`'s panel: loaded when it is opened, with the server actions it calls. */
const RepoMemorySection = dynamic(
    () =>
        import("@/app/(app)/automations/code-review/repo-memory-section").then(
            (module) => module.RepoMemorySection
        ),
    { ssr: false }
);

/** Loaded when somebody asks for the shortcuts: the settings are not needed to read a thread. */
const ShortcutsDialog = dynamic(
    () => import("@/components/shortcuts/shortcuts-dialog").then((module) => module.ShortcutsDialog),
    { ssr: false }
);

/** Loaded after the thread, not with it: its terminal is not needed to read one. */
const PolarCodeWorkspace = dynamic(
    () => import("@/components/polar/polar-code-workspace").then((module) => module.PolarCodeWorkspace),
    { ssr: false }
);

/** A session's pull request, its Share button and Continue on phone, in the
 *  Agents app's words.
 *  Drawn only where somebody can steer the session, so loaded there. */
const SessionTools = dynamic(
    () =>
        Promise.all([
            import("@/components/agents/sessions/session-pull"),
            import("@/components/agents/sessions/share-button"),
            import("@/components/i18n/client-namespaces"),
            import("@/components/agents/sessions/continue-button")
        ]).then(([pull, share, i18n, phone]) =>
            function SessionTools({ session }: { session: SessionView }) {
                return (
                    <i18n.ClientMessages namespaces={["agents"]} fallback={null}>
                        {session.pullRequest ? <pull.SessionPull session={session} /> : null}
                        <share.SessionShareButton sessionId={session.id} title={session.title} />
                        <phone.ContinueOnPhoneButton sessionId={session.id} />
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

/** Call `onChange` whenever the session changes on the server, and `onDraft`
 *  with each frame of the agent's message while it is written, until the
 *  returned function is called. Silent where streams are not available. */
export function watchSession(
    sessionId: string,
    onChange: () => void,
    onDraft?: (frame: drafts.DraftFrame) => void
): () => void {
    if (typeof EventSource === "undefined") return () => undefined;
    const source = new EventSource(`/api/agents/sessions/${encodeURIComponent(sessionId)}/live`);
    source.addEventListener("change", onChange);
    if (onDraft)
        source.addEventListener("draft", (event) => {
            let parsed: unknown;
            try {
                parsed = JSON.parse((event as MessageEvent<string>).data);
            } catch {
                return;
            }
            const frame = drafts.draftFrameSchema.safeParse(parsed);
            if (frame.success) onDraft(frame.data);
        });
    return () => source.close();
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

/**
 * What can be asked again: the person's last message and, when the agent
 * answered it, that answer. Polaris's own lines are passed over. An agent
 * session's conversation cannot be cut back, so only the last turn is retried,
 * as a new one. Pure.
 */
export function codeRetryOf(entries: readonly PolarCodeEntry[]): {
    ask: PolarCodeEntry | null;
    answer: PolarCodeEntry | null;
} {
    let answer: PolarCodeEntry | null = null;
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!;
        if (entry.type !== "message" || entry.role === "system") continue;
        if (entry.role === "user") return { ask: entry, answer };
        answer ??= entry;
    }
    return { ask: null, answer: null };
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
                // Only a repository already set up: one listed from GitHub is set
                // up when somebody picks it, never by opening Code.
                const fallback = loaded.repos.find((repo) => !githubRepoOf(repo.id))?.id ?? NO_REPO;
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
/** A draft both of Polar's composers write: what is typed on a new
 *  conversation stays when Chat and Code are switched. */
export interface PolarSharedDraft {
    readonly value: string;
    readonly set: Dispatch<SetStateAction<string>>;
}

export function PolarCodeView({
    code,
    fullPage,
    draft = null,
    avatar,
    voiceKit,
    providers,
    onPolarTask,
    onHistory,
    onToggleHistory
}: {
    code: PolarCodeState;
    fullPage: boolean;
    /** Chat's draft, written here too while both sides are a new conversation. */
    draft?: PolarSharedDraft | null;
    /** Polar's avatar at the welcome's size, as Chat draws it. */
    avatar: ReactNode;
    /** Chat's microphone, so dictation works here exactly as it does there. */
    voiceKit: PolarVoiceKit;
    /** Chat's providers and models, for an agent that takes one. */
    providers: ModelSelectorProvider[] | null;
    /** A task Polar answers itself, handed to Chat with its repository. */
    onPolarTask: (task: PolarTask) => void;
    /** Shows the history, for "/resume". */
    onHistory: () => void;
    /** Shows or hides the history, for its shortcut; "/resume" when not given. */
    onToggleHistory?: () => void;
}) {
    const t = useTranslations("polar");
    const canStart = code.access === "manage";
    const keysRoot = useRef<HTMLDivElement>(null);
    const theme = useCodeTheme();
    const [keysHelp, setKeysHelp] = useState(false);
    const sessionIds = (code.history.rows ?? []).map((row) => row.id);
    const step = (direction: 1 | -1) => () => {
        const next = neighbourSession(sessionIds, code.selected, direction);
        if (next === null) return false;
        code.open(next);
    };
    useCodeKeys(keysRoot, fullPage, {
        "code.newSession": () => code.open(null),
        "code.nextSession": step(1),
        "code.previousSession": step(-1),
        "code.toggleHistory": () => (onToggleHistory ?? onHistory)(),
        "code.help": () => setKeysHelp(true)
    });
    const frame = (children: ReactNode) => (
        <div ref={keysRoot} data-code-theme={theme} className="contents">
            {children}
            {keysHelp ? <ShortcutsDialog app="code" open onOpenChange={setKeysHelp} /> : null}
        </div>
    );
    const picks = useCodeChoices(canStart);
    // The new task's words: Chat's draft while both are a new conversation,
    // else this view's own, so a suggested prompt can fill either.
    const [ownDraft, setOwnDraft] = useState("");
    const typed: PolarSharedDraft = draft ?? { value: ownDraft, set: setOwnDraft };
    const moment = usePhraseMoment();
    const promptKeys = greeting.pickCodePrompts({ seed: moment?.seed ?? 0 });
    const [baseRef, setBaseRef] = useState("");
    // The words a task was started with, for the session they started: they are
    // stored on it only once the agent is up, and until then its thread would
    // otherwise open empty.
    const [opening, setOpening] = useState<{ id: string; text: string } | null>(null);
    // A voice call, kept here so it follows the person from session to session.
    const [call, setCall] = useState<CodeCall | null>(null);
    useEffect(() => {
        if (!code.selected) setCall(null);
    }, [code.selected]);
    // A realtime link ends with the call, or when the call goes back to standard voice.
    const realtime = call?.realtime ?? null;
    useEffect(() => () => realtime?.close(), [realtime]);
    const started = (id: string, text: string) => {
        setOpening({ id, text });
        code.open(id);
        code.refresh();
    };

    if (code.selected)
        return frame(
            <CodeThread
                key={code.selected}
                keysRoot={keysRoot}
                onKeysHelp={() => setKeysHelp(true)}
                sessionId={code.selected}
                firstPrompt={opening?.id === code.selected ? opening.text : null}
                canPrompt={canStart}
                fullPage={fullPage}
                voiceKit={voiceKit}
                providers={providers}
                call={call}
                onCall={setCall}
                onOpen={code.open}
                onNew={() => code.open(null)}
                onHistory={onHistory}
                onRename={code.history.rename}
            />
        );

    const composer = (
        <CodeStart
            draft={typed}
            keysRoot={keysRoot}
            fullPage={fullPage}
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
            onHistory={onHistory}
        />
    );
    if (fullPage)
        return frame(
            <PolarWelcome avatar={avatar} title={t("code.heading")}>
                {composer}
                {canStart ? (
                    <Suggestions>
                        {promptKeys.map((key) => (
                            <Suggestion
                                key={key}
                                suggestion={t(`code.prompts.${key}` as "code.prompts.fixBug")}
                                onClick={(text) => typed.set(text)}
                            />
                        ))}
                    </Suggestions>
                ) : null}
            </PolarWelcome>
        );
    return frame(
        <PolarThreadFrame fullPage={false} dock={composer}>
            <ConversationEmptyState icon={avatar} description={t("code.heading")} />
        </PolarThreadFrame>
    );
}

/** Puts the cursor in a composer, at the end of what is written. */
function focusInput(id: string): void {
    const box = document.getElementById(id);
    if (!(box instanceof HTMLTextAreaElement)) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
}

/** A voice call open on Code: what it says first when it moved to a session. */
interface CodeCall {
    readonly greeting: string | null;
    /** Replies it was waiting for when it moved. */
    readonly watching: readonly VoiceWatch[];
    /** Realtime voice, kept here so showing another session does not drop it. */
    readonly realtime?: RealtimeLink | null;
}

/** Code's commands in the composer that starts a task. */
const START_COMMANDS = codeCommands.codeCommandsFor("start", null);

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

/** The provider refused the account the agent signs in with: which one, and
 *  where to link it again. Every turn fails until it is. */
export function SignInRefusedNotice({ account }: { account: string | null }) {
    const t = useTranslations("polar");
    return (
        <Notice error>
            {account ? t("code.signInRefused", { account }) : t("code.signInRefusedUnnamed")}{" "}
            <Button asChild size="sm" variant="outline" className="ms-1 align-middle">
                <Link href="/polar/settings/providers">{t("code.linkAgain")}</Link>
            </Button>
        </Notice>
    );
}

/** Chat's composer as Code takes it: the same files (copied into the session's
 *  working directory) and the same microphone. A voice call needs a session to
 *  talk to, so a task that has not started says so on the button. */
function useCodeComposerParts(
    busy: boolean,
    call: { readonly disabled: boolean; readonly onOpen: () => void } | null = null
) {
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
        voiceMode: call ?? { refusal: t("code.voiceNeedsSession") }
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
    draft,
    keysRoot,
    fullPage,
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
    onPolarTask,
    onHistory
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
    onHistory: () => void;
    draft: PolarSharedDraft | null;
    /** The Code view, where its keys are listened for. */
    keysRoot: RefObject<HTMLDivElement | null>;
    fullPage: boolean;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    // Chat's draft when there is one to share, so text typed before switching
    // between Chat and Code is still there after.
    const [ownPrompt, setOwnPrompt] = useState("");
    const prompt = draft ? draft.value : ownPrompt;
    const setPrompt = draft ? draft.set : setOwnPrompt;
    const [modelOpen, setModelOpen] = useState(false);
    useCodeKeys(keysRoot, fullPage, {
        "code.focusComposer": () => focusInput(inputId),
        "code.commands": () => {
            setPrompt("/");
            focusInput(inputId);
        },
        "code.modelPicker": () => {
            if (!canStart) return false;
            setModelOpen(true);
        }
    });
    // The engine for this task only; null follows the person's setting.
    const [engine, setEngine] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [gap, setGap] = useState<GithubAppGap | null>(null);
    // A repository picked from GitHub that could not be set up, and what kept it.
    const [repoGap, setRepoGap] = useState<{ id: string; gap: GithubAppGap } | null>(null);
    const [connecting, setConnecting] = useState(false);
    const [busy, startTransition] = useTransition();
    const parts = useCodeComposerParts(busy);
    // Full access until the stored pick is read: the server render has no storage.
    const [mode, setMode] = useState<core.SessionPermissionMode>("full");
    useEffect(() => setMode(readPermissionMode(readStored(PERMISSION_MODE_KEY))), []);
    const chooseMode = (next: core.SessionPermissionMode) => {
        setMode(next);
        writeStored(PERMISSION_MODE_KEY, next);
    };
    // Terminal or Chat, picked last; read after mount for the same reason.
    const [surface, setSurface] = useState<acpProviders.SessionSurface>("terminal");
    useEffect(() => setSurface(acpProviders.readSurface(readStored(SURFACE_KEY))), []);
    const chooseSurface = (next: acpProviders.SessionSurface) => {
        setSurface(next);
        writeStored(SURFACE_KEY, next);
    };
    // Where the task runs: Polaris, or one of the person's own computers. The
    // stored pick counts only while that computer is still listed and online.
    const computers = useCodeComputers(canStart);
    const [placePick, setPlacePick] = useState<string | null>(null);
    useEffect(() => setPlacePick(readStored(CODE_PLACE_KEY) || null), []);
    const choosePlace = (next: string | null) => {
        setPlacePick(next);
        writeStored(CODE_PLACE_KEY, next ?? "");
    };
    const computerId =
        placePick && computers?.some((computer) => computer.id === placePick && computer.online)
            ? placePick
            : null;
    // A folder on this computer, inside the desktop app paired here. It counts
    // only while the task runs on this computer, and picking one moves it there.
    const thisComputer = useThisComputer();
    const here = thisComputer.computer;
    const hereOnline = Boolean(here && computers?.some((computer) => computer.id === here.runnerId && computer.online));
    const [folderPick, setFolderPick] = useState<string | null>(null);
    const chooseFolder = (next: string | null) => {
        setFolderPick(next);
        if (next && here) choosePlace(here.runnerId);
    };
    // How hard the tool thinks, for one with an effort flag: the level picked
    // last, read after mount for the same reason as the mode.
    const [effort, setEffort] = useState<core.AgentEffortLevel | null>(null);
    useEffect(() => setEffort(readCodeEffort(readStored(CODE_EFFORT_KEY))), []);
    const chooseEffort = (next: core.AgentEffortLevel) => {
        setEffort(next);
        writeStored(CODE_EFFORT_KEY, next);
    };
    // What the task starts from besides the words: an issue of the repository
    // (dropped when the repository changes) and one of the person's skills.
    const [issuePick, setIssue] = useState<{ repoId: string; issue: PickedIssue } | null>(null);
    const issue = issuePick?.repoId === repoId ? issuePick.issue : null;
    const [skill, setSkill] = useState<string | null>(null);
    const { commands: own, enigma } = usePolarCommands();
    const slash = useCodeSlash({
        value: prompt,
        onValueChange: setPrompt,
        skills: choices?.skills ?? [],
        own,
        onSkill: setSkill,
        place: "start",
        commands: START_COMMANDS,
        enigma: enigma.code,
        onCommand: (command, rest) => {
            setPrompt("");
            if (command === "goal") return startGoal(rest);
            if (command === "help") return setPrompt("/");
            if (command === "resume") return onHistory();
            if (command === "model") return setModelOpen(true);
            if (command === "clear") {
                setIssue(null);
                setSkill(null);
                parts.uploads.clear();
            }
        }
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
    const localFolder = !polar && hereOnline && here && computerId === here.runnerId ? folderPick : null;
    // This task's engine override, when one is picked and can run the model;
    // the server resolves it again with the person's own setting.
    const engineOverride =
        runOn && !polar && engine
            ? (engineOptions(runOn, KNOWN_ENGINES, null).find(
                  (option) => option.id === engine && option.disabled === null
              )?.id ?? null)
            : null;
    const tool =
        resolved && !polar
            ? engineOverride && engineOverride !== NATIVE_ENGINE
                ? engineOverride
                : resolved.cli
            : null;
    // Only a tool whose questions are answered from here is given a mode.
    const asksMode = tool !== null && core.takesPermissionMode(tool);
    const offersChat = tool !== null && acpProviders.chatAvailable(tool, computerId ? "computer" : "local");
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

    /** `/goal` at the start: the condition becomes the task, and the goal is
     *  kept on the session from its creation. */
    const startGoal = (rest: string) => {
        const asked = goals.parseGoalCommand(rest);
        if (asked.kind === "too_long") return setError(t("goal.tooLong", { max: goals.GOAL_CONDITION_MAX }));
        if (asked.kind !== "set") return setError(t("goal.none"));
        // A task Polar answers itself has no session to keep a goal on.
        if (polar) {
            setPrompt(`/goal ${asked.condition}`);
            return setError(t("code.goalFailed"));
        }
        submit(asked.condition);
    };

    const submit = (goal: string | null = null) => {
        if (goal === null && slash.run(prompt)) return;
        if (!ready || busy) return;
        if (polar && model) {
            const text = slash.expand(prompt.trim());
            setPrompt("");
            onPolarTask({
                text,
                choice: model,
                // "No repository" is a Code task too, said as one: as no task at
                // all it read as a plain chat, and the model chose a repository.
                code: workspace
                    ? { repo: null, branch: "" }
                    : repoName
                      ? { repo: repoName, branch: baseRef.trim() }
                      : null
            });
            return;
        }
        if (!tool || !runOn) return;
        setError(null);
        setGap(null);
        const text = goal ?? slash.expand(prompt.trim());
        const started = { issue, skill };
        setSent(text || (issue ? `#${issue.number} ${issue.title}` : ""));
        setPrompt("");
        // Back into the composer when the session was not created, so nothing
        // typed is lost to a failure.
        const restore = () => {
            setSent(null);
            setPrompt((current) => current || (goal ? `/goal ${text}` : text));
        };
        startTransition(() => {
            void runAction(
                () =>
                    postCode<{ id?: string; error?: string; githubGap?: GithubAppGap }>(
                        "/api/polar/code/start",
                        {
                            // A folder on this computer is the checkout itself.
                            repoId: workspace || localFolder ? null : repoId,
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
                            // This task's engine, honoured only where it can run the pick.
                            engine: engineOverride,
                            // One of the person's own agents: its instructions
                            // lead the task (`polarCodeStart`).
                            agentId: persona?.id ?? null,
                            attachments: parts.uploads.ids,
                            ...placeOf(codePlaceTarget(computers, computerId)),
                            localFolder: localFolder ?? "",
                            sharedHome: false,
                            baseRef: workspace || localFolder ? "" : baseRef.trim(),
                            prompt: text,
                            taskId: null,
                            unattended: null,
                            permissionMode: asksMode ? mode : null,
                            surface: offersChat ? surface : "terminal",
                            effort: tool && core.agentEffortLevels(tool).length > 0 ? effort : null,
                            issueNumber: workspace || localFolder ? null : (started.issue?.number ?? null),
                            skill: started.skill,
                            // Code in Polar is the harness's work: Enigma on, the
                            // rest following the repository and the instance.
                            enigma: { enabled: true },
                            goal
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

    // A repository the person reaches on GitHub but has not used here yet is
    // set up the moment it is picked, so the branch chip and the start see an
    // ordinary one (`polarCodeConnectRepo`).
    const chooseRepo = (id: string) => {
        const fullName = githubRepoOf(id);
        if (!fullName) return onRepo(id);
        setError(null);
        setRepoGap(null);
        setConnecting(true);
        void runAction(
            () =>
                postCode<{ id?: string; error?: string; githubGap?: GithubAppGap }>(REPOS_ROUTE, {
                    fullName
                }),
            setError
        )
            .then((result) => {
                if (result?.id) {
                    onRepo(result.id);
                    onRefresh();
                } else if (result?.githubGap) setRepoGap({ id, gap: result.githubGap });
                else if (result?.error) setError(result.error);
            })
            .finally(() => setConnecting(false));
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
                onSubmit={() => submit()}
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
                                open={modelOpen}
                                onOpenChange={setModelOpen}
                                effort={tool ? codeEffort(tool, effort, chooseEffort, t) : null}
                            />
                            <CodeStartOptions
                                mode={asksMode ? { value: mode, onChange: chooseMode } : null}
                                surface={offersChat ? { value: surface, onChange: chooseSurface } : null}
                                engine={
                                    tool && runOn ? { source: runOn, value: engineOverride, onChange: setEngine } : null
                                }
                                place={
                                    !polar ? { computers, value: computerId, onChange: choosePlace } : null
                                }
                                disabled={busy || pending}
                            />
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
                        onRepo={chooseRepo}
                        onRefresh={onRefresh}
                        refreshing={refreshing}
                        branch={baseRef}
                        onBranch={onBaseRef}
                        disabled={busy || pending || connecting}
                    />
                    {repoId !== NO_REPO ? (
                        <CodeIssueChip
                            repoId={repoId}
                            issue={issue}
                            onIssue={(next) => setIssue(next ? { repoId, issue: next } : null)}
                            disabled={busy || repoId === ""}
                        />
                    ) : null}
                    {!polar && here && hereOnline ? (
                        <CodeFolderChip
                            computer={here}
                            value={localFolder}
                            onChange={chooseFolder}
                            onPick={thisComputer.pick}
                            disabled={busy || pending}
                        />
                    ) : null}
                    {/* A skill is picked with "/" in the box; once picked it shows
                        here only to say so and to be removed. */}
                    {skill !== null ? (
                        <CodeSkillTag skill={skill} onClear={() => setSkill(null)} disabled={busy} />
                    ) : null}
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
                    <Link href="/polar/settings/providers" className="text-primary hover:underline">
                        {t("code.addKey")}
                    </Link>
                </Notice>
            ) : null}
            {choices !== null && choices.repos.length === 0 ? (
                <Notice>
                    {choices.githubConnected === false ? (
                        <>
                            {t("code.noGithub")}{" "}
                            <Link href="/account/connections" className="text-primary hover:underline">
                                {t("code.connectGithub")}
                            </Link>
                        </>
                    ) : (
                        <>
                            {t("code.noRepos")}{" "}
                            {choices.installUrl ? (
                                <a
                                    href={choices.installUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary hover:underline"
                                >
                                    {t("code.addRepos")}
                                </a>
                            ) : null}
                        </>
                    )}
                </Notice>
            ) : null}
            {repoGap ? (
                <GithubAppGapNotice
                    gap={repoGap.gap}
                    onCheckAgain={() => chooseRepo(repoGap.id)}
                    checking={connecting}
                />
            ) : null}
            {gap ? <GithubAppGapNotice gap={gap} onCheckAgain={() => submit()} checking={busy} /> : null}
            {shownError ? <Notice error>{shownError}</Notice> : null}
        </div>
    );
}

/** One session, followed while it runs, drawn as a chat thread. */
function CodeThread({
    keysRoot,
    onKeysHelp,
    sessionId,
    firstPrompt,
    canPrompt,
    fullPage,
    voiceKit,
    providers,
    onOpen,
    onNew,
    onHistory,
    onRename,
    call,
    onCall
}: {
    sessionId: string;
    /** What the task was started with here, shown until the session has it. */
    firstPrompt: string | null;
    canPrompt: boolean;
    fullPage: boolean;
    voiceKit: PolarVoiceKit;
    /** Chat's providers and models, for a command saved from a message. */
    providers: ModelSelectorProvider[] | null;
    /** Open another session in this thread's place: the one a stopped session
     *  is continued in. */
    onOpen: (sessionId: string) => void;
    /** Leaves for a new task, for "/new"; the session carries on. */
    onNew: () => void;
    /** Shows the history, for "/resume". */
    onHistory: () => void;
    /** Renames the session, for "/rename"; false when it was not renamed. */
    onRename: (sessionId: string, title: string) => Promise<boolean>;
    /** The voice call open on Code, or null. */
    call: CodeCall | null;
    onCall: (call: CodeCall | null) => void;
    /** The Code view, where its keys are listened for. */
    keysRoot: RefObject<HTMLDivElement | null>;
    /** Opens the keyboard shortcuts. */
    onKeysHelp: () => void;
}) {
    const t = useTranslations("polar");
    const inputId = useId();
    const [modelOpen, setModelOpen] = useState(false);
    const stopKey = useStopTwice();
    // Undefined while the first answer is on its way; null when it is not there.
    const [thread, setThread] = useState<PolarCodeThread | null | undefined>(undefined);
    // The files, the changes and the terminal, beside the thread.
    const [workspace, setWorkspace] = useState(false);
    const [failed, setFailed] = useState(false);
    const [reply, setReply] = useState("");
    // The "/context" card, open until closed.
    const [showContext, setShowContext] = useState(false);
    const { commands: own, enigma, saved: commandSaved } = usePolarCommands();
    // A message being saved as a command, open in the command form.
    const [commandDraft, setCommandDraft] = useState<CommandDraft | null>(null);
    const [error, setError] = useState<string | null>(null);
    // What a command answered that is not a failure: copied, goal cleared.
    const [info, setInfo] = useState<string | null>(null);
    // `/memory`: what the agent remembers of this session's repository.
    const [memoryOpen, setMemoryOpen] = useState(false);
    const [busy, startTransition] = useTransition();
    // Elements picked in the preview, carried ahead of the next message.
    const [picks, setPicks] = useState<readonly PickedElement[]>([]);
    // A call talks to sessions the person may steer, through one that is up.
    const parts = useCodeComposerParts(
        busy,
        thread?.canManage && thread.session.live
            ? { disabled: busy || call !== null, onOpen: () => onCall({ greeting: null, watching: [] }) }
            : null
    );
    const signal = useUnmountSignal();
    // The handed-over commands follow the CLI the session runs.
    const cli = thread?.view?.cli ?? null;
    const commands = useMemo(() => codeCommands.codeCommandsFor("thread", cli), [cli]);
    // A running session has its skill already; Code's commands and the
    // person's own apply.
    const slash = useCodeSlash({
        value: reply,
        onValueChange: setReply,
        skills: [],
        own,
        onSkill: null,
        place: "thread",
        commands,
        enigma: enigma.code,
        onCommand: (command, rest) => runCommand(command, rest)
    });

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
    // Told the moment the session changes - an answer stored, a step taken -
    // rather than on the next poll, which stays underneath as the fallback.
    // The agent's answer while it is written, drawn under the thread until the
    // stored message replaces it (`lib/agents/draft-frames`).
    const [draft, setDraft] = useState<drafts.Draft | null>(null);
    const onDraft = useCallback(
        (frame: drafts.DraftFrame) => setDraft((current) => drafts.applyDraftFrame(current, frame)),
        []
    );
    useEffect(() => (live ? watchSession(sessionId, read, onDraft) : undefined), [live, sessionId, read, onDraft]);
    useEffect(() => setDraft(null), [sessionId]);
    const answers = useMemo(
        () =>
            (thread?.entries ?? [])
                .filter((entry) => entry.type === "message" && entry.role !== "user" && entry.role !== "system")
                .map((entry) => entry.text),
        [thread]
    );
    useEffect(() => {
        if (!draft) return;
        if (!live) {
            setDraft(null);
            return;
        }
        if (!draft.ended) return;
        if (drafts.draftLanded(draft, answers)) {
            setDraft(null);
            return;
        }
        // Its row is on the way; one that never comes does not leave the
        // draft standing in for it.
        const timer = setTimeout(
            () => setDraft((current) => (current === draft ? null : current)),
            drafts.DRAFT_LINGER_MS
        );
        return () => clearTimeout(timer);
    }, [draft, answers, live]);
    // Opened from a notification's Reply: the cursor goes to the reply box
    // once the thread has drawn one.
    const drawn = Boolean(thread);
    useEffect(() => {
        if (!drawn || readStored(REPLY_TO_KEY, "session") !== sessionId) return;
        takeStored(REPLY_TO_KEY, "session");
        const frame = requestAnimationFrame(() => focusInput(inputId));
        return () => cancelAnimationFrame(frame);
    }, [drawn, sessionId, inputId]);

    // What was just sent, shown at once and until the thread carries a new
    // message from the person - counted, so a repeat of an earlier line is not
    // mistaken for this one.
    const said = thread?.entries.filter((entry) => entry.role === "user").length ?? 0;
    const [sent, setSent] = useState<{ text: string; said: number } | null>(null);
    const pending = sent !== null && said <= sent.said;
    useEffect(() => {
        if (sent !== null && !pending) setSent(null);
    }, [sent, pending]);

    const send = () => {
        if (slash.run(reply)) return;
        sendText(slash.expand(reply.trim()));
    };

    /** Sends a message, or with `goal` sets it as the session's goal, which
     *  sends it too; the files wait for the next message then. */
    const sendText = (text: string, { goal = false }: { goal?: boolean } = {}) => {
        if (!text || busy || parts.uploads.uploading || parts.uploads.failed) return;
        const attachments = parts.uploads.ids;
        // The picked elements go with a message, never with a goal.
        const carried = goal ? [] : picks;
        const prompt = carried.length > 0 ? `${pickedContext(carried)}\n\n${text}` : text;
        if (prompt.length > PROMPT_MAX) return setError(t("code.pick.tooLong"));
        setError(null);
        setInfo(null);
        setSent({ text, said });
        setReply("");
        if (carried.length > 0) setPicks([]);
        startTransition(() => {
            void runAction(
                () =>
                    goal
                        ? postCode<{ error?: string; queued?: boolean }>("/api/polar/code/goal", {
                              action: "set",
                              sessionId,
                              condition: text
                          })
                        : postCode<{ error?: string; queued?: boolean }>("/api/polar/code/prompt", {
                              sessionId,
                              text: prompt,
                              attachments
                          }),
                setError
            ).then((result) => {
                // Refused: the message goes back where it was typed.
                if (!result || result.error) {
                    setSent(null);
                    setReply(goal ? `/goal ${text}` : text);
                    if (carried.length > 0) setPicks(carried);
                    if (result?.error) setError(result.error);
                    return;
                }
                // Mid-turn it waits in the queue, drawn there rather than as
                // a message the agent already has.
                if (result.queued) setSent(null);
                if (!goal) parts.uploads.clear();
                read();
            });
        });
    };

    const clearGoal = () => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/goal", { action: "clear", sessionId }),
                setError
            ).then((result) => {
                if (!result || result.error) return setError(result?.error ?? t("goal.clearFailed"));
                setInfo(t("goal.cleared"));
                read();
            });
        });
    };

    /** `/goal`: shown by its bar, cleared, or set and sent as the next turn. */
    const goalCommand = (rest: string) => {
        const asked = goals.parseGoalCommand(rest);
        if (asked.kind === "too_long") return setError(t("goal.tooLong", { max: goals.GOAL_CONDITION_MAX }));
        if (asked.kind === "set") return sendText(asked.condition, { goal: true });
        if (!thread?.goal) return setInfo(t("goal.none"));
        if (asked.kind === "clear") return clearGoal();
        // The bar already shows it; say where it stands in words too.
        setInfo(`${t(`goal.state.${goalStateKey(thread.goal)}`)}: ${thread.goal.condition}`);
    };

    /** `/copy [N]`: the Nth newest answer from the agent, to the clipboard. */
    const copyAnswer = (rest: string) => {
        const index = codeCommands.copyIndex(rest);
        const answers = (thread?.entries ?? []).filter(
            (entry) => entry.type === "message" && entry.role === "agent" && entry.text.trim()
        );
        const answer = index === null ? undefined : answers.at(-index);
        if (!answer) return setError(t("slash.code.copyNone"));
        void navigator.clipboard
            .writeText(answer.text)
            .then(() => setInfo(t("slash.code.copied")))
            .catch(() => setError(t("slash.code.copyFailed")));
    };

    /** Ends the session (`/exit`), as Stop does on the session's page. */
    const endSession = () => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/cancel", { sessionId }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    /** Interrupt the agent's turn: `/stop`, and the Stop on a running subagent. */
    const stopTurn = () => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/interrupt", { sessionId }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    /** What a "/" command does here: Polaris's own run on this screen, the
     *  rest go to the agent in its CLI's own spelling. */
    const runCommand = (command: codeCommands.CodeCommand, rest: string) => {
        setReply("");
        setInfo(null);
        if (command === "goal") return goalCommand(rest);
        if (command === "copy") return copyAnswer(rest);
        if (command === "exit") return endSession();
        if (command === "memory") {
            if (!thread?.view.repoFullName) return setInfo(t("slash.code.memoryNone"));
            return setMemoryOpen(true);
        }
        if (command === "help") return setReply("/");
        if (command === "new") return onNew();
        if (command === "resume") return onHistory();
        if (command === "diff") return setWorkspace(true);
        if (command === "context") return setShowContext(true);
        if (command === "export") {
            const format = rest.toLowerCase() === "jsonl" ? "jsonl" : "md";
            return downloadTranscript(sessionId, format, t(format === "jsonl" ? "code.export.jsonl" : "code.export.markdown"));
        }
        if (command === "rename") {
            if (!rest) return setReply("/rename ");
            setError(null);
            // The history keeps a title to 80 characters.
            return void onRename(sessionId, rest.slice(0, 80)).then((renamed) => {
                if (renamed) read();
                else setError(t("slash.code.renameFailed"));
            });
        }
        if (command === "stop") return stopTurn();
        const text = cli ? codeCommands.forwardedText(command, rest, cli) : null;
        if (text) sendText(text);
    };

    const canStop = live && (thread?.canManage ?? false) && canPrompt;
    useCodeKeys(keysRoot, fullPage, {
        "code.interrupt": () => {
            if (!canStop) return false;
            if (stopKey.press()) stopTurn();
        },
        "code.focusComposer": () => focusInput(inputId),
        "code.commands": () => {
            setReply("/");
            focusInput(inputId);
        },
        "code.toggleWorkspace": () => {
            if (!thread?.canManage) return false;
            setWorkspace((open) => !open);
        }
    });
    // A turn that ended on its own needs no second Escape.
    const { disarm } = stopKey;
    useEffect(() => {
        if (!canStop) disarm();
    }, [canStop, disarm]);

    // The mode the agent is in, changeable while it runs: only for a tool that
    // takes one, on a session that picked one (otherwise the place and Enigma
    // decided, and Polaris does not know the mode in force).
    const liveMode =
        cli && core.takesPermissionMode(cli) && thread?.session.live ? (thread.view.permissionMode ?? null) : null;
    const changeMode = (mode: core.SessionPermissionMode) => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/mode", { sessionId, mode }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    // Terminal or Chat, for an agent Polaris can drive over ACP where it runs.
    const liveSurface =
        cli && thread?.session.live && acpProviders.chatAvailable(cli, thread.view.place)
            ? thread.view.surface
            : null;
    const changeSurface = (surface: acpProviders.SessionSurface) => {
        if (surface === liveSurface) return;
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/surface", { sessionId, surface }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    // The model, changeable while it runs: Claude Code only, among the models
    // of the source it already signs in with. The sources are the start
    // picker's, read once here when this tab has not read them yet.
    const modelLive = Boolean(cli && core.takesPermissionMode(cli) && thread?.session.live);
    const [sources, setSources] = useState<readonly CodeSource[] | null>(
        () => choicesCache?.code?.sources ?? null
    );
    useEffect(() => {
        if (!modelLive || sources !== null) return;
        void readPoll<Choices | null>("/api/polar/code/choices", {}, signal())
            .then((loaded) => {
                if (!loaded) return;
                choicesCache = loaded;
                setSources(loaded.code?.sources ?? []);
            })
            .catch(() => undefined);
    }, [modelLive, sources, signal]);
    const view = thread?.view ?? null;
    const liveSource = modelLive && view && sources ? liveSourceFor(sources, view) : null;
    const livePick: CodePick | null = liveSource
        ? {
              source: liveSource.key,
              provider: view?.modelChoice?.provider ?? liveSource.models[0]?.provider ?? "",
              model: view?.modelChoice?.model ?? null
          }
        : null;
    // The account, changeable while it runs, for a session that signs in with
    // a stored account rather than its machine's own login.
    const liveAccount = Boolean(thread?.session.live && thread.canManage && !thread.view.useMachineLogin);
    // Another agent or model, for a running session on Polaris with a branch to
    // carry the work on: the same checks the switch makes on the server.
    const liveSwitch = canSwitchAgent(thread ?? null);
    // The effort, changeable while it runs, for a tool with an effort command.
    const liveEffort = Boolean(cli && core.agentEffortLevels(cli).length > 0 && thread?.session.live);
    const changeEffort = (next: core.AgentEffortLevel) => {
        if (next === view?.effort) return;
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/effort", { sessionId, effort: next }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };
    const changeModel = (next: CodePick) => {
        if (next.source !== livePick?.source || next.model === livePick.model) return;
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/model", { sessionId, model: next.model }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    const session = thread?.session;
    const blocks = useMemo(() => codeBlocks(thread?.entries ?? []), [thread]);
    // The places a stopped session can be continued on, read once it stopped.
    const places = useCodeComputers(!live && !!thread?.canManage && canPrompt);
    // The agent mid-turn draws its steps moving; a message on its way to it
    // draws the indicator under it. A session that is only open - waiting,
    // idle - draws nothing that moves.
    const turning = live && session?.state === "working";
    const indicator =
        live && (pending || (turning && blocks.length > 0 && blocks.at(-1)?.kind !== "work"));
    // Sending again and answering again are new turns: only for whoever may
    // steer it, while it is open and between turns.
    const retry = useMemo(() => codeRetryOf(thread?.entries ?? []), [thread]);
    const canRetry = live && !!thread?.canManage && canPrompt && !busy && !turning && !pending;
    const askAgain = () => retry.ask && sendText(parseVoiceDelegation(retry.ask.text) ?? retry.ask.text);
    useEffect(() => () => answerActions.stopReading(), []);
    const answerMarks = answerActions.useAnswerMarks({ session: sessionId });
    const messageActions = (entry: PolarCodeEntry): CodeMessageActions => ({
        onCompose: setReply,
        onResend: canRetry && entry === retry.ask ? askAgain : undefined,
        onRegenerate: canRetry && entry === retry.answer ? askAgain : undefined,
        onSaveCommand: () =>
            setCommandDraft({
                prompt: (parseVoiceDelegation(entry.text) ?? entry.text).slice(0, POLAR_COMMAND_PROMPT_MAX)
            }),
        speech: voiceKit.voice.speech,
        payer: voiceKit.payer,
        // Only a stored message can be marked: a thread cached before entries
        // had ids has none, and only the person who started it may mark it.
        ...(UUID.test(entry.id ?? "") && thread?.canManage
            ? {
                  mark: answerMarks.marks[entry.id] ?? null,
                  onMark: (change: answerActions.MarkChange) => answerMarks.mark(entry.id, change)
              }
            : {})
    });

    /** Carry on in a new session on the same branch, with the conversation so
     *  far where the agent can take it, and open it here. `target` moves it to
     *  another place; absent, it stays where it ran. */
    const carryOn = (target?: CodePlaceTarget) => {
        setError(null);
        startTransition(() => {
            void runAction(
                () =>
                    postCode<{ id?: string; error?: string }>("/api/polar/code/continue", {
                        sessionId,
                        ...(target ? { target } : {})
                    }),
                setError
            ).then((result) => {
                if (!result) return;
                if (result.id) onOpen(result.id);
                else setError(result.error ?? t("code.continueFailed"));
            });
        });
    };

    /** Change a queued message, or take it back into the reply box. */
    const changeQueued = (id: string, text: string | null) => {
        setError(null);
        startTransition(() => {
            void runAction(
                () =>
                    postCode<{ text?: string; gone?: boolean; error?: string }>(
                        "/api/polar/code/queue",
                        text === null
                            ? { action: "remove", sessionId, id }
                            : { action: "edit", sessionId, id, text }
                    ),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                else if (result?.gone) setError(t("code.queue.gone"));
                else if (result?.text) {
                    const back = result.text;
                    setReply((current) => (current.trim() ? `${back}\n\n${current}` : back));
                }
                read();
            });
        });
    };

    // The status line, from what the session reported.
    const statusParts = codeStatus.codeStatusParts({
        model: thread?.model ?? null,
        effort: view?.effort ?? null,
        context: thread?.context ?? null,
        costUsd: view?.usage?.costUsd ?? null,
        branch: session?.branch ?? ""
    });

    /** Take this session out of the queue it is waiting in. */
    const cancelQueued = () => {
        setError(null);
        startTransition(() => {
            void runAction(
                () => postCode<{ error?: string }>("/api/polar/code/cancel", { sessionId }),
                setError
            ).then((result) => {
                if (result?.error) setError(result.error);
                read();
            });
        });
    };

    const dock = !thread ? null : !live ? (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Notice>{t("code.ended")}</Notice>
                {thread.canManage && canPrompt ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="outline" onClick={() => carryOn()} disabled={busy}>
                            {t("code.continue")}
                        </Button>
                        <span className="text-muted-foreground text-xs">{t("code.place.continueOn")}</span>
                        <CodePlacePicker
                            computers={places}
                            value={thread.view.runnerId ?? thread.view.hostId ?? null}
                            onChange={(id) => carryOn(codePlaceTarget(places, id))}
                            disabled={busy}
                        />
                    </div>
                ) : null}
            </div>
            {error ? <Notice error>{error}</Notice> : null}
        </div>
    ) : !canPrompt ? (
        <Notice>{t("code.readOnly")}</Notice>
    ) : (
        <div className="flex min-w-0 flex-col gap-2">
            {thread.queued ? (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <Notice>
                        {thread.queued.reason ?? t("code.queued.waiting")}
                        {thread.queued.position
                            ? ` ${t("code.queued.position", { position: thread.queued.position })}`
                            : ""}
                    </Notice>
                    <Button type="button" size="sm" variant="outline" onClick={cancelQueued} disabled={busy}>
                        {t("code.queued.cancel")}
                    </Button>
                </div>
            ) : null}
            {/* A thread cached before todos existed has none. */}
            {/* A thread cached before goals existed has none. */}
            {thread.goal ? (
                <PolarGoalBar
                    goal={thread.goal}
                    busy={busy || turning}
                    onContinue={() => thread.goal && sendText(goals.continuationText(thread.goal))}
                    onClear={clearGoal}
                />
            ) : null}
            {memoryOpen && thread.view.repoFullName ? (
                <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="min-w-0 flex-1">
                        <RepoMemorySection repoFullName={thread.view.repoFullName} />
                    </div>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("slash.code.memoryClose")}
                        title={t("slash.code.memoryClose")}
                        onClick={() => setMemoryOpen(false)}
                    >
                        <X />
                    </Button>
                </div>
            ) : null}
            <CodeTodos todos={thread.todos ?? []} />
            {thread.permission?.ask ? (
                <CodeAskCard
                    key={thread.permission.id}
                    requestId={thread.permission.id}
                    ask={thread.permission.ask}
                    onAnswered={read}
                />
            ) : thread.permission ? (
                <CodePermission
                    key={thread.permission.id}
                    asked={thread.permission}
                    onAnswered={read}
                />
            ) : null}
            {showContext ? (
                <CodeContextCard
                    context={thread.context ?? null}
                    model={thread.model ?? null}
                    onClose={() => setShowContext(false)}
                />
            ) : null}
            {/* A thread cached before the queue existed has none. */}
            <CodeQueuedList
                waiting={thread.waiting ?? []}
                disabled={busy}
                onEdit={(id, text) => changeQueued(id, text)}
                onTakeBack={(id) => changeQueued(id, null)}
            />
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
            {call ? (
                // Above the box, which stays in use under it, as in Chat.
                <CodeVoiceCall
                    sessionId={sessionId}
                    thread={thread}
                    kit={voiceKit}
                    greeting={call.greeting}
                    watching={call.watching}
                    realtime={call.realtime ?? null}
                    onRealtime={(link) => onCall({ greeting: null, watching: [], realtime: link })}
                    onOpen={(next, say, watching) => {
                        onCall({ ...call, greeting: say || null, watching: [...watching] });
                        onOpen(next);
                    }}
                    onEnd={() => onCall(null)}
                />
            ) : null}
            <PickedChips picks={picks} onRemove={(index) => setPicks((list) => list.filter((_, at) => at !== index))} />
            <div className="relative">
            {slash.list}
            <PolarComposer
                textareaProps={slash.textareaProps}
                kit={voiceKit}
                inCall={call !== null}
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
                picker={
                    liveSource || liveMode || liveEffort || liveAccount || liveSurface || liveSwitch ? (
                        <>
                            {liveSwitch ? (
                                <CodeAgentSwitch
                                    sessionId={sessionId}
                                    disabled={busy}
                                    onSwitched={onOpen}
                                    onError={setError}
                                />
                            ) : null}
                            {liveAccount ? (
                                <CodeAccountSwitch
                                    sessionId={sessionId}
                                    disabled={busy}
                                    onSwitched={read}
                                    onError={setError}
                                />
                            ) : null}
                            {liveSource ? (
                                <CodeModelPicker
                                    sources={[liveSource]}
                                    value={livePick}
                                    onChange={changeModel}
                                    automatic={false}
                                    disabled={busy}
                                    open={modelOpen}
                                    onOpenChange={setModelOpen}
                                    effort={liveEffort && cli ? codeEffort(cli, view?.effort ?? null, changeEffort, t) : null}
                                />
                            ) : null}
                            {liveMode ? (
                                <PermissionModePicker value={liveMode} onChange={changeMode} disabled={busy} />
                            ) : null}
                            {liveSurface ? (
                                <SessionSurfacePicker
                                    value={liveSurface}
                                    onChange={changeSurface}
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
                    disabled:
                        !reply.trim() || busy || parts.uploads.uploading || parts.uploads.failed,
                    sendLabel: t("code.send"),
                    stopLabel: t("code.send"),
                    onStop: () => undefined
                }}
            />
            </div>
            <CodeStatusLine parts={statusParts} />
            {error ? (
                <Notice error>{error}</Notice>
            ) : stopKey.armed ? (
                <Notice>{t("code.keys.stopAgain")}</Notice>
            ) : info ? (
                <Notice>{info}</Notice>
            ) : null}
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
                <button
                    type="button"
                    onClick={onKeysHelp}
                    aria-label={t("code.keys.shortcuts")}
                    title={t("code.keys.shortcuts")}
                    className="max-md:hidden inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                >
                    <Keyboard className="size-4" />
                </button>
                {thread ? <CodeExportMenu sessionId={sessionId} /> : null}
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
                                    // A thread cached before entries had ids has none.
                                    key={block.entry.id || `${block.entry.at}-${index}`}
                                    entry={block.entry}
                                    actions={messageActions(block.entry)}
                                />
                            ) : (
                                <Work
                                    key={`${block.entries[0]?.at}-${index}`}
                                    messageId={`code:${sessionId}:${index}`}
                                    streaming={turning && !pending && index === blocks.length - 1}
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
                        {/* A thread cached before subagents were read has none. */}
                        <CodeSubagents
                            sessionId={sessionId}
                            subagents={thread.subagents ?? []}
                            onStop={live && thread.canManage && canPrompt ? stopTurn : null}
                            stopping={busy}
                        />
                        {firstPrompt && !thread.entries.some((entry) => entry.role === "user") ? (
                            <Message from="user">
                                <MessageContent from="user">
                                    <p className="whitespace-pre-wrap">{firstPrompt}</p>
                                </MessageContent>
                            </Message>
                        ) : null}
                        {sent !== null && pending ? (
                            <Message from="user">
                                <MessageContent from="user">
                                    <p className="whitespace-pre-wrap">{sent.text}</p>
                                </MessageContent>
                            </Message>
                        ) : null}
                        {draft ? (
                            <Message from="assistant">
                                <MessageContent from="assistant">
                                    <MessageResponse>{draft.text}</MessageResponse>
                                </MessageContent>
                            </Message>
                        ) : null}
                        {indicator && !draft ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                                <ThinkingOrb state="solving" size={20} decorative />
                                <Shimmer>
                                    <BusyVerb />
                                </Shimmer>
                            </div>
                        ) : null}
                        {thread.entries.length === 0 && live ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <ThinkingOrb state="breathing" size={20} decorative />
                                <Shimmer>
                                    {thread.session.state === "starting" && thread.canManage ? (
                                        <CodeBootLine sessionId={sessionId} fallback={t("code.quiet")} />
                                    ) : (
                                        t("code.quiet")
                                    )}
                                </Shimmer>
                            </div>
                        ) : null}
                        {thread.error ? <Notice error>{thread.error}</Notice> : null}
                        {thread.refusedSignIn ? (
                            <SignInRefusedNotice account={thread.refusedSignIn.account} />
                        ) : null}
                    </>
                )}
            </PolarThreadFrame>
            {thread?.canManage ? (
                <PolarCodeWorkspace
                    open={workspace}
                    onOpenChange={setWorkspace}
                    session={thread.view}
                    branch={thread.session.branch}
                    live={live}
                    lastEdit={thread.lastEdit ?? null}
                    lastTool={thread.lastTool ?? null}
                    onPick={(element) => {
                        setPicks((list) => [...list, element].slice(-PICKS_MAX));
                        // What comes next is saying what to do with it.
                        setWorkspace(false);
                        window.setTimeout(() => document.getElementById(inputId)?.focus(), 0);
                    }}
                />
            ) : null}
            {commandDraft ? (
                <CommandForm
                    draft={commandDraft}
                    commands={own}
                    providers={providers ?? []}
                    onClose={() => setCommandDraft(null)}
                    onSaved={commandSaved}
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
                <Button type="button" size="sm"
                    className="[@media(pointer:coarse)]:h-11" onClick={() => answer("allow")} disabled={busy}>
                    {t("code.permission.allow")}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    className="[@media(pointer:coarse)]:h-11"
                    variant="outline"
                    onClick={() => answer("always")}
                    disabled={busy}
                >
                    {t("code.permission.always")}
                </Button>
                <Button
                    type="button"
                    size="sm"
                    className="[@media(pointer:coarse)]:h-11"
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

/** A time as Polaris writes it into a session notice. */
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

/** A message of the session, in Chat's bubbles: the person's words as typed,
 *  the agent's as Markdown. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a Code message's row can do beyond copy, reply and edit; an absent
 *  action is not drawn. */
export interface CodeMessageActions {
    /** Replaces the composer's draft: edit and reply. */
    readonly onCompose: (text: string) => void;
    /** Sends the person's message again, as a new turn. */
    readonly onResend?: () => void;
    /** Asks the agent the question before this answer again. */
    readonly onRegenerate?: () => void;
    /** Opens the command form with the person's message as its prompt. */
    readonly onSaveCommand?: () => void;
    /** Whether a voice can read an answer aloud, and who pays for it. */
    readonly speech: boolean;
    readonly payer: string | null;
    /** The person's mark on an agent answer, and how to change it; absent
     *  where it cannot be marked. */
    readonly mark?: PolarMark | null;
    readonly onMark?: (change: answerActions.MarkChange) => Promise<boolean>;
}

/**
 * One line of a Code session, with the chat's own actions under it: copy,
 * reply (quoted into the composer) and, on the person's own message, edit
 * (back into the composer), send again and save as a command; on the agent's,
 * read aloud and, on the last one, answer again.
 */
export function CodeMessage({ entry, actions }: { entry: PolarCodeEntry; actions: CodeMessageActions }) {
    const t = useTranslations("polar");
    const toast = useToast();
    const format = useDisplayFormat();
    const { copied, copy } = useCopied();
    const readId = `code:${entry.id || entry.at}`;
    const reading = answerActions.useReading(readId);
    const { onCompose } = actions;
    // Polaris's own line (an account switch, a wait): quiet, not a reply. Its
    // times travel as ISO and are written in the reader's zone and format.
    if (entry.role === "system")
        return (
            <p role="status" className="min-w-0 break-words text-xs text-muted-foreground">
                {entry.text.replace(ISO_TIME, (iso) => format.dateTime(iso))}
            </p>
        );
    const from = entry.role === "user" ? "user" : "assistant";
    return (
        <Message from={from}>
            <MessageContent from={from}>
                {from === "user" ? (
                    // Words said in a voice call show as said, not in their envelope.
                    <p className="whitespace-pre-wrap">{parseVoiceDelegation(entry.text) ?? entry.text}</p>
                ) : (
                    <MessageResponse>{entry.text}</MessageResponse>
                )}
            </MessageContent>
            <MessageActions className="opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                {from === "user" ? (
                    <MessageAction
                        label={t("actions.edit")}
                        onClick={() => onCompose(parseVoiceDelegation(entry.text) ?? entry.text)}
                    >
                        <Pencil />
                    </MessageAction>
                ) : null}
                {from === "user" && actions.onResend ? (
                    <MessageAction label={t("actions.resend")} onClick={actions.onResend}>
                        <RotateCw />
                    </MessageAction>
                ) : null}
                {from === "user" && actions.onSaveCommand ? (
                    <MessageAction label={t("commands.saveAs")} onClick={actions.onSaveCommand}>
                        <BookmarkPlus />
                    </MessageAction>
                ) : null}
                <MessageAction label={t("actions.reply")} onClick={() => onCompose(quoteOf(entry.text))}>
                    <Reply />
                </MessageAction>
                <MessageAction
                    label={copied ? t("actions.copied") : t("actions.copy")}
                    onClick={() => void copy(entry.text)}
                >
                    <CopyIcon copied={copied} />
                </MessageAction>
                {from === "assistant" && actions.onMark ? (
                    <answerActions.AnswerMarks mark={actions.mark ?? null} onMark={actions.onMark} />
                ) : null}
                {from === "assistant" && actions.speech && entry.text.trim() ? (
                    <MessageAction
                        label={reading.active ? t("actions.stopReading") : t("actions.readAloud")}
                        aria-pressed={reading.active}
                        aria-busy={reading.loading}
                        className={cn(reading.loading && "motion-safe:animate-pulse")}
                        onClick={() =>
                            reading.active
                                ? answerActions.stopReading()
                                : answerActions.readAloud(readId, entry.text, actions.payer, (error) =>
                                      toast.show({ title: t(`voice.errors.${error}`) })
                                  )
                        }
                    >
                        {reading.active ? <Square /> : <Volume2 />}
                    </MessageAction>
                ) : null}
                {/* Plain: an agent session's turn has no longer, shorter or
                    other-model form to ask for; it is asked again as it was. */}
                {from === "assistant" && actions.onRegenerate ? (
                    <MessageAction label={t("actions.regenerate")} onClick={actions.onRegenerate}>
                        <RotateCcw />
                    </MessageAction>
                ) : null}
            </MessageActions>
        </Message>
    );
}

/** A message quoted at the head of a reply, as Markdown, its first 200 characters. */
export function quoteOf(text: string): string {
    const quoted = text.trim().slice(0, 200).split("\n").map((line) => `> ${line}`).join("\n");
    return `${quoted}\n\n`;
}
