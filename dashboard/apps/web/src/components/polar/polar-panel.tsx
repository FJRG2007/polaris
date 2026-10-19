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
import { ArrowDown, ArrowUp, Copy, History, Maximize2, Pencil, Plus, RotateCcw, Square, Trash2, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PolarMascot, type PolarMood } from "@/components/polar/polar-mascot";
import {
    INTELLIGENCE_LEVELS,
    MAX_QUEUE,
    type Intelligence,
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
}

/** Route, title and the ids the URL names, everywhere. */
export function pageContextFrom(pathname: string, title: string, extra: ExtraContext | null): PageContext {
    const segments = pathname.split("/").filter(Boolean);
    const ids: Record<string, string> = {};
    for (let index = 1; index < segments.length; index++) {
        const value = decodeURIComponent(segments[index] ?? "");
        if (/^[0-9a-f-]{8,}$|^\d+$|^[a-z0-9][a-z0-9_.-]{1,63}$/i.test(value) && index > 0) {
            ids[segments[index - 1] ?? `part${index}`] = value;
        }
    }
    return {
        route: pathname,
        title: title.trim() || undefined,
        ids: Object.keys(ids).length ? ids : undefined,
        ...(extra ?? {})
    } as PageContext;
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

interface ProviderOption {
    provider: string;
    name: string;
    payers: Array<"own" | "instance">;
    models: Array<{ provider: string; model: string; name: string; reasoning: boolean }>;
}

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

export function PolarChat({ onClose, fullPage = false }: { onClose?: () => void; fullPage?: boolean }) {
    const t = useTranslations("polar");
    const pathname = usePathname();
    const state = useContext(PolarContext);
    const [threadId, setThreadId] = useState(newId);
    const [providers, setProviders] = useState<ProviderOption[] | null>(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [choice, setChoice] = useState<ModelChoice | null>(null);
    const [input, setInput] = useState("");
    const [quote, setQuote] = useState<string | null>(null);
    const [withPage, setWithPage] = useState(true);
    const [queue, setQueue] = useState<QueuedMessage[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [threads, setThreads] = useState<ThreadRow[] | null>(null);
    const [showHistory, setShowHistory] = useState(fullPage);
    const [lastApproved, setLastApproved] = useState(false);

    const context = useMemo(
        () => (withPage ? pageContextFrom(pathname, typeof document === "undefined" ? "" : document.title, state?.extra ?? null) : null),
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

    // Models: last known value first, then the server's.
    useEffect(() => {
        try {
            const cached = window.localStorage.getItem(CHOICE_KEY);
            if (cached) setChoice(JSON.parse(cached) as ModelChoice);
        } catch {
            // Nothing remembered.
        }
        fetch("/api/polar/models")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { providers: ProviderOption[]; isAdmin: boolean } | null) => {
                if (!data) return setProviders([]);
                setProviders(data.providers);
                setIsAdmin(data.isAdmin);
                setChoice((current) => {
                    const known = data.providers.some((entry) =>
                        entry.models.some((model) => model.provider === current?.provider && model.model === current?.model)
                    );
                    if (current && known) return current;
                    const first = data.providers[0]?.models[0];
                    return first
                        ? { kind: "language", provider: first.provider, model: first.model, intelligence: "balanced", payer: null }
                        : null;
                });
            })
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [busy, waitingApproval, queue.length, chat.status]);

    const openThread = async (id: string) => {
        const response = await fetch(`/api/polar/threads/${id}`).catch(() => null);
        if (!response?.ok) return;
        const { thread } = (await response.json()) as {
            thread: { id: string; messages: UIMessage[]; queue: QueuedMessage[]; choice: ModelChoice | null };
        };
        setThreadId(thread.id);
        chat.setMessages(thread.messages);
        setQueue(thread.queue);
        if (thread.choice) setChoice(thread.choice);
        setShowHistory(fullPage);
    };

    const startNew = () => {
        chat.stop();
        setThreadId(newId());
        chat.setMessages([]);
        setQueue([]);
        setInput("");
        setQuote(null);
    };

    const removeThread = async (id: string) => {
        setThreads((current) => current?.filter((row) => row.id !== id) ?? null);
        const response = await fetch(`/api/polar/threads/${id}`, { method: "DELETE" }).catch(() => null);
        if (!response?.ok) loadThreads();
        if (id === threadId) startNew();
    };

    const submit = () => {
        const raw = input.trim();
        if (!raw || !choice) return;
        if (raw === "/new") return startNew();
        if (raw === "/page") {
            setWithPage(true);
            return setInput("");
        }
        if (raw === "/tools") {
            setInput("");
            return void chat.sendMessage({ text: t("slash.toolsPrompt") });
        }
        const text = quote ? `> ${quote}\n\n${raw}` : raw;
        setInput("");
        setQuote(null);
        if (editing) {
            const index = chat.messages.findIndex((message) => message.id === editing);
            setEditing(null);
            if (index >= 0) {
                chat.setMessages(chat.messages.slice(0, index));
                return void chat.sendMessage({ text });
            }
        }
        if (busy || waitingApproval) {
            if (queue.length < MAX_QUEUE) saveQueue([...queue, { id: newId(), text }]);
            return;
        }
        setLastApproved(false);
        void chat.sendMessage({ text });
    };

    const mood: PolarMood =
        chat.status === "error" ? "trouble" : busy ? "thinking" : waitingApproval ? "listening" : lastApproved ? "done" : "idle";
    const noKeys = providers !== null && providers.length === 0;
    const selected = providers
        ?.flatMap((entry) => entry.models)
        .find((model) => model.provider === choice?.provider && model.model === choice?.model);
    const slashOpen = input.startsWith("/") && !input.includes(" ");
    const commands = ["new", "model", "page", "file", "tools", "call"] as const;

    return (
        <div className="flex h-full min-h-0 flex-1">
            {showHistory ? (
                <nav
                    aria-label={t("history.title")}
                    className={`${fullPage ? "w-64 border-r border-border" : "absolute inset-0 z-10 bg-card"} flex min-h-0 flex-col overflow-y-auto p-2`}
                >
                    <div className="flex items-center justify-between px-2 py-1 text-xs font-medium text-foreground-subtle">
                        {t("history.title")}
                        {!fullPage ? (
                            <IconButton label={t("actions.close")} onClick={() => setShowHistory(false)}>
                                <X className="h-4 w-4" />
                            </IconButton>
                        ) : null}
                    </div>
                    {threads === null ? (
                        <div className="space-y-2 p-2">
                            {[0, 1, 2].map((key) => (
                                <div key={key} className="h-6 animate-pulse rounded bg-muted" />
                            ))}
                        </div>
                    ) : threads.length === 0 ? (
                        <p className="p-2 text-sm text-muted-foreground">{t("history.empty")}</p>
                    ) : (
                        threads.map((row) => (
                            <div key={row.id} className="group flex min-w-0 items-center rounded-md hover:bg-card-hover">
                                <button
                                    type="button"
                                    onClick={() => void openThread(row.id)}
                                    title={row.title}
                                    className="min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm text-foreground"
                                >
                                    {row.title}
                                </button>
                                <IconButton label={t("history.delete")} onClick={() => void removeThread(row.id)}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                </IconButton>
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
                    <IconButton label={t("actions.new")} onClick={startNew}>
                        <Plus className="h-4 w-4" />
                    </IconButton>
                    {!fullPage ? (
                        <>
                            <IconButton label={t("history.title")} onClick={() => setShowHistory(true)}>
                                <History className="h-4 w-4" />
                            </IconButton>
                            <Link
                                href="/polar"
                                aria-label={t("actions.openPage")}
                                title={t("actions.openPage")}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                            >
                                <Maximize2 className="h-4 w-4" />
                            </Link>
                            <IconButton label={t("actions.close")} onClick={() => onClose?.()}>
                                <X className="h-4 w-4" />
                            </IconButton>
                        </>
                    ) : null}
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3" aria-live="polite">
                    {noKeys ? (
                        <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                            <p className="text-foreground">{t("noKeys.title")}</p>
                            <p className="mt-1">{t("noKeys.body")}</p>
                            <div className="mt-2 flex flex-wrap gap-3">
                                <Link href="/account/ai-keys" className="text-primary hover:underline">
                                    {t("noKeys.own")}
                                </Link>
                                {isAdmin ? (
                                    <Link href="/admin/ai-keys" className="text-primary hover:underline">
                                        {t("noKeys.admin")}
                                    </Link>
                                ) : null}
                            </div>
                        </div>
                    ) : chat.messages.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 py-10 text-center">
                            <PolarMascot mood="idle" size={64} />
                            <p className="text-sm text-muted-foreground">{t("empty")}</p>
                        </div>
                    ) : null}
                    {chat.messages.map((message, index) => (
                        <MessageView
                            key={message.id}
                            message={message}
                            last={index === chat.messages.length - 1}
                            busy={busy}
                            onApprove={(id, approved) => {
                                setLastApproved(approved);
                                void chat.addToolApprovalResponse({ id, approved });
                            }}
                            onEdit={() => {
                                setEditing(message.id);
                                setInput(textOf(message));
                            }}
                            onQuote={() => setQuote(textOf(message).slice(0, 200))}
                            onRegenerate={() => void chat.regenerate()}
                        />
                    ))}
                    {busy ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                            <PolarMascot mood="thinking" size={18} />
                            <span className="polar-shimmer">{t("status.thinking")}</span>
                        </div>
                    ) : null}
                    {chat.error ? (
                        <p role="alert" className="rounded-md border border-danger-edge bg-danger-soft p-2 text-sm text-danger-ink">
                            {t("errors.failed")}
                        </p>
                    ) : null}
                </div>

                {queue.length > 0 ? (
                    <ol aria-label={t("queue.title")} className="mx-3 mb-2 space-y-1 rounded-lg border border-border bg-background p-2">
                        <li className="text-xs text-foreground-subtle">{t("queue.title")}</li>
                        {queue.map((item, index) => (
                            <li key={item.id} className="flex min-w-0 items-center gap-1">
                                <input
                                    aria-label={t("queue.edit")}
                                    value={item.text}
                                    maxLength={20000}
                                    onChange={(event) =>
                                        setQueue(queue.map((entry) => (entry.id === item.id ? { ...entry, text: event.target.value } : entry)))
                                    }
                                    onBlur={() => saveQueue(queue.filter((entry) => entry.text.trim()))}
                                    className="h-7 min-w-0 flex-1 rounded border border-border bg-field px-2 text-sm text-foreground"
                                />
                                <IconButton
                                    label={t("queue.up")}
                                    disabled={index === 0}
                                    onClick={() => saveQueue(swap(queue, index, index - 1))}
                                >
                                    <ArrowUp className="h-3.5 w-3.5" />
                                </IconButton>
                                <IconButton
                                    label={t("queue.down")}
                                    disabled={index === queue.length - 1}
                                    onClick={() => saveQueue(swap(queue, index, index + 1))}
                                >
                                    <ArrowDown className="h-3.5 w-3.5" />
                                </IconButton>
                                <IconButton label={t("queue.remove")} onClick={() => saveQueue(queue.filter((entry) => entry.id !== item.id))}>
                                    <X className="h-3.5 w-3.5" />
                                </IconButton>
                            </li>
                        ))}
                    </ol>
                ) : null}

                <div className="shrink-0 border-t border-border p-3">
                    {slashOpen ? (
                        <ul role="listbox" aria-label={t("slash.title")} className="mb-2 rounded-lg border border-border bg-elevated p-1 shadow-popover">
                            {commands
                                .filter((command) => `/${command}`.startsWith(input))
                                .map((command) => {
                                    const disabled = command === "call" || command === "file";
                                    return (
                                        <li key={command}>
                                            <button
                                                type="button"
                                                role="option"
                                                aria-selected={false}
                                                disabled={disabled}
                                                title={disabled ? t("slash.later") : undefined}
                                                onClick={() => setInput(`/${command}`)}
                                                className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-option-hover disabled:opacity-50"
                                            >
                                                <span className="font-mono text-foreground">/{command}</span>
                                                <span className="truncate text-muted-foreground">{t(`slash.${command}`)}</span>
                                            </button>
                                        </li>
                                    );
                                })}
                        </ul>
                    ) : null}
                    <div className="rounded-lg border border-border bg-field p-2 focus-within:border-border-strong">
                        <div className="mb-1 flex flex-wrap gap-1">
                            {context ? (
                                <span className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground" title={t("context.title")}>
                                    <span className="truncate">{context.title ?? context.route}</span>
                                    <button type="button" aria-label={t("context.remove")} onClick={() => setWithPage(false)}>
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            ) : null}
                            {quote ? (
                                <span className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                    <span className="truncate">
                                        {t("reply.to")} &quot;{quote}&quot;
                                    </span>
                                    <button type="button" aria-label={t("reply.cancel")} onClick={() => setQuote(null)}>
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            ) : null}
                            {editing ? (
                                <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                                    {t("edit.editing")}
                                    <button type="button" aria-label={t("edit.cancel")} onClick={() => setEditing(null)}>
                                        <X className="h-3 w-3" />
                                    </button>
                                </span>
                            ) : null}
                        </div>
                        <label htmlFor="polar-input" className="sr-only">
                            {t("composer.label")}
                        </label>
                        <textarea
                            id="polar-input"
                            rows={2}
                            value={input}
                            maxLength={20000}
                            disabled={noKeys}
                            placeholder={t("composer.placeholder")}
                            onChange={(event) => setInput(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    submit();
                                }
                            }}
                            className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-subtle"
                        />
                        <div className="flex items-center gap-1">
                            <ModelPicker providers={providers ?? []} choice={choice} onChoice={setChoice} label={selected?.name ?? t("picker.none")} />
                            <span className="flex-1" />
                            {busy ? (
                                <IconButton label={t("actions.stop")} onClick={() => void chat.stop()}>
                                    <Square className="h-4 w-4" />
                                </IconButton>
                            ) : null}
                            <button
                                type="button"
                                aria-label={t("actions.send")}
                                title={t("actions.send")}
                                disabled={!input.trim() || !choice}
                                onClick={submit}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-50"
                            >
                                <ArrowUp className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                    <p className="mt-1.5 text-center text-xs text-foreground-subtle">{t("footer")}</p>
                </div>
            </div>
            <style>{`@keyframes polar-shimmer{0%{background-position:-200px 0}100%{background-position:200px 0}}.polar-shimmer{background:linear-gradient(90deg,hsl(var(--muted-foreground)) 0,hsl(var(--foreground)) 50%,hsl(var(--muted-foreground)) 100%);background-size:200px 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:polar-shimmer 1.6s linear infinite}@media (prefers-reduced-motion: reduce){.polar-shimmer{animation:none;color:hsl(var(--muted-foreground))}}`}</style>
        </div>
    );
}

function swap<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    if (moved !== undefined) next.splice(to, 0, moved);
    return next;
}

function IconButton({
    label,
    onClick,
    disabled,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground disabled:opacity-40"
        >
            {children}
        </button>
    );
}

function ModelPicker({
    providers,
    choice,
    onChoice,
    label
}: {
    providers: ProviderOption[];
    choice: ModelChoice | null;
    onChoice: (choice: ModelChoice) => void;
    label: string;
}) {
    const t = useTranslations("polar");
    const provider = providers.find((entry) => entry.provider === choice?.provider);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={t("picker.title")}
                    className="inline-flex h-7 min-w-0 max-w-[60%] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
                >
                    <span className="truncate text-foreground">{label}</span>
                    {choice ? <span>{t(`intelligence.${choice.intelligence}`)}</span> : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
                {providers.map((entry) => (
                    <div key={entry.provider}>
                        <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
                        {entry.models.map((model) => (
                            <DropdownMenuItem
                                key={model.model}
                                onSelect={() =>
                                    onChoice({
                                        kind: "language",
                                        provider: model.provider,
                                        model: model.model,
                                        intelligence: choice?.intelligence ?? "balanced",
                                        payer: null
                                    })
                                }
                            >
                                <span className="truncate" title={model.name}>{model.name}</span>
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
                {choice ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("picker.intelligence")}</DropdownMenuLabel>
                        {INTELLIGENCE_LEVELS.map((level: Intelligence) => (
                            <DropdownMenuItem key={level} onSelect={() => onChoice({ ...choice, intelligence: level })}>
                                {t(`intelligence.${level}`)}
                                {choice.intelligence === level ? " *" : ""}
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("picker.payer")}</DropdownMenuLabel>
                        {(provider?.payers ?? []).map((payer) => (
                            <DropdownMenuItem key={payer} onSelect={() => onChoice({ ...choice, payer })}>
                                {t(`picker.${payer}`)}
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem disabled title={t("picker.signinReason")}>
                            <span className="text-foreground-subtle">{t("picker.signin")}</span>
                        </DropdownMenuItem>
                    </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/account/ai-keys">{t("picker.manage")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

type ToolPart = {
    type: string;
    state: string;
    toolCallId: string;
    input?: unknown;
    output?: unknown;
    approval?: { id: string };
};

function MessageView({
    message,
    last,
    busy,
    onApprove,
    onEdit,
    onQuote,
    onRegenerate
}: {
    message: UIMessage;
    last: boolean;
    busy: boolean;
    onApprove: (id: string, approved: boolean) => void;
    onEdit: () => void;
    onQuote: () => void;
    onRegenerate: () => void;
}) {
    const t = useTranslations("polar");
    const mine = message.role === "user";
    const meta = (message.metadata ?? {}) as { fellBackFrom?: string | null; model?: string };
    return (
        <div className={`group flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
            {meta.fellBackFrom ? (
                <p className="text-xs text-warning-ink">{t("errors.modelGone")}</p>
            ) : null}
            {message.parts.map((part, index) => {
                if (part.type === "text") {
                    return (
                        <div
                            key={index}
                            className={`max-w-full whitespace-pre-wrap break-words text-sm ${mine ? "rounded-lg bg-muted px-3 py-2 text-foreground" : "text-foreground"}`}
                        >
                            {part.text}
                        </div>
                    );
                }
                if (part.type === "reasoning") {
                    return (
                        <details key={index} className="text-xs text-muted-foreground">
                            <summary className="cursor-pointer">{t("reasoning")}</summary>
                            <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
                        </details>
                    );
                }
                if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
                    const tool = part as unknown as ToolPart;
                    const name = part.type === "dynamic-tool" ? "tool" : part.type.slice(5);
                    if (tool.state === "approval-requested" && tool.approval) {
                        const approvalId = tool.approval.id;
                        return (
                            <div key={index} className="w-full rounded-lg border border-border bg-background p-3 text-sm">
                                <p className="font-medium text-foreground">{t("approval.title", { tool: name })}</p>
                                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">
                                    {JSON.stringify(tool.input, null, 2)}
                                </pre>
                                <div className="mt-2 flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onApprove(approvalId, true)}
                                        className="h-7 rounded-md bg-primary px-3 text-xs text-primary-foreground"
                                    >
                                        {t("approval.run")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onApprove(approvalId, false)}
                                        className="h-7 rounded-md border border-border px-3 text-xs text-foreground hover:bg-card-hover"
                                    >
                                        {t("approval.deny")}
                                    </button>
                                    <span className="text-xs text-foreground-subtle">{t("approval.runsAsYou")}</span>
                                </div>
                            </div>
                        );
                    }
                    return (
                        <div key={index} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {t(`tool.${tool.state === "output-denied" ? "denied" : tool.state === "output-available" ? "done" : tool.state === "output-error" ? "failed" : "running"}`, { tool: name })}
                        </div>
                    );
                }
                return null;
            })}
            {!busy || !last ? (
                <div className="flex gap-0.5 opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100">
                    {mine ? (
                        <IconButton label={t("actions.edit")} onClick={onEdit}>
                            <Pencil className="h-3.5 w-3.5" />
                        </IconButton>
                    ) : null}
                    <IconButton label={t("actions.reply")} onClick={onQuote}>
                        <RotateCcw className="h-3.5 w-3.5 -scale-x-100" />
                    </IconButton>
                    <IconButton label={t("actions.copy")} onClick={() => void navigator.clipboard?.writeText(textOf(message))}>
                        <Copy className="h-3.5 w-3.5" />
                    </IconButton>
                    {!mine && last ? (
                        <IconButton label={t("actions.regenerate")} onClick={onRegenerate}>
                            <RotateCcw className="h-3.5 w-3.5" />
                        </IconButton>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
