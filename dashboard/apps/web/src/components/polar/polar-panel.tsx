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
import {
    DefaultChatTransport,
    lastAssistantMessageIsCompleteWithApprovalResponses,
    type UIMessage
} from "ai";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode
} from "react";
import {
    cn,
    Dialog,
    CopyIcon,
    useCopied,
    DialogTitle,
    DialogContent,
    useShortcutText
} from "@polaris/ui";
import {
    Cpu,
    FileText,
    History,
    Maximize2,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    Paperclip,
    Pencil,
    Phone,
    Plus,
    Reply,
    RotateCcw,
    SquarePen,
    Wrench,
    X
} from "lucide-react";
import { PolarThreads } from "@/components/polar/polar-threads";
import { usePolarSidebar } from "@/components/polar/use-polar-sidebar";
import {
    firstPickable,
    stepPickable,
    suggestionOptionId,
    SuggestionList,
    type SuggestionListItem
} from "@/components/rich-text/suggestion-list";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { Work } from "@/components/polar/elements/work";
import { Reasoning } from "@/components/polar/elements/reasoning";
import { useExitPresence } from "@/lib/use-exit-presence";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Tool, ToolInput, ToolOutput, type ToolState } from "@/components/polar/elements/tool";
import { PolarMascot, type PolarMood } from "@/components/polar/polar-mascot";
import { Suggestion, Suggestions } from "@/components/polar/elements/suggestion";
import { Queue, QueueItem, QueueSection } from "@/components/polar/elements/queue";
import { learnPath, pathThrough, versionsOf, type VersionTree } from "@/lib/polar/versions";
import { sendFile } from "@/components/transfers/move-file";
import { AttachmentList, type AttachmentData } from "@/components/polar/elements/attachments";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import {
    Conversation,
    ConversationContent,
    ConversationEmptyState
} from "@/components/polar/elements/conversation";
import {
    affectedBy,
    Confirmation,
    type ConfirmationApproval
} from "@/components/polar/elements/confirmation";
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
    polarAttachmentId,
    POLAR_ATTACHMENT_MAX_BYTES,
    POLAR_ATTACHMENT_MOST,
    POLAR_ATTACHMENT_TYPES,
    sendableTail,
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
export function pageContextFrom(
    pathname: string,
    title: string,
    extra: ExtraContext | null
): PageContext {
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
            if (
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey &&
                event.key.toLowerCase() === "j"
            ) {
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
    const shortcut = useShortcutText();
    return (
        <button
            type="button"
            aria-pressed={open}
            title={t("toggle.title", { keys: shortcut("Mod+J") })}
            onClick={() => setOpen(!open)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground aria-pressed:bg-card-hover aria-pressed:text-foreground"
        >
            <PolarMascot size={20} />
            <span className="hidden lg:inline">{t("toggle.label")}</span>
            <kbd className="hidden rounded border border-border px-1 font-mono text-[10px] text-foreground-subtle xl:inline">
                {shortcut("Mod+J")}
            </kbd>
        </button>
    );
}

/** The side panel, rendered by the shell beside the content. */
export function PolarAside() {
    const t = useTranslations("polar");
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
    // Kept on screen while it slides away; the page itself has no side panel.
    const presence = useExitPresence(open && !pathname.startsWith("/polar"));
    if (!presence.mounted) return null;
    return (
        <aside
            aria-label={t("page.title")}
            data-state={presence.state}
            onAnimationEnd={presence.onAnimationEnd}
            style={{ ["--polar-width" as string]: `${width}px` }}
            className="polar-aside fixed inset-0 z-50 flex flex-col overflow-hidden bg-card sm:inset-auto sm:bottom-0 sm:right-0 sm:top-header sm:w-[var(--polar-width)] sm:border-l sm:border-border sm:shadow-popover xl:sticky xl:top-header xl:z-auto xl:h-below-header xl:shrink-0 xl:self-start xl:shadow-none"
        >
            <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startResize}
                className="absolute inset-y-0 left-0 hidden w-1.5 cursor-col-resize hover:bg-primary/30 sm:block"
            />
            {/* Its own width from xl, so growing the panel uncovers it instead of
                squeezing it. */}
            <div className="flex min-h-0 flex-1 flex-col xl:w-[calc(var(--polar-width)-1px)] xl:flex-none">
                <PolarChat onClose={() => setOpen(false)} />
            </div>
        </aside>
    );
}

// ---------------------------------------------------------------------------
// The chat
// ---------------------------------------------------------------------------

const CHOICE_KEY = "polar.choice";

function newId(): string {
    return crypto.randomUUID();
}

function textOf(message: UIMessage): string {
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
}

type ToolDescription = { title: string; writes: boolean; destructive: boolean };
type StoredMessage = UIMessage & { parentId: string | null };

const COMMANDS = ["new", "model", "page", "file", "tools", "call"] as const;
type Command = (typeof COMMANDS)[number];
/** Commands that exist but belong to a later phase. */
const LATER = new Set<Command>(["call"]);
const COMMAND_ICONS: Record<Command, SuggestionListItem["icon"]> = {
    new: Plus,
    model: Cpu,
    page: FileText,
    file: Paperclip,
    tools: Wrench,
    call: Phone
};

/** The "/" commands that start with what has been typed, or none once the
 *  token has a space in it (a command with words after it is a message). */
export function slashMatches(input: string): Command[] {
    if (!input.startsWith("/") || /\s/.test(input)) return [];
    const typed = input.toLowerCase();
    return COMMANDS.filter((command) => `/${command}`.startsWith(typed));
}

const SIDEBAR_KEY = "polar.sidebar";
const WIDE_QUERY = "(min-width: 768px)";

/** Whether the screen is wide enough for the sidebar beside the chat. Wide on
 *  the server and where there is no media query, which is what the CSS also
 *  assumes until the page is live. */
function useWide(): boolean {
    return useSyncExternalStore(
        (notify) => {
            if (typeof window.matchMedia !== "function") return () => undefined;
            const query = window.matchMedia(WIDE_QUERY);
            query.addEventListener("change", notify);
            return () => query.removeEventListener("change", notify);
        },
        () =>
            typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY).matches : true,
        () => true
    );
}

