"use client";

/**
 * Polar's panel: the provider every page can feed context to, the header
 * button that opens it (Ctrl/Cmd+J, free in the shortcut table), and the chat.
 *
 * The panel sits right of the content and pushes it on wide screens, floats
 * over it on narrow ones and fills the screen on a phone. Its width is
 * remembered per browser. The chat streams from /api/polar/chat; anything that
 * would change something arrives as a card to approve. Messages typed while a
 * turn runs wait in a queue above the composer, saved with the thread, and go
 * one by one when the turn ends - stopping a turn keeps them.
 */

import Link from "next/link";
import { useChat } from "@ai-sdk/react";
import { usePathname } from "next/navigation";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses, type UIMessage } from "ai";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";
import { Copy, History, Maximize2, Pencil, Plus, Reply, RotateCcw, Trash2, X } from "lucide-react";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { Reasoning } from "@/components/polar/elements/reasoning";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Tool, ToolInput, ToolOutput, type ToolState } from "@/components/polar/elements/tool";
import { PolarMascot, type PolarMood } from "@/components/polar/polar-mascot";
import { Suggestion, Suggestions } from "@/components/polar/elements/suggestion";
import { Queue, QueueItem, QueueSection } from "@/components/polar/elements/queue";
import { learnPath, pathThrough, versionsOf, type VersionTree } from "@/lib/polar/versions";
import { Attachment, Attachments, type AttachmentData } from "@/components/polar/elements/attachments";
import { ModelSelector, type ModelSelectorProvider } from "@/components/polar/elements/model-selector";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/polar/elements/conversation";
import { affectedBy, Confirmation, type ConfirmationApproval } from "@/components/polar/elements/confirmation";
import {
    Message,
    MessageAction,
    MessageActions,
    MessageBranchSelector,
    MessageContent,
    MessageResponse
} from "@/components/polar/elements/message";
import {
    PromptInput,
    PromptInputAttach,
    PromptInputFooter,
    PromptInputHeader,
    PromptInputSubmit,
    PromptInputTextarea,
    PromptInputTools
} from "@/components/polar/elements/prompt-input";
import {
    cleanContextText,
    MAX_QUEUE,
    POLAR_ATTACHMENT_MAX_BYTES,
    POLAR_ATTACHMENT_MOST,
    POLAR_ATTACHMENT_TYPES,
    type ModelChoice,
    type PageContext,
    type QueuedMessage
} from "@/lib/polar/shared";

// ---------------------------------------------------------------------------
// Page context
// ---------------------------------------------------------------------------

type ExtraContext = Pick<PageContext, "record" | "selection">;

interface PolarState {
    open: boolean;
    setOpen: (open: boolean) => void;
    extra: ExtraContext | null;
    setExtra: (extra: ExtraContext | null) => void;
}

const PolarContext = createContext<PolarState | null>(null);

export function usePolar(): PolarState {
    const state = useContext(PolarContext);
    if (!state) throw new Error("usePolar outside PolarProvider");
    return state;
}

/** What a page tells Polar about itself: the record open, what is selected. */
export function usePolarContext(extra: ExtraContext | null): void {
    const state = useContext(PolarContext);
    const key = JSON.stringify(extra);
    useEffect(() => {
        if (!state) return;
        state.setExtra(extra);
        return () => state.setExtra(null);
    }, [key]);
}

/** Route, title and the ids the URL names, everywhere. */
export function pageContextFrom(pathname: string, title: string, extra: ExtraContext | null): PageContext {
    const segments = pathname.split("/").filter(Boolean);
    const ids: Record<string, string> = {};
    for (let index = 1; index < segments.length; index++) {
        let value: string;
        try {
            value = decodeURIComponent(segments[index] ?? "");
        } catch {
            continue;
        }
        // An id carries a digit (a uuid, a number, `lirio-0`); a word such as
        // `settings` is a section, which the route already says.
        if (/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) && /\d/.test(value)) {
            ids[(segments[index - 1] ?? `part${index}`).slice(0, 40)] = value;
        }
    }
    // Cleaned here as the route cleans it, so a name made only of characters it
    // strips drops out of the context instead of refusing the whole message.
    const recordId = extra?.record ? cleanContextText(extra.record.id) : "";
    const recordKind = extra?.record ? cleanContextText(extra.record.kind) : "";
    const selection = (extra?.selection ?? []).map(cleanContextText).filter(Boolean).slice(0, 20);
    return {
        route: pathname,
        title: cleanContextText(title) || undefined,
        ids: Object.keys(ids).length ? ids : undefined,
        record:
            recordId && recordKind
                ? {
                      kind: recordKind,
                      id: recordId,
                      name: cleanContextText(extra?.record?.name ?? "") || undefined
                  }
                : undefined,
        selection: selection.length ? selection : undefined
    };
}