/** A staged file the message cannot go without yet: uploading, or failed. */
function stillStaging(file: AttachmentData): boolean {
    return !!file.pending || !!file.failed;
}

/** The size a file part was sent with, when it was. */
function sizeOf(metadata: unknown): number | undefined {
    const size = (metadata as { polaris?: { size?: unknown } } | undefined)?.polaris?.size;
    return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined;
}

/** Upload refusals the composer explains; anything else reads as a failed upload. */
const UPLOAD_ERRORS = [
    "unsupported_type",
    "too_large",
    "rate_limited",
    "storage_failed",
    "upload_failed"
] as const;
type UploadError = (typeof UPLOAD_ERRORS)[number];

/** Why a file cannot be attached at all, decided before a byte is sent. */
export function refusalOf(file: Pick<File, "type" | "size">): UploadError | null {
    if (!(POLAR_ATTACHMENT_TYPES as readonly string[]).includes(file.type))
        return "unsupported_type";
    if (file.size > POLAR_ATTACHMENT_MAX_BYTES) return "too_large";
    return null;
}

/** The files a paste carries: `files` where the browser fills it, else the items. */
export function pastedFiles(data: DataTransfer): File[] {
    const files = Array.from(data.files ?? []);
    if (files.length > 0) return files;
    return Array.from(data.items ?? []).flatMap((item) => {
        const file = item.kind === "file" ? item.getAsFile() : null;
        return file ? [file] : [];
    });
}

async function uploadFile(
    file: File,
    onProgress: (share: number) => void
): Promise<AttachmentData | string> {
    const sent = await sendFile(
        `/api/polar/attachments?name=${encodeURIComponent(file.name)}`,
        file,
        {
            method: "POST",
            onProgress: (moved, total) => onProgress(total > 0 ? moved / total : 0)
        }
    ).catch(() => null);
    let body: {
        error?: string;
        file?: { id: string; url: string; filename: string; mediaType: string };
    } | null = null;
    try {
        body = sent?.body ? JSON.parse(sent.body) : null;
    } catch {
        body = null;
    }
    if (!sent?.ok || !body?.file) return body?.error ?? "upload_failed";
    return {
        id: body.file.id,
        url: body.file.url,
        filename: body.file.filename,
        mediaType: body.file.mediaType,
        size: file.size
    };
}

export function PolarChat({
    onClose,
    fullPage = false
}: {
    onClose?: () => void;
    fullPage?: boolean;
}) {
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
    const [dragging, setDragging] = useState(false);
    /** The original of each staged file not yet stored, for a retry. */
    const picked = useRef(new Map<string, File>());
    const filesNow = useRef(files);
    filesNow.current = files;
    // The project a new chat is filed under when its first message is sent.
    const [newProject, setNewProject] = useState<string | null>(null);
    const [showHistory, setShowHistory] = useState(fullPage);
    // A deleted conversation that is open is replaced by a new one.
    const removed = useRef<(id: string) => void>(() => undefined);
    const sidebar = usePolarSidebar({
        enabled: showHistory,
        onRemoved: (id) => removed.current(id)
    });
    const [lastApproved, setLastApproved] = useState(false);
    const [collapsed, setCollapsed] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [slashActive, setSlashActive] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const wide = useWide();
    const tree = useRef<VersionTree>(new Map());
    const textarea = useRef<HTMLTextAreaElement>(null);
    const drawerButton = useRef<HTMLButtonElement>(null);
    const composerNext = useRef(false);
    const [, setTreeTick] = useState(0);

    const context = useMemo(
        () =>
            withPage
                ? pageContextFrom(
                      pathname,
                      typeof document === "undefined" ? "" : document.title,
                      state?.extra ?? null
                  )
                : null,
        [withPage, pathname, state?.extra]
    );
    const live = useRef({ threadId, choice, context, newProject });
    live.current = { threadId, choice, context, newProject };

    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: "/api/polar/chat",
                prepareSendMessagesRequest: ({ messages }) => ({
                    body: {
                        threadId: live.current.threadId,
                        messages: sendableTail(messages),
                        choice: live.current.choice,
                        context: live.current.context,
                        projectId: live.current.newProject,
                        parentId:
                            messages.length > 1 ? (messages[messages.length - 2]?.id ?? null) : null
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
                                (model) =>
                                    model.provider === current?.provider &&
                                    model.model === current?.model
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

    // A finished turn moves its conversation to the top of the list, or puts a
    // new one there, so the list is read again once the turn ends.
    const wasBusy = useRef(busy);
    useEffect(() => {
        const ended = wasBusy.current && !busy;
        wasBusy.current = busy;
        if (ended && showHistory) sidebar.refresh(true);
    }, [busy, showHistory, sidebar.refresh]);
    const settled = !busy && chat.messages.length > 0;
    // A new thread is named by its model after the first answer; its title is
    // asked for once, and the placeholder in the list is swapped for it.
    const titled = useRef(new Set<string>());
    useEffect(() => {
        if (!settled || titled.current.has(threadId)) return;
        if (!chat.messages.some((message) => message.role === "assistant")) return;
        titled.current.add(threadId);
        const id = threadId;
        fetch(`/api/polar/threads/${id}/title`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { title?: unknown } | null) => {
                const title = typeof data?.title === "string" ? data.title : null;
                if (title) sidebar.retitle(id, title);
            })
            .catch(() => undefined);
    }, [settled, threadId]);
    // Whether the page's sidebar was put away, remembered per browser.
    useEffect(() => setCollapsed(readStored(SIDEBAR_KEY) === "hidden"), []);
    const setSidebarHidden = (hidden: boolean) => {
        setCollapsed(hidden);
        writeStored(SIDEBAR_KEY, hidden ? "hidden" : "shown");
    };
    // A new "/" opens the list again after Escape closed it.
    useEffect(() => {
        setSlashActive(0);
        if (!input.startsWith("/")) setSlashDismissed(false);
    }, [input]);

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
            thread: {
                id: string;
                projectId: string | null;
                messages: StoredMessage[];
                queue: QueuedMessage[];
                choice: ModelChoice | null;
            };
        };
        // Every stored version goes into the tree; the newest path is shown.
        const next: VersionTree = new Map();
        learnPath(
            next,
            thread.messages,
            new Map(thread.messages.map((message) => [message.id, message.parentId]))
        );
        tree.current = next;
        // A stored thread already has the title it will keep.
        titled.current.add(thread.id);
        const roots = thread.messages.filter((message) => message.parentId === null);
        const newestRoot = roots.at(-1);
        setThreadId(thread.id);
        setNewProject(thread.projectId);
        chat.setMessages(newestRoot ? pathThrough(next, [], 0, newestRoot.id) : []);
        setQueue(thread.queue);
        if (thread.choice) setChoice(thread.choice);
        setShowHistory(fullPage);
        setDrawer(false);
    };

    /** Empties the composer's files, letting go of their local previews. */
    const clearFiles = () => {
        for (const file of filesNow.current) if (file.preview) URL.revokeObjectURL(file.preview);
        picked.current.clear();
        setFiles([]);
        setFileError(null);
    };

    useEffect(
        () => () => {
            for (const file of filesNow.current)
                if (file.preview) URL.revokeObjectURL(file.preview);
        },
        []
    );

    removed.current = (id) => {
        if (id === threadId) startNew();
    };

    const startNew = (projectId: string | null = null) => {
        void chat.stop();
        setNewProject(projectId);
        if (projectId) sidebar.openProject(projectId);
        tree.current = new Map();
        setThreadId(newId());
        chat.setMessages([]);
        setQueue([]);
        setInput("");
        setQuote(null);
        clearFiles();
        setEditing(null);
        composerNext.current = drawer;
        setDrawer(false);
        setShowHistory(fullPage);
        textarea.current?.focus();
    };

    /** Uploads one staged file, drawing its progress, and leaves it ready or failed. */
    const upload = async (key: string, file: File) => {
        const stored = await uploadFile(file, (share) =>
            setFiles((current) =>
                current.map((entry) => (entry.id === key ? { ...entry, progress: share } : entry))
            )
        );
        if (typeof stored === "string") {
            const code: UploadError = (UPLOAD_ERRORS as readonly string[]).includes(stored)
                ? (stored as UploadError)
                : "upload_failed";
            const sentence = t(`files.errors.${code}`, { name: file.name });
            setFiles((current) =>
                current.map((entry) =>
                    entry.id === key ? { ...entry, pending: false, failed: sentence } : entry
                )
            );
            setFileError(sentence);
            return;
        }
        picked.current.delete(key);
        // The local preview stays on the thumbnail until the file leaves the
        // composer, so the picture does not blink while the stored one loads.
        setFiles((current) =>
            current.map((entry) =>
                entry.id === key ? { ...stored, id: entry.id, preview: entry.preview } : entry
            )
        );
    };

    const addFiles = (chosen: File[]) => {
        const refused: string[] = [];
        const accepted = chosen.filter((file) => {
            const refusal = refusalOf(file);
            if (refusal) refused.push(t(`files.errors.${refusal}`, { name: file.name }));
            return !refusal;
        });
        const room = Math.max(0, POLAR_ATTACHMENT_MOST - files.length);
        if (accepted.length > room)
            refused.push(t("files.tooMany", { most: POLAR_ATTACHMENT_MOST }));
        setFileError(refused.length > 0 ? refused.join(" ") : null);
        for (const file of accepted.slice(0, room)) {
            const key = newId();
            const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
            picked.current.set(key, file);
            setFiles((current) => [
                ...current,
                {
                    id: key,
                    url: "",
                    filename: file.name,
                    mediaType: file.type,
                    size: file.size,
                    pending: true,
                    progress: 0,
                    preview
                }
            ]);
            void upload(key, file);
        }
    };

    const retryFile = (file: AttachmentData) => {
        const original = picked.current.get(file.id);
        if (!original) return;
        setFileError(null);
        setFiles((current) =>
            current.map((entry) =>
                entry.id === file.id
                    ? { ...entry, pending: true, progress: 0, failed: undefined }
                    : entry
            )
        );
        void upload(file.id, original);
    };

    const removeFile = (file: AttachmentData) => {
        setFiles((current) => current.filter((entry) => entry.id !== file.id));
        if (file.preview) URL.revokeObjectURL(file.preview);
        picked.current.delete(file.id);
        const stored = file.pending ? null : polarAttachmentId(file.url);
        if (stored) {
            void fetch(`/api/polar/attachments/${encodeURIComponent(stored)}`, {
                method: "DELETE"
            }).catch(() => undefined);
        }
    };

    const switchVersion = (index: number, version: string) => {
        if (busy) return;
        chat.setMessages(pathThrough(tree.current, chat.messages, index, version));
        setTreeTick((tick) => tick + 1);
    };

    /** What a "/" command does, whether it was typed whole or picked from the list. */
    const runCommand = (command: Command) => {
        if (LATER.has(command)) return;
        setInput("");
        if (command === "new") return startNew();
        if (command === "page") return setWithPage(true);
        if (command === "model") return setModelOpen(true);
        if (command === "file") {
            return document
                .getElementById(fullPage ? "polar-attach-page" : "polar-attach")
                ?.querySelector("button")
                ?.click();
        }
        if (command === "tools" && choice && !busy) {
            void chat.sendMessage({ text: t("slash.toolsPrompt") });
        }
    };

    const submit = () => {
        const raw = input.trim();
        const ready = files.filter((file) => !file.pending && !file.failed);
        if ((!raw && ready.length === 0) || !choice || files.some(stillStaging)) return;
        const typed = COMMANDS.find((command) => raw === `/${command}`);
        if (typed) return runCommand(typed);
        const text = quote ? `> ${quote}\n\n${raw}` : raw;
        const message = {
            text,
            files: ready.map((file) => ({
                type: "file" as const,
                mediaType: file.mediaType,
                filename: file.filename,
                url: file.url,
                ...(file.size !== undefined
                    ? { providerMetadata: { polaris: { size: file.size } } }
                    : {})
            }))
        };
        setInput("");
        setQuote(null);
        clearFiles();
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

    const streamingText =
        chat.status === "streaming" && chat.messages.at(-1)?.parts.at(-1)?.type === "text";
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
    const slashItems: SuggestionListItem[] = slashMatches(input).map((command) => ({
        key: command,
        label: `/${command}`,
        detail: LATER.has(command) ? t("slash.later") : t(`slash.${command}`),
        icon: COMMAND_ICONS[command],
        disabled: LATER.has(command)
    }));
    const slashOpen = !slashDismissed && slashItems.length > 0;
    const slashHighlight =
        slashItems[slashActive]?.disabled === false ? slashActive : firstPickable(slashItems);
    const ids = fullPage
        ? { input: "polar-input-page", slash: "polar-slash-page", attach: "polar-attach-page" }
        : { input: "polar-input", slash: "polar-slash", attach: "polar-attach" };
    const pickSlash = (index: number) => {
        const command = slashItems[index]?.key as Command | undefined;
        if (command) runCommand(command);
    };
    // The keys the "/" list answers while it is open, as Chat's does: arrows
    // walk the commands that can run, Enter and Tab run the highlighted one,
    // Escape closes the list and leaves the text as it is.
    const onComposerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (!slashOpen || event.nativeEvent.isComposing) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSlashActive(
                stepPickable(slashItems, slashHighlight, event.key === "ArrowDown" ? 1 : -1)
            );
        } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
            if (slashHighlight < 0) return;
            event.preventDefault();
            pickSlash(slashHighlight);
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setSlashDismissed(true);
        }
    };
    const welcome = fullPage && !noKeys && chat.messages.length === 0;
    const suggestions = (
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
    );
    const threadList = (hide: Parameters<typeof PolarThreads>[0]["hide"]) => (
        <PolarThreads
            sidebar={sidebar}
            activeId={threadId}
            onOpen={(id) => void openThread(id)}
            onNew={startNew}
            hide={hide}
        />
    );
    const sidebarShown = fullPage && wide && !collapsed;

    const queueView =
        queue.length > 0 ? (
            <Queue className="mb-2">
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
                                setQueue(
                                    queue.map((entry) =>
                                        entry.id === item.id ? { ...entry, text } : entry
                                    )
                                )
                            }
                            onCommit={() => saveQueue(queue.filter((entry) => entry.text.trim()))}
                            onUp={() => saveQueue(moveItem(queue, index, index - 1))}
                            onDown={() => saveQueue(moveItem(queue, index, index + 1))}
                            onRemove={() =>
                                saveQueue(queue.filter((entry) => entry.id !== item.id))
                            }
                        />
                    ))}
                </QueueSection>
            </Queue>
        ) : null;

    const composer = (
        <div className="relative">
            {slashOpen ? (
                <SuggestionList
                    id={ids.slash}
                    label={t("slash.title")}
                    items={slashItems}
                    active={slashHighlight}
                    onHover={setSlashActive}
                    onPick={pickSlash}
                    className="absolute bottom-full left-0 z-20 mb-2 w-full max-w-sm"
                />
            ) : null}
            <PromptInput
                onSubmit={submit}
                className={cn(dragging && "border-primary bg-primary/10")}
                onDragOver={(event) => {
                    if (noKeys || !Array.from(event.dataTransfer.types).includes("Files")) return;
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                        setDragging(false);
                }}
                onDrop={(event) => {
                    if (noKeys || !Array.from(event.dataTransfer.types).includes("Files")) return;
                    event.preventDefault();
                    setDragging(false);
                    addFiles(Array.from(event.dataTransfer.files));
                }}
            >
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
                <AttachmentList
                    files={files}
                    className="mb-2 mt-1"
                    onRemove={removeFile}
                    onRetry={retryFile}
                />
                {fileError ? (
                    <p role="alert" className="mb-1 text-xs text-danger-ink">
                        {fileError}
                    </p>
                ) : null}
                <label htmlFor={ids.input} className="sr-only">
                    {t("composer.label")}
                </label>
                <PromptInputTextarea
                    ref={textarea}
                    id={ids.input}
                    value={input}
                    maxLength={20000}
                    disabled={noKeys}
                    placeholder={t("composer.placeholder")}
                    aria-controls={slashOpen ? ids.slash : undefined}
                    aria-activedescendant={
                        slashOpen && slashHighlight >= 0
                            ? suggestionOptionId(ids.slash, slashHighlight)
                            : undefined
                    }
                    onKeyDown={onComposerKey}
                    onChange={(event) => setInput(event.target.value)}
                    onSubmitKey={submit}
                    onPaste={(event) => {
                        const pasted = pastedFiles(event.clipboardData);
                        if (pasted.length > 0) {
                            event.preventDefault();
                            addFiles(pasted);
                        }
                    }}
                />
                <PromptInputFooter>
                    <PromptInputTools>
                        <span id={ids.attach} className="contents">
                            <PromptInputAttach
                                label={t("files.add")}
                                accept={POLAR_ATTACHMENT_TYPES}
                                disabled={noKeys || files.length >= POLAR_ATTACHMENT_MOST}
                                onFiles={addFiles}
                                onFailed={setFileError}
                            />
                        </span>
                        <ModelSelector
                            providers={providers ?? []}
                            choice={choice}
                            onChoice={setChoice}
                            open={modelOpen}
                            onOpenChange={setModelOpen}
                        />
                    </PromptInputTools>
                    <PromptInputSubmit
                        busy={busy}
                        disabled={
                            (!input.trim() && files.length === 0) ||
                            !choice ||
                            files.some(stillStaging)
                        }
                        sendLabel={t("actions.send")}
                        stopLabel={t("actions.stop")}
                        onStop={() => void chat.stop()}
                    />
                </PromptInputFooter>
            </PromptInput>
            <p className="mt-1.5 text-center text-xs text-foreground-subtle">{t("footer")}</p>
        </div>
    );

    return (
        <div className="relative flex h-full min-h-0 min-w-0 flex-1">
            {sidebarShown ? (
                <aside className="hidden w-64 shrink-0 flex-col border-r border-border md:flex">
                    {threadList({
                        label: t("history.hide"),
                        icon: PanelLeftClose,
                        onClick: () => setSidebarHidden(true)
                    })}
                </aside>
            ) : null}
            {fullPage && !wide ? (
                <Dialog open={drawer} onOpenChange={setDrawer}>
                    <DialogContent
                        showClose={false}
                        aria-describedby={undefined}
                        onCloseAutoFocus={(event) => {
                            event.preventDefault();
                            const target = composerNext.current ? textarea : drawerButton;
                            composerNext.current = false;
                            target.current?.focus();
                        }}
                        className="left-0 top-0 flex h-full max-h-none w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none rounded-r-xl border-y-0 border-l-0 bg-card p-0 data-[state=open]:zoom-in-100 data-[state=open]:slide-in-from-left-4"
                    >
                        <DialogTitle className="sr-only">{t("history.title")}</DialogTitle>
                        {threadList({
                            label: t("history.close"),
                            icon: X,
                            onClick: () => setDrawer(false)
                        })}
                    </DialogContent>
                </Dialog>
            ) : null}
            {!fullPage && showHistory ? (
                <div className="absolute inset-0 z-10 flex flex-col bg-card">
                    {threadList({
                        label: t("history.close"),
                        icon: X,
                        onClick: () => setShowHistory(false)
                    })}
                </div>
            ) : null}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <div
                    className={cn(
                        "flex h-11 shrink-0 items-center gap-2 px-3",
                        !fullPage && "border-b border-border"
                    )}
                >
                    {fullPage && (!wide || collapsed) ? (
                        <MessageAction
                            ref={drawerButton}
                            label={t("history.show")}
                            onClick={() => (wide ? setSidebarHidden(false) : setDrawer(true))}
                        >
                            {wide ? <PanelLeftOpen /> : <Menu />}
                        </MessageAction>
                    ) : null}
                    <PolarMascot mood={mood} size={24} label={t(`mood.${mood}`)} />
                    <span className="text-sm font-semibold text-foreground">{t("page.title")}</span>
                    <span className="flex-1" />
                    {fullPage ? (
                        !wide || collapsed ? (
                            <MessageAction label={t("actions.new")} onClick={() => startNew()}>
                                <SquarePen />
                            </MessageAction>
                        ) : null
                    ) : (
                        <>
                            <MessageAction label={t("actions.new")} onClick={() => startNew()}>
                                <Plus />
                            </MessageAction>
                            <MessageAction
                                label={t("history.title")}
                                onClick={() => setShowHistory(true)}
                            >
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
                    )}
                </div>

                {welcome ? (
                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto overscroll-contain px-4 py-6">
                        <div className="flex w-full max-w-3xl flex-col gap-4">
                            <div className="flex flex-col items-center gap-3 text-center">
                                <PolarMascot mood={mood} size={64} />
                                <h1 className="text-xl font-semibold text-foreground">
                                    {t("welcome")}
                                </h1>
                            </div>
                            {queueView}
                            {composer}
                            {suggestions}
                        </div>
                    </div>
                ) : (
                    <>
                        <Conversation>
                            <ConversationContent
                                className={
                                    fullPage ? "mx-auto w-full max-w-3xl px-4 py-6" : undefined
                                }
                            >
                                {noKeys ? (
                                    <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                                        <p className="text-foreground">{t("noKeys.title")}</p>
                                        <p className="mt-1">{t("noKeys.body")}</p>
                                        <div className="mt-2 flex flex-wrap gap-3">
                                            <Link
                                                href="/account/ai-keys"
                                                className="text-primary hover:underline"
                                            >
                                                {t("noKeys.own")}
                                            </Link>
                                            {isAdmin ? (
                                                <Link
                                                    href="/admin/integrations/models"
                                                    className="text-primary hover:underline"
                                                >
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
                                        {suggestions}
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
                        <div
                            className={cn(
                                "shrink-0",
                                fullPage
                                    ? "mx-auto w-full max-w-3xl px-4 pb-3"
                                    : "border-t border-border p-3"
                            )}
                        >
                            {queueView}
                            {composer}
                        </div>
                    </>
                )}
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
            <button
                type="button"
                aria-label={removeLabel}
                title={removeLabel}
                onClick={onRemove}
                className="shrink-0"
            >
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
    const meta = (message.metadata ?? {}) as {
        fellBackFrom?: string | null;
        workedMs?: number;
    };
    const files = message.parts.filter((part) => part.type === "file");
    const streaming = busy && last;
    const toolName = (name: string) => tools[name]?.title ?? name;
    const { copied, copy } = useCopied();
    const toolOf = (part: UIMessage["parts"][number]) => {
        if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") return null;
        const tool = part as unknown as ToolPart;
        const name = part.type === "dynamic-tool" ? (tool.toolName ?? "tool") : part.type.slice(5);
        return { tool, name };
    };
    // Thinking and tool calls fold into one line above the answer. A call
    // waiting for (or given) an approval and a call that failed stay in view.
    const folded = (part: UIMessage["parts"][number]) => {
        if (part.type === "reasoning") return true;
        const found = toolOf(part);
        return !!found && !found.tool.approval && found.tool.state !== "output-error";
    };
    const work = message.parts.filter(folded);
    const toolParts = message.parts.flatMap((part) => {
        const found = toolOf(part);
        return found ? [found] : [];
    });
    const failed = toolParts.filter(({ tool }) => tool.state === "output-error").length;
    const lastWork = message.parts
        .filter((part) => folded(part) || toolOf(part)?.tool.state === "output-error")
        .at(-1);
    const lastTool = lastWork ? toolOf(lastWork) : null;
    const answering = message.parts
        .slice(lastWork ? message.parts.indexOf(lastWork) + 1 : 0)
        .some((part) => part.type === "text" && part.text.trim() !== "");
    const current =
        lastTool &&
        (lastTool.tool.state === "input-streaming" || lastTool.tool.state === "input-available")
            ? toolName(lastTool.name)
            : null;
    const workIndex = message.parts.findIndex(folded);
    const renderTool = (part: UIMessage["parts"][number], index: number, opened = false) => {
        const found = toolOf(part);
        if (!found) return null;
        const { tool, name } = found;
        return (
            <Tool key={index} title={toolName(name)} state={tool.state} defaultOpen={opened}>
                <ToolInput input={tool.input} />
                <ToolOutput output={tool.output} errorText={tool.errorText} />
            </Tool>
        );
    };
    return (
        <Message from={from}>
            {meta.fellBackFrom ? (
                <p className="text-xs text-warning-ink">{t("errors.modelGone")}</p>
            ) : null}
            <AttachmentList
                className={mine ? "justify-end" : undefined}
                files={files.map((part, index) => ({
                    id: String(index),
                    url: part.url,
                    filename: part.filename,
                    mediaType: part.mediaType,
                    size: sizeOf(part.providerMetadata)
                }))}
            />
            {message.parts.map((part, index) => {
                if (index === workIndex) {
                    return (
                        <Work
                            key={`work-${index}`}
                            messageId={message.id}
                            streaming={streaming && !answering}
                            current={current}
                            tools={toolParts.length}
                            failed={failed}
                            seconds={
                                typeof meta.workedMs === "number"
                                    ? Math.max(1, Math.round(meta.workedMs / 1000))
                                    : null
                            }
                        >
                            {work.map((entry) =>
                                entry.type === "reasoning" ? (
                                    <Reasoning
                                        key={message.parts.indexOf(entry)}
                                        isStreaming={false}
                                    >
                                        {entry.text}
                                    </Reasoning>
                                ) : (
                                    renderTool(entry, message.parts.indexOf(entry))
                                )
                            )}
                        </Work>
                    );
                }
                if (folded(part)) return null;
                if (part.type === "text") {
                    if (!part.text.trim()) return null;
                    return (
                        <MessageContent key={index} from={from}>
                            {mine ? (
                                <p className="whitespace-pre-wrap">{part.text}</p>
                            ) : (
                                <MessageResponse>{part.text}</MessageResponse>
                            )}
                        </MessageContent>
                    );
                }
                const found = toolOf(part);
                if (found) {
                    const { tool, name } = found;
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
                    // A failed call stays in view, opened: it may be why the
                    // answer reads the way it does.
                    return renderTool(part, index, true);
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
                        label={copied ? t("actions.copied") : t("actions.copy")}
                        onClick={() => void copy(textOf(message))}
                    >
                        <CopyIcon copied={copied} />
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