const OPEN_KEY = "polar.open";
const WIDTH_KEY = "polar.width";
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

function readStored(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStored(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // A private window: the panel works, it just forgets.
    }
}

export function PolarProvider({ children }: { children: ReactNode }) {
    const [open, setOpenState] = useState(false);
    const [extra, setExtra] = useState<ExtraContext | null>(null);
    useEffect(() => setOpenState(readStored(OPEN_KEY) === "1"), []);
    const setOpen = useCallback((next: boolean) => {
        setOpenState(next);
        writeStored(OPEN_KEY, next ? "1" : "0");
    }, []);
    useEffect(() => {
        function onKey(event: KeyboardEvent) {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "j") {
                event.preventDefault();
                setOpenState((current) => {
                    writeStored(OPEN_KEY, current ? "0" : "1");
                    return !current;
                });
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
    const value = useMemo(() => ({ open, setOpen, extra, setExtra }), [open, setOpen, extra]);
    return <PolarContext.Provider value={value}>{children}</PolarContext.Provider>;
}

/** The header button. */
export function PolarToggle() {
    const t = useTranslations("polar");
    const { open, setOpen } = usePolar();
    return (
        <button
            type="button"
            aria-pressed={open}
            title={t("toggle.title")}
            onClick={() => setOpen(!open)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground aria-pressed:bg-card-hover aria-pressed:text-foreground"
        >
            <PolarMascot size={20} />
            <span className="hidden lg:inline">{t("toggle.label")}</span>
            <kbd className="hidden rounded border border-border px-1 font-mono text-[10px] text-foreground-subtle xl:inline">
                Ctrl J
            </kbd>
        </button>
    );
}

/** The side panel, rendered by the shell beside the content. */
export function PolarAside() {
    const { open, setOpen } = usePolar();
    const pathname = usePathname();
    const [width, setWidth] = useState(400);
    useEffect(() => {
        const stored = Number(readStored(WIDTH_KEY));
        if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) setWidth(stored);
    }, []);
    const startResize = (event: React.PointerEvent) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let last = startWidth;
        const move = (next: PointerEvent) => {
            last = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - next.clientX));
            setWidth(last);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            writeStored(WIDTH_KEY, String(last));
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    if (!open || pathname.startsWith("/polar")) return null;
    return (
        <aside
            aria-label="Polar"
            style={{ ["--polar-width" as string]: `${width}px` }}
            className="fixed inset-0 z-50 flex flex-col bg-card sm:inset-auto sm:bottom-0 sm:right-0 sm:top-header sm:w-[var(--polar-width)] sm:border-l sm:border-border sm:shadow-popover xl:sticky xl:top-header xl:z-auto xl:h-below-header xl:shrink-0 xl:self-start xl:shadow-none"
        >
            <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startResize}
                className="absolute inset-y-0 left-0 hidden w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30 sm:block"
            />
            <PolarChat onClose={() => setOpen(false)} />
        </aside>
    );
}


// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

const CHOICE_KEY = "polar.choice";
const THREADS_KEY = "polar.threads";

function newId(): string {
    return crypto.randomUUID();
}

function textOf(message: UIMessage): string {
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
}

type ThreadRow = { id: string; title: string; updatedAt: string };
type ToolDescription = { title: string; writes: boolean; destructive: boolean };
type StoredMessage = UIMessage & { parentId: string | null };

const COMMANDS = ["new", "model", "page", "file", "tools", "call"] as const;
/** Commands that exist but belong to a later phase. */
const LATER = new Set<string>(["call"]);

/** Upload refusals the composer explains; anything else reads as a failed upload. */
const UPLOAD_ERRORS = ["unsupported_type", "too_large", "rate_limited", "storage_failed", "upload_failed"] as const;
type UploadError = (typeof UPLOAD_ERRORS)[number];

async function uploadFile(file: File): Promise<AttachmentData | string> {
    if (!(POLAR_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return "unsupported_type";
    if (file.size > POLAR_ATTACHMENT_MAX_BYTES) return "too_large";
    const response = await fetch(`/api/polar/attachments?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": file.type },
        body: file
    }).catch(() => null);
    if (!response?.ok) {
        const body = (await response?.json().catch(() => null)) as { error?: string } | null;
        return body?.error ?? "upload_failed";
    }
    const { file: stored } = (await response.json()) as {
        file: { id: string; url: string; filename: string; mediaType: string };
    };
    return { id: stored.id, url: stored.url, filename: stored.filename, mediaType: stored.mediaType };
}

export function PolarChat({ onClose, fullPage = false }: { onClose?: () => void; fullPage?: boolean }) {
    const t = useTranslations("polar");
    const pathname = usePathname();
    const state = useContext(PolarContext);
    const [threadId, setThreadId] = useState(newId);
    const [providers, setProviders] = useState<ModelSelectorProvider[] | null>(null);
    const [tools, setTools] = useState<Record<string, ToolDescription>>({});
    const [isAdmin, setIsAdmin] = useState(false);
    const [choice, setChoice] = useState<ModelChoice | null>(null);
    const [input, setInput] = useState("");
    const [quote, setQuote] = useState<string | null>(null);
    const [withPage, setWithPage] = useState(true);
    const [queue, setQueue] = useState<QueuedMessage[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [files, setFiles] = useState<AttachmentData[]>([]);
    const [fileError, setFileError] = useState<string | null>(null);
    const [threads, setThreads] = useState<ThreadRow[] | null>(null);
    const [showHistory, setShowHistory] = useState(fullPage);
    const [lastApproved, setLastApproved] = useState(false);
    const tree = useRef<VersionTree>(new Map());
    const textarea = useRef<HTMLTextAreaElement>(null);
    const [, setTreeTick] = useState(0);

    const context = useMemo(
        () =>
            withPage
                ? pageContextFrom(pathname, typeof document === "undefined" ? "" : document.title, state?.extra ?? null)
                : null,
        [withPage, pathname, state?.extra]
    );
    const live = useRef({ threadId, choice, context });
    live.current = { threadId, choice, context };

    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: "/api/polar/chat",
                prepareSendMessagesRequest: ({ messages }) => ({
                    body: {
                        threadId: live.current.threadId,
                        messages,
                        choice: live.current.choice,
                        context: live.current.context,
                        parentId: messages.length > 1 ? (messages[messages.length - 2]?.id ?? null) : null
                    }
                })
            }),
        []
    );
    const chat = useChat({
        id: threadId,
        transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses
    });
    const busy = chat.status === "submitted" || chat.status === "streaming";
    const waitingApproval = chat.messages
        .at(-1)
        ?.parts.some((part) => "state" in part && part.state === "approval-requested");

    // Every message on screen joins the version tree as it appears.
    useEffect(() => {
        learnPath(tree.current, chat.messages);
    }, [chat.messages]);

    // Models and tools: last known choice first, then the server's.
    useEffect(() => {
        try {
            const cached = window.localStorage.getItem(CHOICE_KEY);
            if (cached) setChoice(JSON.parse(cached) as ModelChoice);
        } catch {
            // Nothing remembered.
        }
        fetch("/api/polar/models")
            .then((response) => (response.ok ? response.json() : null))
            .then(
                (
                    data: {
                        providers: ModelSelectorProvider[];
                        tools?: Record<string, ToolDescription>;
                        isAdmin: boolean;
                    } | null
                ) => {
                    if (!data) return setProviders([]);
                    setProviders(data.providers);
                    setTools(data.tools ?? {});
                    setIsAdmin(data.isAdmin);
                    setChoice((current) => {
                        const known = data.providers.some((entry) =>
                            entry.models.some(
                                (model) => model.provider === current?.provider && model.model === current?.model
                            )
                        );
                        if (current && known) return current;
                        const first = data.providers[0]?.models[0];
                        return first
                            ? {
                                  kind: "language",
                                  provider: first.provider,
                                  model: first.model,
                                  intelligence: "balanced",
                                  payer: null
                              }
                            : null;
                    });
                }
            )
            .catch(() => setProviders([]));
    }, []);
    useEffect(() => {
        if (choice) writeStored(CHOICE_KEY, JSON.stringify(choice));
    }, [choice]);

    // History: last known list instantly, refreshed behind it.
    const loadThreads = useCallback(() => {
        try {
            const cached = window.sessionStorage.getItem(THREADS_KEY);
            if (cached) setThreads(JSON.parse(cached) as ThreadRow[]);
        } catch {
            // No cache.
        }
        fetch("/api/polar/threads")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { threads: ThreadRow[] } | null) => {
                if (!data) return;
                setThreads(data.threads);
                try {
                    window.sessionStorage.setItem(THREADS_KEY, JSON.stringify(data.threads));
                } catch {
                    // No cache.
                }
            })
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        if (showHistory) loadThreads();
    }, [showHistory, loadThreads]);

    const saveQueue = useCallback(
        (next: QueuedMessage[]) => {
            setQueue(next);
            if (chat.messages.length === 0) return;
            void fetch(`/api/polar/threads/${live.current.threadId}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ queue: next })
            }).catch(() => undefined);
        },
        [chat.messages.length]
    );

    // The queue drains one message at a time once a turn has finished.
    useEffect(() => {
        if (busy || waitingApproval || queue.length === 0 || chat.status === "error") return;
        const [next, ...rest] = queue;
        saveQueue(rest);
        if (next) void chat.sendMessage({ text: next.text });
    }, [busy, waitingApproval, queue.length, chat.status]);

    const openThread = async (id: string) => {
        const response = await fetch(`/api/polar/threads/${id}`).catch(() => null);
        if (!response?.ok) return;
        const { thread } = (await response.json()) as {
            thread: { id: string; messages: StoredMessage[]; queue: QueuedMessage[]; choice: ModelChoice | null };
        };
        // Every stored version goes into the tree; the newest path is shown.
        const next: VersionTree = new Map();
        learnPath(next, thread.messages, new Map(thread.messages.map((message) => [message.id, message.parentId])));
        tree.current = next;
        const roots = thread.messages.filter((message) => message.parentId === null);
        const newestRoot = roots.at(-1);
        setThreadId(thread.id);
        chat.setMessages(newestRoot ? pathThrough(next, [], 0, newestRoot.id) : []);
        setQueue(thread.queue);
        if (thread.choice) setChoice(thread.choice);
        setShowHistory(fullPage);
    };

    const startNew = () => {
        void chat.stop();
        tree.current = new Map();
        setThreadId(newId());
        chat.setMessages([]);
        setQueue([]);
        setInput("");
        setQuote(null);
        setFiles([]);
        setEditing(null);
    };

    const removeThread = async (id: string) => {
        setThreads((current) => current?.filter((row) => row.id !== id) ?? null);
        const response = await fetch(`/api/polar/threads/${id}`, { method: "DELETE" }).catch(() => null);
        if (!response?.ok) loadThreads();
        if (id === threadId) startNew();
    };

    const addFiles = async (chosen: File[]) => {
        setFileError(null);
        const room = POLAR_ATTACHMENT_MOST - files.length;
        if (chosen.length > room) setFileError(t("files.tooMany", { most: POLAR_ATTACHMENT_MOST }));
        for (const file of chosen.slice(0, Math.max(0, room))) {
            const key = newId();
            const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : "";
            setFiles((current) => [
                ...current,
                { id: key, url: preview, filename: file.name, mediaType: file.type, pending: true }
            ]);
            const stored = await uploadFile(file);
            if (preview) URL.revokeObjectURL(preview);
            if (typeof stored === "string") {
                setFiles((current) => current.filter((entry) => entry.id !== key));
                const code: UploadError = (UPLOAD_ERRORS as readonly string[]).includes(stored)
                    ? (stored as UploadError)
                    : "upload_failed";
                setFileError(t(`files.errors.${code}`, { name: file.name }));
            } else {
                setFiles((current) => current.map((entry) => (entry.id === key ? stored : entry)));
            }
        }
    };

    const switchVersion = (index: number, version: string) => {
        if (busy) return;
        chat.setMessages(pathThrough(tree.current, chat.messages, index, version));
        setTreeTick((tick) => tick + 1);
    };

    const submit = () => {
        const raw = input.trim();
        const ready = files.filter((file) => !file.pending);
        if ((!raw && ready.length === 0) || !choice || files.some((file) => file.pending)) return;
        if (raw === "/new") return startNew();
        if (raw === "/page") {
            setWithPage(true);
            return setInput("");
        }
        if (raw === "/model") {
            setInput("");
            return document.getElementById("polar-model")?.click();
        }
        if (raw === "/file") {
            setInput("");
            return document.getElementById("polar-attach")?.querySelector("button")?.click();
        }
        if (raw === "/tools") {
            setInput("");
            return void chat.sendMessage({ text: t("slash.toolsPrompt") });
        }
        if (raw === "/call") return;
        const text = quote ? `> ${quote}\n\n${raw}` : raw;
        const message = {
            text,
            files: ready.map((file) => ({
                type: "file" as const,
                mediaType: file.mediaType,
                filename: file.filename,
                url: file.url
            }))
        };
        setInput("");
        setQuote(null);
        setFiles([]);
        if (editing) {
            const index = chat.messages.findIndex((entry) => entry.id === editing);
            setEditing(null);
            if (index >= 0 && !busy) {
                // The edited message stays in the tree as the earlier version.
                chat.setMessages(chat.messages.slice(0, index));
                return void chat.sendMessage(message);
            }
        }
        if (busy || waitingApproval) {
            if (queue.length < MAX_QUEUE && text) saveQueue([...queue, { id: newId(), text }]);
            return;
        }
        setLastApproved(false);
        void chat.sendMessage(message);
    };

    const streamingText = chat.status === "streaming" && chat.messages.at(-1)?.parts.at(-1)?.type === "text";
    const mood: PolarMood =
        chat.status === "error"
            ? "trouble"
            : streamingText
              ? "speaking"
              : busy
                ? "thinking"
                : waitingApproval
                  ? "listening"
                  : lastApproved
                    ? "done"
                    : "idle";
    const noKeys = providers !== null && providers.length === 0;
    const slashOpen = input.startsWith("/") && !input.includes(" ");

    return (
        <div className="relative flex h-full min-h-0 flex-1">
            {showHistory ? (
                <nav
                    aria-label={t("history.title")}
                    className={`${fullPage ? "w-64 shrink-0 border-r border-border" : "absolute inset-0 z-10 bg-card"} flex min-h-0 flex-col overflow-y-auto p-2`}
                >
                    <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-foreground-subtle">
                        {t("history.title")}
                        {!fullPage ? (
                            <MessageAction label={t("actions.close")} onClick={() => setShowHistory(false)}>
                                <X />
                            </MessageAction>
                        ) : null}
                    </div>
                    {threads === null ? (
                        <div className="space-y-2 p-2">
                            {[0, 1, 2].map((key) => (
                                <div key={key} className="h-6 rounded bg-muted motion-safe:animate-pulse" />
                            ))}
                        </div>
                    ) : threads.length === 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">{t("history.empty")}</p>
                    ) : (
                        threads.map((row) => (
                            <div
                                key={row.id}
                                className={`group flex min-w-0 items-center rounded-md hover:bg-card-hover ${row.id === threadId ? "bg-card-hover" : ""}`}
                            >
                                <button
                                    type="button"
                                    onClick={() => void openThread(row.id)}
                                    title={row.title}
                                    className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-foreground"
                                >
                                    {row.title}
                                </button>
                                <MessageAction label={t("history.delete")} onClick={() => void removeThread(row.id)}>
                                    <Trash2 />
                                </MessageAction>
                            </div>
                        ))
                    )}
                </nav>
            ) : null}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                    <PolarMascot mood={mood} size={24} label={t(`mood.${mood}`)} />
                    <span className="text-sm font-semibold text-foreground">Polar</span>
                    <span className="flex-1" />
                    <MessageAction label={t("actions.new")} onClick={startNew}>
                        <Plus />
                    </MessageAction>
                    {!fullPage ? (
                        <>
                            <MessageAction label={t("history.title")} onClick={() => setShowHistory(true)}>
                                <History />
                            </MessageAction>
                            <Link
                                href="/polar"
                                aria-label={t("actions.openPage")}
                                title={t("actions.openPage")}
                                className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-card-hover hover:text-foreground"
                            >
                                <Maximize2 className="h-3.5 w-3.5" />
                            </Link>
                            <MessageAction label={t("actions.close")} onClick={() => onClose?.()}>
                                <X />
                            </MessageAction>
                        </>
                    ) : null}
                </div>

                <Conversation>
                    <ConversationContent>
                        {noKeys ? (
                            <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                                <p className="text-foreground">{t("noKeys.title")}</p>
                                <p className="mt-1">{t("noKeys.body")}</p>
                                <div className="mt-2 flex flex-wrap gap-3">
                                    <Link href="/account/ai-keys" className="text-primary hover:underline">
                                        {t("noKeys.own")}
                                    </Link>
                                    {isAdmin ? (
                                        <Link href="/admin/integrations/models" className="text-primary hover:underline">
                                            {t("noKeys.admin")}
                                        </Link>
                                    ) : null}
                                </div>
                            </div>
                        ) : chat.messages.length === 0 ? (
                            <ConversationEmptyState
                                icon={<PolarMascot mood="idle" size={64} />}
                                description={t("empty")}
                            >
                                <Suggestions>
                                    {(["page", "summary", "tools"] as const).map((key) => (
                                        <Suggestion
                                            key={key}
                                            suggestion={t(`suggestions.${key}`)}
                                            onClick={(text) => {
                                                setInput(text);
                                                textarea.current?.focus();
                                            }}
                                        />
                                    ))}
                                </Suggestions>
                            </ConversationEmptyState>
                        ) : null}
                        {chat.messages.map((message, index) => {
                            const versions = versionsOf(tree.current, message.id);
                            const at = versions.indexOf(message.id);
                            return (
                                <MessageView
                                    key={message.id}
                                    message={message}
                                    tools={tools}
                                    last={index === chat.messages.length - 1}
                                    busy={busy}
                                    version={{ current: at + 1, total: versions.length }}
                                    onVersion={(step) => {
                                        const target = versions[at + step];
                                        if (target) switchVersion(index, target);
                                    }}
                                    onApprove={(id, approved) => {
                                        setLastApproved(approved);
                                        void chat.addToolApprovalResponse({ id, approved });
                                    }}
                                    onEdit={() => {
                                        setEditing(message.id);
                                        setInput(textOf(message));
                                        textarea.current?.focus();
                                    }}
                                    onQuote={() => setQuote(textOf(message).slice(0, 200))}
                                    onRegenerate={() => void chat.regenerate()}
                                />
                            );
                        })}
                        {chat.status === "submitted" ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                <PolarMascot mood="thinking" size={18} />
                                <Shimmer>{t("status.thinking")}</Shimmer>
                            </div>
                        ) : null}
                        {chat.error ? (
                            <p
                                role="alert"
                                className="rounded-md border border-danger-edge bg-danger-soft p-2 text-sm text-danger-ink"
                            >
                                {t("errors.failed")}
                            </p>
                        ) : null}
                    </ConversationContent>
                </Conversation>

                {queue.length > 0 ? (
                    <Queue className="mx-3 mb-2">
                        <QueueSection label={t("queue.title")}>
                            {queue.map((item, index) => (
                                <QueueItem
                                    key={item.id}
                                    value={item.text}
                                    labels={{
                                        edit: t("queue.edit"),
                                        up: t("queue.up"),
                                        down: t("queue.down"),
                                        remove: t("queue.remove")
                                    }}
                                    first={index === 0}
                                    last={index === queue.length - 1}
                                    onChange={(text) =>
                                        setQueue(queue.map((entry) => (entry.id === item.id ? { ...entry, text } : entry)))
                                    }
                                    onCommit={() => saveQueue(queue.filter((entry) => entry.text.trim()))}
                                    onUp={() => saveQueue(moveItem(queue, index, index - 1))}
                                    onDown={() => saveQueue(moveItem(queue, index, index + 1))}
                                    onRemove={() => saveQueue(queue.filter((entry) => entry.id !== item.id))}
                                />
                            ))}
                        </QueueSection>
                    </Queue>
                ) : null}

                <div className="shrink-0 border-t border-border p-3">
                    {slashOpen ? (
                        <ul
                            role="listbox"
                            aria-label={t("slash.title")}
                            className="mb-2 rounded-lg border border-border bg-elevated p-1 shadow-popover"
                        >
                            {COMMANDS.filter((command) => `/${command}`.startsWith(input)).map((command) => {
                                const disabled = LATER.has(command);
                                return (
                                    <li key={command}>
                                        <button
                                            type="button"
                                            role="option"
                                            aria-selected={false}
                                            aria-disabled={disabled}
                                            title={disabled ? t("slash.later") : undefined}
                                            onClick={() => {
                                                if (disabled) return;
                                                setInput(`/${command}`);
                                                textarea.current?.focus();
                                            }}
                                            className="flex w-full min-w-0 items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-option-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                                        >
                                            <span className="shrink-0 font-mono text-foreground">/{command}</span>
                                            <span className="min-w-0 truncate text-muted-foreground">
                                                {disabled ? t("slash.later") : t(`slash.${command}`)}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                    <PromptInput onSubmit={submit}>
                        <PromptInputHeader>
                            {context ? (
                                <Chip
                                    title={t("context.title")}
                                    label={context.record?.name ?? context.title ?? context.route}
                                    removeLabel={t("context.remove")}
                                    onRemove={() => setWithPage(false)}
                                />
                            ) : null}
                            {quote ? (
                                <Chip
                                    label={`${t("reply.to")} "${quote}"`}
                                    removeLabel={t("reply.cancel")}
                                    onRemove={() => setQuote(null)}
                                />
                            ) : null}
                            {editing ? (
                                <Chip
                                    label={t("edit.editing")}
                                    removeLabel={t("edit.cancel")}
                                    onRemove={() => setEditing(null)}
                                />
                            ) : null}
                        </PromptInputHeader>
                        {files.length > 0 ? (
                            <Attachments className="mb-2 mt-1">
                                {files.map((file) => (
                                    <Attachment
                                        key={file.id}
                                        file={file}
                                        removeLabel={t("files.remove", { name: file.filename ?? "" })}
                                        onRemove={() => setFiles((current) => current.filter((entry) => entry.id !== file.id))}
                                    />
                                ))}
                            </Attachments>
                        ) : null}
                        {fileError ? (
                            <p role="alert" className="mb-1 text-xs text-danger-ink">
                                {fileError}
                            </p>
                        ) : null}
                        <label htmlFor={fullPage ? "polar-input-page" : "polar-input"} className="sr-only">
                            {t("composer.label")}
                        </label>
                        <PromptInputTextarea
                            ref={textarea}
                            id={fullPage ? "polar-input-page" : "polar-input"}
                            value={input}
                            maxLength={20000}
                            disabled={noKeys}
                            placeholder={t("composer.placeholder")}
                            onChange={(event) => setInput(event.target.value)}
                            onSubmitKey={submit}
                            onPaste={(event) => {
                                const pasted = Array.from(event.clipboardData.files);
                                if (pasted.length > 0) {
                                    event.preventDefault();
                                    void addFiles(pasted);
                                }
                            }}
                        />
                        <PromptInputFooter>
                            <PromptInputTools>
                                <span id="polar-attach" className="contents">
                                    <PromptInputAttach
                                        label={t("files.add")}
                                        accept={POLAR_ATTACHMENT_TYPES}
                                        disabled={noKeys || files.length >= POLAR_ATTACHMENT_MOST}
                                        onFiles={(chosen) => void addFiles(chosen)}
                                    />
                                </span>
                                <span id="polar-model" className="contents">
                                    <ModelSelector providers={providers ?? []} choice={choice} onChoice={setChoice} />
                                </span>
                            </PromptInputTools>
                            <PromptInputSubmit
                                busy={busy}
                                disabled={(!input.trim() && files.length === 0) || !choice || files.some((file) => file.pending)}
                                sendLabel={t("actions.send")}
                                stopLabel={t("actions.stop")}
                                onStop={() => void chat.stop()}
                            />
                        </PromptInputFooter>
                    </PromptInput>
                    <p className="mt-1.5 text-center text-xs text-foreground-subtle">{t("footer")}</p>
                </div>
            </div>
        </div>
    );
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    return next;
}

function Chip({
    label,
    title,
    removeLabel,
    onRemove
}: {
    label: string;
    title?: string;
    removeLabel: string;
    onRemove: () => void;
}) {
    return (
        <span
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            title={title ? `${title}: ${label}` : label}
        >
            <span className="min-w-0 truncate">{label}</span>
            <button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} className="shrink-0">
                <X className="h-3 w-3" />
            </button>
        </span>
    );
}

type ToolPart = {
    type: string;
    state: ToolState;
    toolCallId: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
    approval?: ConfirmationApproval;
};

function MessageView({
    message,
    tools,
    last,
    busy,
    version,
    onVersion,
    onApprove,
    onEdit,
    onQuote,
    onRegenerate
}: {
    message: UIMessage;
    tools: Record<string, ToolDescription>;
    last: boolean;
    busy: boolean;
    version: { current: number; total: number };
    onVersion: (step: -1 | 1) => void;
    onApprove: (id: string, approved: boolean) => void;
    onEdit: () => void;
    onQuote: () => void;
    onRegenerate: () => void;
}) {
    const t = useTranslations("polar");
    const mine = message.role === "user";
    const from = mine ? "user" : "assistant";
    const meta = (message.metadata ?? {}) as { fellBackFrom?: string | null };
    const files = message.parts.filter((part) => part.type === "file");
    const streaming = busy && last;
    const toolName = (name: string) => tools[name]?.title ?? name;
    return (
        <Message from={from}>
            {meta.fellBackFrom ? <p className="text-xs text-warning-ink">{t("errors.modelGone")}</p> : null}
            {files.length > 0 ? (
                <Attachments className={mine ? "justify-end" : undefined}>
                    {files.map((part, index) => (
                        <Attachment
                            key={index}
                            file={{ id: String(index), url: part.url, filename: part.filename, mediaType: part.mediaType }}
                        />
                    ))}
                </Attachments>
            ) : null}
            {message.parts.map((part, index) => {
                if (part.type === "text") {
                    if (!part.text.trim()) return null;
                    return (
                        <MessageContent key={index} from={from}>
                            {mine ? <p className="whitespace-pre-wrap">{part.text}</p> : <MessageResponse>{part.text}</MessageResponse>}
                        </MessageContent>
                    );
                }
                if (part.type === "reasoning") {
                    return (
                        <Reasoning key={index} isStreaming={streaming && index === message.parts.length - 1}>
                            {part.text}
                        </Reasoning>
                    );
                }
                if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                    const tool = part as unknown as ToolPart;
                    const name = part.type === "dynamic-tool" ? (tool.toolName ?? "tool") : part.type.slice(5);
                    const described = tools[name];
                    if (tool.approval) {
                        return (
                            <Confirmation
                                key={index}
                                state={tool.state}
                                approval={tool.approval}
                                action={toolName(name)}
                                affects={affectedBy(tool.input)}
                                destructive={described?.destructive ?? true}
                                input={tool.input}
                                onApprove={() => tool.approval && onApprove(tool.approval.id, true)}
                                onReject={() => tool.approval && onApprove(tool.approval.id, false)}
                            />
                        );
                    }
                    return (
                        <Tool key={index} title={toolName(name)} state={tool.state}>
                            <ToolInput input={tool.input} />
                            <ToolOutput output={tool.output} errorText={tool.errorText} />
                        </Tool>
                    );
                }
                return null;
            })}
            {!streaming ? (
                <MessageActions className="opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <MessageBranchSelector
                        current={version.current}
                        total={version.total}
                        onPrevious={() => onVersion(-1)}
                        onNext={() => onVersion(1)}
                    />
                    {mine ? (
                        <MessageAction label={t("actions.edit")} onClick={onEdit}>
                            <Pencil />
                        </MessageAction>
                    ) : null}
                    <MessageAction label={t("actions.reply")} onClick={onQuote}>
                        <Reply />
                    </MessageAction>
                    <MessageAction
                        label={t("actions.copy")}
                        onClick={() => void navigator.clipboard?.writeText(textOf(message))}
                    >
                        <Copy />
                    </MessageAction>
                    {!mine && last ? (
                        <MessageAction label={t("actions.regenerate")} onClick={onRegenerate}>
                            <RotateCcw />
                        </MessageAction>
                    ) : null}
                </MessageActions>
            ) : null}
        </Message>
    );
}
