"use client";

/**
 * Polar's panel: the provider every page can feed context to, the header
 * button that opens it (Ctrl/Cmd+J, free in the shortcut table), and the
 * Chat / Code switch at its top (see `./polar-code` for Code's own side).
 *
 * The panel sits right of the content and pushes it on wide screens, floats
 * over it on narrow ones and fills the screen on a phone. Its width is
 * remembered per browser. The chat streams from /api/polar/chat; anything that
 * would change something arrives as a card to approve. Messages typed while a
 * turn runs wait in a queue above the composer, saved with the thread, and go
 * one by one when the turn ends - stopping a turn keeps them.
 */

import Link from "next/link";
import { PolarFailureNotice } from "./polar-failure";
import * as polarFailure from "@/lib/polar/provider-failure";
import { useChat } from "@ai-sdk/react";
import { usePathname, useRouter } from "next/navigation";
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
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode
} from "react";
import {
    cn,
    Button,
    Dialog,
    CopyIcon,
    useCopied,
    useToast,
    DialogTitle,
    DialogContent,
    DropdownMenu,
    DropdownMenuItem,
    DropdownMenuContent,
    DropdownMenuTrigger,
    useShortcutText
} from "@polaris/ui";
import {
    Cpu,
    Gauge,
    FileText,
    GitBranchPlus,
    History,
    Ghost,
    Maximize2,
    MoreHorizontal,
    Settings2,
    Menu,
    PanelLeftClose,
    PanelLeftOpen,
    Paperclip,
    Pencil,
    Phone,
    Plus,
    Reply,
    Share2,
    Square,
    SquarePen,
    Volume2,
    Wrench,
    BookmarkPlus,
    Brain,
    ChartPie,
    CircleHelp,
    Download,
    Eraser,
    Minimize2,
    SquareSlash,
    Zap,
    X
} from "lucide-react";
import { PolarThreads } from "@/components/polar/polar-threads";
import * as toolPrefs from "@/components/polar/tool-prefs";
import { PolarCodeView, PolarModeSwitch, usePolarCode } from "@/components/polar/polar-code";
import * as polarRuns from "@/components/polar/polar-runs";
import * as polarCompare from "@/components/polar/polar-compare";
import * as polarShared from "@/lib/polar/shared";
import * as embedBridge from "@/lib/polar/embed-bridge";
import * as settingsPath from "@/lib/polar/settings-path";
import { SIDEBAR_KEY, THREAD_KEY, readStored, writeStored } from "@/lib/polar/stored";
import { useWide } from "@/components/polar/use-wide";
import * as droppedItems from "@/lib/polar/dropped-items";
import * as polarCommands from "@/components/polar/polar-commands";
import { usePolarSidebar } from "@/components/polar/use-polar-sidebar";
import {
    firstPickable,
    stepPickable,
    suggestionOptionId,
    SuggestionList,
    type SuggestionListItem
} from "@/components/rich-text/suggestion-list";
import { Shimmer } from "@/components/polar/elements/shimmer";
import { BusyVerb } from "@/components/polar/elements/busy-verb";
import { Work } from "@/components/polar/elements/work";
import { Reasoning } from "@/components/polar/elements/reasoning";
import { useExitPresence } from "@/lib/use-exit-presence";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { UsageDialog } from "@/components/polar/polar-usage";
import { ContextBar, ContextDialog, CompactionDivider } from "@/components/polar/polar-context";
import { AnswerSpendLine, answerSpendOf, usePolarDisplay } from "@/components/polar/polar-display";
import {
    compactionOf,
    contextUsed,
    estimateTokens,
    contextWindowOf,
    compactBeforeSending,
    sendableMessages,
    summaryOf
} from "@/lib/polar/compaction";
import { Tool, ToolInput, ToolOutput, type ToolState } from "@/components/polar/elements/tool";
import { avatarStateFor } from "@/components/polar/motion/avatar-engine";
import { PolarAvatar, usePolarOnline } from "@/components/polar/motion/polar-avatar";
import { ThinkingOrb } from "@/components/polar/motion/thinking-orb";
import { orbForActivity, orbForTool } from "@/components/polar/motion/orb-activity";
import { Suggestion, Suggestions } from "@/components/polar/elements/suggestion";
import { WebSources } from "@/components/polar/elements/sources";
import { citeSources, isWebTool, sourcesOf, webCallsOf, webStepOf } from "@/lib/polar/web-sources";
import { answeredNothing } from "@/lib/polar/unanswered";
import { repoStepOf } from "@/lib/polar/code-host";
import {
    noBrowserIn,
    browserStepOf,
    isBrowserTool,
    ALWAYS_SITE_REASON
} from "@/lib/polar/browser-steps";
import { GithubAppGapNotice, gapIdentity, gapsOf } from "@/components/github-app-gap";
import { Queue, QueueItem, QueueSection } from "@/components/polar/elements/queue";
import { learnPath, pathThrough, versionsOf, type VersionTree } from "@/lib/polar/versions";
import { sendFile } from "@/components/transfers/move-file";
import { AttachmentList, type AttachmentData } from "@/components/polar/elements/attachments";
import {
    ModelSelector,
    type ModelSelectorProvider
} from "@/components/polar/elements/model-selector";
import { ConversationEmptyState } from "@/components/polar/elements/conversation";
import { PolarThreadFrame, PolarWelcome } from "@/components/polar/polar-layout";
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
import { PolarComposer, type PolarVoiceKit } from "@/components/polar/polar-composer";
import {
    cleanContextText,
    isAutomatic,
    MAX_QUEUE,
    polarAttachmentId,
    POLAR_ATTACHMENT_MAX_BYTES,
    POLAR_ATTACHMENT_MOST,
    POLAR_ATTACHMENT_TYPES,
    type ModelChoice,
    type PageContext,
    type SiteContext,
    type QueuedMessage
} from "@/lib/polar/shared";
import { screenFor } from "@/lib/polar/screen";
import { titleWithBadge } from "@/lib/favicon-style";
import { isVisualPart, visualOf, visualPartMarkdown } from "@/lib/polar/visuals";
import { PolarVisualView, VisualDrawing } from "@/components/polar/visuals/visual-view";
import { NO_VOICE, type VoiceAvailability } from "@/lib/polar/voice-call";
import { PolarShareDialog } from "@/components/polar/polar-sharing";
import type { PolarMark } from "@/lib/polar/answer-feedback";
import type { PolarRefine } from "@/lib/polar/prompt";
import * as answerActions from "@/components/polar/polar-answer-actions";
import { VoiceCall, type VoiceNotice } from "@/components/polar/polar-voice";

// ---------------------------------------------------------------------------
// Page context
// ---------------------------------------------------------------------------

type ExtraContext = Pick<PageContext, "record" | "selection">;
type PolarMood = "idle" | "thinking" | "listening" | "speaking" | "done" | "trouble";

interface PolarState {
    /** Whether this account may use Polar at all: the same answer every Polar
     *  route gives, read once by the shell. Nothing of Polar is drawn without it. */
    allowed: boolean;
    open: boolean;
    setOpen: (open: boolean) => void;
    extra: ExtraContext | null;
    setExtra: (extra: ExtraContext | null) => void;
    /** Text somebody asked Polar about from a menu, waiting for a chat to
     *  quote it. Taken once, by whichever chat is on screen. */
    asked: string | null;
    /** A question typed in the composer from outside it - the extension's
     *  right-click menu - taken with `asked`. */
    drafted: string | null;
    /** Quotes `text` in the composer, types `draft` under it, and opens the
     *  panel. Does nothing for an account Polar is not for. */
    ask: (text: string, draft?: string) => void;
    takeAsked: () => void;
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

/** For a server-rendered screen: declares the record it shows, by name. */
export function PolarRecord({ kind, id, name }: { kind: string; id: string; name?: string }) {
    usePolarContext({ record: { kind, id, name } });
    return null;
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
    // The address says which app, section and record this is; a screen that
    // knows more (the record's name, a selection) says so with usePolarContext.
    const screen = screenFor(pathname);
    const declared = extra?.record ?? screen.record;
    const recordId = declared ? cleanContextText(declared.id) : "";
    const recordKind = declared ? cleanContextText(declared.kind) : "";
    const selection = (extra?.selection ?? []).map(cleanContextText).filter(Boolean).slice(0, 20);
    return {
        route: pathname,
        // The tab's title carries what is waiting in front of it ("(1) Chat"),
        // which is the tab's business and not the page's name.
        title: cleanContextText(titleWithBadge(title, null)) || undefined,
        app: screen.app ? cleanContextText(screen.app) || undefined : undefined,
        section: screen.section ? cleanContextText(screen.section) || undefined : undefined,
        ids: Object.keys(ids).length ? ids : undefined,
        record:
            recordId && recordKind
                ? {
                      kind: recordKind,
                      id: recordId,
                      name: cleanContextText(declared?.name ?? "") || undefined
                  }
                : undefined,
        selection: selection.length ? selection : undefined
    };
}

const OPEN_KEY = "polar.open";
const WIDTH_KEY = "polar.width";
/** The scoped chats remembered, newest last, so the oldest can be let go. */
const SCOPES_KEY = "polar.thread.scopes";
const SCOPES_MOST = 30;

/** Where the open chat is remembered: the shared key, or one per scope. */
export function scopedThreadKey(scope: string | null): string {
    return scope ? `${THREAD_KEY}:${scope}` : THREAD_KEY;
}

/** Remember a scoped chat's key, forgetting the oldest beyond the most kept:
 *  a tab's key is never asked for again once it closes, so it would stay forever. */
function keepScope(key: string): void {
    let kept: string[] = [];
    try {
        const parsed: unknown = JSON.parse(readStored(SCOPES_KEY) ?? "[]");
        if (Array.isArray(parsed))
            kept = parsed.filter((one): one is string => typeof one === "string");
    } catch {
        kept = [];
    }
    const next = [...kept.filter((one) => one !== key), key];
    for (const old of next.splice(0, Math.max(0, next.length - SCOPES_MOST))) {
        try {
            window.localStorage.removeItem(old);
        } catch {
            // A private window: nothing was kept to let go of.
        }
    }
    writeStored(SCOPES_KEY, JSON.stringify(next));
}
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

export function PolarProvider({
    allowed = true,
    children
}: {
    allowed?: boolean;
    children: ReactNode;
}) {
    const [stored, setOpenState] = useState(false);
    const open = allowed && stored;
    const [extra, setExtra] = useState<ExtraContext | null>(null);
    /** When this page's own Ctrl+J last toggled the panel. */
    const lastKey = useRef(0);
    useEffect(() => setOpenState(readStored(OPEN_KEY) === "1"), []);
    const setOpen = useCallback((next: boolean) => {
        setOpenState(next);
        writeStored(OPEN_KEY, next ? "1" : "0");
    }, []);
    useEffect(() => {
        if (!allowed) return;
        function onKey(event: KeyboardEvent) {
            if (
                (event.ctrlKey || event.metaKey) &&
                !event.altKey &&
                !event.shiftKey &&
                event.key.toLowerCase() === "j"
            ) {
                event.preventDefault();
                lastKey.current = Date.now();
                setOpenState((current) => {
                    writeStored(OPEN_KEY, current ? "0" : "1");
                    return !current;
                });
            }
        }
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [allowed]);
    const [asked, setAsked] = useState<string | null>(null);
    const [drafted, setDrafted] = useState<string | null>(null);
    const ask = useCallback(
        (text: string, draft?: string) => {
            const quote = polarShared.selectionQuote(text);
            const typed = draft?.trim().slice(0, 2000) || null;
            if (!allowed || (!quote && !typed)) return;
            setAsked(quote);
            setDrafted(typed);
            setOpen(true);
        },
        [allowed, setOpen]
    );
    const takeAsked = useCallback(() => {
        setAsked(null);
        setDrafted(null);
    }, []);
    // The browser extension on this page: its shortcut is this page's Ctrl+J,
    // which the browser hands to the extension first, so the extension passes
    // it on here (`polarCommandFrom`). A press that reached this page as well
    // is not counted twice.
    useEffect(() => {
        if (!allowed) return;
        function onMessage(event: MessageEvent) {
            const command = embedBridge.polarCommandFrom(event, window);
            if (!command) return;
            if (command.action === "toggle") {
                if (Date.now() - lastKey.current < 500) return;
                setOpenState((current) => {
                    writeStored(OPEN_KEY, current ? "0" : "1");
                    return !current;
                });
                return;
            }
            if (command.quote || command.draft) ask(command.quote ?? "", command.draft);
            else setOpen(true);
        }
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [allowed, ask, setOpen]);
    const value = useMemo(
        () => ({ allowed, open, setOpen, extra, setExtra, asked, drafted, ask, takeAsked }),
        [allowed, open, setOpen, extra, asked, drafted, ask, takeAsked]
    );
    return <PolarContext.Provider value={value}>{children}</PolarContext.Provider>;
}

/** Whether this address is Polar's own page, where the side panel has no place:
 *  the page is the same chat, full size. Exact, so `/polaris-...` is not it. */
export function onPolarPage(pathname: string): boolean {
    return pathname === "/polar" || pathname.startsWith("/polar/");
}

/** The header button. */
export function PolarToggle() {
    const t = useTranslations("polar");
    const { allowed, open, setOpen } = usePolar();
    const online = usePolarOnline();
    const shortcut = useShortcutText();
    const pathname = usePathname();
    // Hidden rather than offered: the administrator keeps Polar to some people,
    // and a button that only ever answers "not for you" is noise in the header.
    // On Polar's own page it would open a second copy of the chat on screen.
    if (!allowed || onPolarPage(pathname)) return null;
    return (
        <button
            type="button"
            aria-pressed={open}
            title={t("toggle.title", { keys: shortcut("Mod+J") })}
            onClick={() => setOpen(!open)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground aria-pressed:bg-card-hover aria-pressed:text-foreground"
        >
            <PolarAvatar size={20} state={avatarStateFor({ open, online, busy: false })} />
            <span className="hidden lg:inline">{t("toggle.label")}</span>
            <kbd className="hidden rounded border border-border px-1 font-mono text-[10px] text-foreground-subtle xl:inline">
                {shortcut("Mod+J")}
            </kbd>
        </button>
    );
}

/** The side panel, rendered by the shell beside the content. */
export function PolarAside() {
    const { allowed } = usePolar();
    return allowed ? <PolarAsideOpen /> : null;
}

function PolarAsideOpen() {
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
    const presence = useExitPresence(open && !onPolarPage(pathname));
    if (!presence.mounted) return null;
    return (
        <aside
            aria-label={t("page.title")}
            data-state={presence.state}
            onAnimationEnd={presence.onAnimationEnd}
            style={{ ["--polar-width" as string]: `${width}px` }}
            className="polar-aside fixed inset-0 z-50 flex flex-col overflow-hidden bg-card sm:inset-auto sm:bottom-0 sm:right-0 sm:top-header sm:w-[var(--polar-width)] sm:border-l sm:border-border sm:shadow-popover xl:static xl:z-auto xl:h-auto xl:shrink-0 xl:shadow-none"
        >
            <div
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startResize}
                className="absolute inset-y-0 left-0 hidden w-1.5 cursor-col-resize hover:bg-primary/30 sm:block"
            />
            {/* Its own width from xl, so growing the panel uncovers it instead of
                squeezing it. */}
            <div className="flex min-h-0 flex-1 flex-col xl:w-[calc(var(--polar-width)-1px)]">
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

/** A message's words alone, without the views it drew: what is read aloud. */
function wordsOf(message: UIMessage): string {
    return message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
}

/** A message as text: its words, and each view it drew as Markdown. */
function textOf(message: UIMessage): string {
    return message.parts
        .map((part) => {
            if (part.type === "text") return part.text;
            const visual = visualPartMarkdown(part as never);
            return visual ? `\n\n${visual}\n\n` : "";
        })
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

type ToolDescription = { title: string; writes: boolean; destructive: boolean; connector?: string };
type StoredMessage = UIMessage & { parentId: string | null };

const COMMANDS = polarShared.POLAR_BUILTIN_COMMANDS;
type Command = polarShared.BuiltinCommand;
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

type Control = polarShared.ControlCommand;
const CONTROLS = polarShared.POLAR_CONTROL_COMMANDS;
const CONTROL_ICONS: Record<Control, SuggestionListItem["icon"]> = {
    clear: Eraser,
    compact: Minimize2,
    context: ChartPie,
    usage: Gauge,
    rename: Pencil,
    export: Download,
    branch: GitBranchPlus,
    temp: Ghost,
    memory: Brain,
    help: CircleHelp
};
/** Control commands that take words after them, so picking one from the list
 *  puts it in the box instead of running it. */
const TAKES_TEXT = new Set<Control>(["rename"]);

/** One row of the "/" list: a command of Polar's, one that acts on the chat
 *  itself, or one of the person's own. */
export type SlashMatch =
    | { kind: "builtin"; command: Command }
    | { kind: "control"; command: Control }
    | { kind: "own"; row: polarShared.PolarCommandRow };

/** How well a shortcut answers what was typed after the "/": 0 when it starts
 *  with it, 1 when it holds it, 2 when it holds its letters in order; null when
 *  it does not match at all. */
export function shortcutRank(shortcut: string, query: string): number | null {
    if (shortcut.startsWith(query)) return 0;
    if (shortcut.includes(query)) return 1;
    let at = 0;
    for (const letter of shortcut) if (letter === query[at]) at++;
    return at === query.length ? 2 : null;
}

function ranked<T>(items: readonly T[], key: (item: T) => string, query: string): T[] {
    return items
        .map((item, index) => ({ item, index, rank: shortcutRank(key(item), query) }))
        .filter((entry): entry is { item: T; index: number; rank: number } => entry.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((entry) => entry.item);
}

/** The "/" commands that match what has been typed, Polar's first and the
 *  person's own after, or none once the token has a space in it (a command
 *  with words after it is a message). */
export function slashMatches(
    input: string,
    own: readonly polarShared.PolarCommandRow[] = []
): SlashMatch[] {
    if (!input.startsWith("/") || /\s/.test(input)) return [];
    const query = input.slice(1).toLowerCase();
    return [
        ...ranked(COMMANDS, (command) => command, query).map((command): SlashMatch => ({
            kind: "builtin",
            command
        })),
        ...ranked(CONTROLS, (command) => command, query).map((command): SlashMatch => ({
            kind: "control",
            command
        })),
        ...ranked(own, (row) => row.shortcut, query).map((row): SlashMatch => ({
            kind: "own",
            row
        }))
    ];
}

/** The person's command a message starts with, and what follows its shortcut. */
export function ownCommandIn(
    raw: string,
    own: readonly polarShared.PolarCommandRow[]
): { row: polarShared.PolarCommandRow; rest: string } | null {
    const found = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
    if (!found) return null;
    const shortcut = polarShared.normalizeShortcut(found[1] ?? "");
    const row = own.find((entry) => entry.shortcut === shortcut);
    return row ? { row, rest: found[2] ?? "" } : null;
}

const NEW_COMMAND = "new-command";

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
    "upload_failed",
    "not_found"
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

/** An item dragged in from another app, stored by the server as the caller. */
async function attachItem(item: droppedItems.DroppedItem): Promise<AttachmentData | string> {
    const response = await fetch("/api/polar/attachments/item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item })
    }).catch(() => null);
    const body = response
        ? ((await response.json().catch(() => null)) as {
              error?: string;
              file?: { id: string; url: string; filename: string; mediaType: string; size: number };
          } | null)
        : null;
    if (!response?.ok || !body?.file) return body?.error ?? "upload_failed";
    return { ...body.file };
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
    fullPage = false,
    site,
    chatScope = null
}: {
    onClose?: () => void;
    fullPage?: boolean;
    /** A conversation of its own to come back to - the extension's panel, one
     *  per tab - instead of the one every Polar here shares. */
    chatScope?: string | null;
    /**
     * A page outside Polaris standing in for this one: the browser extension's
     * side panel passes the tab somebody allowed (or null while none is), and
     * the Polaris address the chat itself sits on is then nobody's business.
     */
    site?: SiteContext | null;
}) {
    const t = useTranslations("polar");
    const pathname = usePathname();
    const state = useContext(PolarContext);
    const [threadId, setThreadId] = useState(newId);
    // What a chat opens with. `useChat` makes a new chat for every id, so the
    // messages of a thread being opened go in with its id: set on the chat it
    // had before, they would land on the one being replaced, and the thread
    // opened empty until a second click found its id already in place.
    const [opening, setOpening] = useState<UIMessage[]>([]);
    const [providers, setProviders] = useState<ModelSelectorProvider[] | null>(null);
    const [tools, setTools] = useState<Record<string, ToolDescription>>({});
    const [isAdmin, setIsAdmin] = useState(false);
    const [spendsDeployment, setSpendsDeployment] = useState(true);
    const [voice, setVoice] = useState<VoiceAvailability>(NO_VOICE);
    /** The mic menu's model: shown at once, stored behind it, put back if the
     *  store refuses. */
    const chooseTranscriber = useCallback((id: string) => {
        let before: string | null = null;
        setVoice((current) => {
            before = current.transcriber;
            return { ...current, transcriber: id };
        });
        void fetch("/api/polar/preferences", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ transcriptionModel: id })
        })
            .then((response) => {
                if (!response.ok) throw new Error(String(response.status));
            })
            .catch(() => {
                setVoice((current) =>
                    current.transcriber === id ? { ...current, transcriber: before } : current
                );
                setVoiceNotice("modelNotSaved");
            });
    }, []);
    const [voiceNotice, setVoiceNotice] = useState<VoiceNotice | null>(null);
    const [inCall, setInCall] = useState(false);
    const [choice, setChoice] = useState<ModelChoice | null>(null);
    const [input, setInput] = useState("");
    const [quote, setQuote] = useState<string | null>(null);
    /** "/page" with the page switched off in settings: the page goes with the
     *  next message only. */
    const pageOnce = useRef(false);
    const [queue, setQueue] = useState<QueuedMessage[]>([]);
    const [editing, setEditing] = useState<string | null>(null);
    const [files, setFiles] = useState<AttachmentData[]>([]);
    const [fileError, setFileError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    /** The original of each staged file not yet stored, for a retry. */
    const picked = useRef(new Map<string, File>());
    /** Likewise for items dragged in from another app. */
    const dropped = useRef(new Map<string, droppedItems.DroppedItem>());
    const filesNow = useRef(files);
    filesNow.current = files;
    // The project a new chat is filed under when its first message is sent.
    const [newProject, setNewProject] = useState<string | null>(null);
    const [showHistory, setShowHistory] = useState(fullPage);
    // One question asked of several models, laid out side by side.
    const [comparison, setComparison] = polarCompare.useComparison(fullPage);
    // A deleted conversation that is open is replaced by a new one.
    const removed = useRef<(id: string) => void>(() => undefined);
    const sidebar = usePolarSidebar({
        enabled: showHistory,
        onRemoved: (id) => removed.current(id)
    });
    const [lastApproved, setLastApproved] = useState(false);
    const [stopped, setStopped] = useState<string | null>(null);
    const [collapsed, setCollapsed] = useState(false);
    const [drawer, setDrawer] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    /** The microphone's needs, shared by Chat's composer and Code's. */
    const voiceKit = useMemo<PolarVoiceKit>(
        () => ({
            voice,
            payer: choice?.payer ?? null,
            onTranscriber: chooseTranscriber,
            isAdmin
        }),
        [voice, choice?.payer, chooseTranscriber, isAdmin]
    );
    // New chats are temporary while this is on: not listed, no memory, deleted
    // when the chat is left. It stays on for the next new chat, as ChatGPT's does.
    const [temporary, setTemporary] = useState(false);
    // Web search: the administrator's to allow (`webAllowed`, from the server)
    // and this viewer's to switch off; on unless either did. Taken as allowed
    // until the server says otherwise - it was read as "not allowed" before,
    // so a slow or failed models answer showed web search off to everybody.
    // The chat route still drops it for a deployment that turned it off.
    const [webAllowed, setWebAllowed] = useState(true);
    // What this viewer switched off in Polar's settings, kept in step with the
    // settings page while this panel stays open.
    const { prefs } = toolPrefs.useToolPrefs();
    const router = useRouter();
    const [slashActive, setSlashActive] = useState(0);
    const [slashDismissed, setSlashDismissed] = useState(false);
    const commands = polarCommands.usePolarCommands();
    const [commandDraft, setCommandDraft] = useState<polarCommands.CommandDraft | null>(null);
    const [managing, setManaging] = useState(false);
    const [showUsage, setShowUsage] = useState(false);
    const [showContext, setShowContext] = useState(false);
    const [compacting, setCompacting] = useState(false);
    const display = usePolarDisplay();
    /** The model one turn is sent on instead of the chosen one: a command's. */
    const turnChoice = useRef<ModelChoice | null>(null);
    /** How the next answer asked again from its row should change; read once. */
    const refine = useRef<PolarRefine | null>(null);
    /** This person's marks on the answers of the open chat, by message id. */
    const [marks, setMarks] = useState<Record<string, PolarMark>>({});
    /** The answer a share is being made from. */
    const [sharingFrom, setSharingFrom] = useState<string | null>(null);
    const wide = useWide();
    // Chat or Code: Code is Agents sessions, drawn over the chat (which keeps its draft).
    const code = usePolarCode();
    const tree = useRef<VersionTree>(new Map());
    const textarea = useRef<HTMLTextAreaElement>(null);
    // Text asked about from a right-click menu: quoted here, once, with the
    // question typed under it when the menu brought one.
    const asked = state?.asked ?? null;
    const drafted = state?.drafted ?? null;
    useEffect(() => {
        if (!asked && !drafted) return;
        if (asked) setQuote(asked);
        if (drafted) setInput(drafted);
        state?.takeAsked();
        textarea.current?.focus();
    }, [asked, drafted]);
    const threadKey = scopedThreadKey(chatScope);
    const drawerButton = useRef<HTMLButtonElement>(null);
    const composerNext = useRef(false);
    const [, setTreeTick] = useState(0);
    const toast = useToast();

    // The page this person is on, sent as background context and never shown
    // in the composer: whether it goes is the "Share the page you're on"
    // switch in Polar's settings. Polar's own screens are not a page to ask
    // about - "/polar" under Polar is the chat quoting itself.
    const context = useMemo(
        () =>
            site !== undefined
                ? site && { route: pathname, title: site.title, site }
                : onPolarPage(pathname)
                  ? null
                  : pageContextFrom(
                        pathname,
                        typeof document === "undefined" ? "" : document.title,
                        state?.extra ?? null
                    ),
        [pathname, state?.extra, site]
    );
    const pageOn = prefs.pageOn;
    const web = webAllowed && prefs.webOn;
    const toolsOff = prefs.toolsOff;
    const serversOff = toolPrefs.serversOffOf(prefs, tools);
    const connectorsOn = !prefs.connectorsOff;
    const live = useRef({
        threadId,
        choice,
        context,
        pageOn,
        newProject,
        temporary,
        turnChoice,
        refine,
        web,
        toolsOff,
        serversOff,
        connectorsOn
    });
    live.current = {
        threadId,
        choice,
        context,
        pageOn,
        newProject,
        temporary,
        turnChoice,
        refine,
        web,
        toolsOff,
        serversOff,
        connectorsOn
    };

    /** The page as it goes with the next turn: null with sharing off. */
    const sharedContext = () =>
        live.current.pageOn || pageOnce.current ? live.current.context : null;
    /** The page the message just sent took with it, for its own request only. */
    const pageTurn = useRef<ReturnType<typeof sharedContext>>(null);

    const transport = useMemo(
        () =>
            new DefaultChatTransport({
                api: "/api/polar/chat",
                prepareSendMessagesRequest: ({ messages }) => {
                    // Asked for one answer: the turns after it are plain.
                    const refining = live.current.refine.current;
                    live.current.refine.current = null;
                    const context = live.current.pageOn ? live.current.context : pageTurn.current;
                    pageTurn.current = null;
                    return {
                        body: {
                            threadId: live.current.threadId,
                            messages: sendableMessages(messages),
                            // A command's model answers its own turn only; the
                            // thread stays on the chosen one.
                            choice: live.current.turnChoice.current ?? live.current.choice,
                            remember: live.current.turnChoice.current === null,
                            context,
                            projectId: live.current.newProject,
                            temporary: live.current.temporary,
                            web: live.current.web,
                            off: live.current.toolsOff,
                            serversOff: live.current.serversOff,
                            connectors: live.current.connectorsOn,
                            refine: refining,
                            parentId:
                                messages.length > 1
                                    ? (messages[messages.length - 2]?.id ?? null)
                                    : null
                        }
                    };
                }
            }),
        []
    );
    const chat = useChat({
        id: threadId,
        messages: opening,
        transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
        // An answer keeps running after its chat is left; opening the chat
        // again picks it up where it is (`chat/[id]/stream`).
        resume: true
    });
    const busy = chat.status === "submitted" || chat.status === "streaming";
    const runMarks = polarRuns.usePolarRuns(showHistory, busy);
    /** The stop button: leaving a chat never stops its answer, this does. */
    const stopAnswer = () =>
        Promise.all([chat.stop(), polarRuns.stopPolarAnswer(live.current.threadId)]);
    const online = usePolarOnline();
    const avatarState = avatarStateFor({ open: true, online, busy });
    // A failure the answer itself carries is drawn with it; the error alone is
    // for a turn that never got an answer to carry one, a dropped connection.
    const looseError =
        chat.error && !polarFailure.messageFailure(chat.messages.at(-1)) ? chat.error : null;
    const stopTurn = () => {
        setStopped(chat.messages.at(-1)?.id ?? null);
        void stopAnswer();
    };
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
                        voice?: VoiceAvailability;
                        spendsDeployment?: boolean;
                        connectors?: boolean;
                        web?: boolean;
                    } | null
                ) => {
                    if (!data) return setProviders([]);
                    setProviders(data.providers);
                    setTools(data.tools ?? {});
                    setIsAdmin(data.isAdmin);
                    setSpendsDeployment(data.spendsDeployment ?? true);
                    setVoice({ ...NO_VOICE, ...data.voice });
                    setWebAllowed(data.web === true);
                    setChoice((current) => {
                        // Automatic stays while there is any model to pick from.
                        if (isAutomatic(current) && data.providers.length > 0) return current;
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
    const askTitle = (id: string) => {
        if (titled.current.has(id)) return;
        titled.current.add(id);
        fetch(`/api/polar/threads/${id}/title`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { title?: unknown } | null) => {
                const title = typeof data?.title === "string" ? data.title : null;
                if (title) sidebar.retitle(id, title);
            })
            .catch(() => undefined);
    };
    useEffect(() => {
        if (!settled) return;
        if (!chat.messages.some((message) => message.role === "assistant")) return;
        askTitle(threadId);
    }, [settled, threadId]);
    // The suggested next message (`lib/polar/suggestions.ts`): asked for once
    // after an answer finishes in this tab, never for one only opened, and
    // shown greyed in the empty composer until Tab takes it, Escape or typing
    // dismisses it, or the next answer replaces it. Voice mode has none.
    const [suggested, setSuggested] = useState<{
        threadId: string;
        answerId: string;
        text: string;
    } | null>(null);
    const suggestionAsked = useRef(new Set<string>());
    const answeredHere = useRef<string | null>(null);
    useEffect(() => {
        if (busy) answeredHere.current = threadId;
    }, [busy, threadId]);
    const newest = settled ? chat.messages.at(-1) : undefined;
    const answerId = newest?.role === "assistant" ? newest.id : null;
    useEffect(() => {
        if (!display.suggestions || inCall || !answerId || chat.status === "error") return;
        if (answeredHere.current !== threadId) return;
        const key = `${threadId}:${answerId}`;
        if (suggestionAsked.current.has(key)) return;
        suggestionAsked.current.add(key);
        const id = threadId;
        fetch(`/api/polar/threads/${id}/suggestion?after=${encodeURIComponent(answerId)}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { suggestion?: unknown } | null) => {
                const text = typeof data?.suggestion === "string" ? data.suggestion.trim() : "";
                if (text) setSuggested({ threadId: id, answerId, text });
            })
            .catch(() => undefined);
    }, [display.suggestions, inCall, answerId, threadId, chat.status]);
    const ghost =
        suggested &&
        suggested.threadId === threadId &&
        suggested.answerId === answerId &&
        display.suggestions &&
        !inCall &&
        !input
            ? suggested.text
            : null;
    const acceptSuggestion = (text: string) => {
        setSuggested(null);
        setInput(text);
        // Into the box with the cursor at its end, ready to edit - never sent.
        requestAnimationFrame(() => {
            const box = textarea.current;
            if (!box) return;
            box.focus();
            box.setSelectionRange(text.length, text.length);
        });
    };
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

    // An answer being read stops with the chat that shows it.
    useEffect(() => () => answerActions.stopReading(), []);

    // This person's marks on the open chat's answers, read once per chat.
    useEffect(() => {
        setMarks({});
        let current = true;
        fetch(`/api/polar/feedback?thread=${threadId}`)
            .then((response) => (response.ok ? response.json() : null))
            .then((data: { marks?: Record<string, PolarMark> } | null) => {
                if (current && data?.marks) setMarks(data.marks);
            })
            .catch(() => undefined);
        return () => {
            current = false;
        };
    }, [threadId]);

    /** Marks an answer at once, and puts the mark back if the server refuses. */
    const markAnswer = async (
        messageId: string,
        change: answerActions.MarkChange
    ): Promise<boolean> => {
        const before = marks[messageId];
        const next = change.rating
            ? {
                  rating: change.rating,
                  reasons: change.rating === "bad" ? (change.reasons ?? []) : [],
                  note: change.rating === "bad" ? (change.note ?? null) : null
              }
            : null;
        const put = (mark: PolarMark | null | undefined) =>
            setMarks((current) => {
                const { [messageId]: _gone, ...rest } = current;
                return mark ? { ...rest, [messageId]: mark } : rest;
            });
        put(next);
        const response = await fetch("/api/polar/feedback", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId, ...(next ?? { rating: null }) })
        }).catch(() => null);
        if (!response?.ok) {
            put(before);
            toast.show({ title: t("feedback.failed") });
            return false;
        }
        if (next?.rating === "bad" && (next.reasons.length > 0 || next.note)) {
            toast.show({ title: t("feedback.thanks") });
        }
        return true;
    };

    /** The last answer again: as it was, longer, shorter, or on another model
     *  for this turn only (the chat stays on the one chosen). */
    const regenerateWith = (options: answerActions.RegenerateOptions) => {
        if (!live.current.choice) return;
        answerActions.stopReading();
        refine.current = options.refine ?? null;
        turnChoice.current = options.model
            ? {
                  ...live.current.choice,
                  provider: options.model.provider,
                  model: options.model.model,
                  payer: null
              }
            : null;
        void chat.regenerate();
    };

    // The queue drains one message at a time once a turn has finished.
    useEffect(() => {
        if (busy || compacting || waitingApproval || queue.length === 0 || chat.status === "error")
            return;
        const [next, ...rest] = queue;
        saveQueue(rest);
        turnChoice.current = null;
        if (next) void sendWithRoom({ text: next.text });
    }, [busy, compacting, waitingApproval, queue.length, chat.status]);

    /** A temporary chat that was written to is deleted as soon as it is left.
     *  `keepalive` lets the request finish while the tab closes; the hourly
     *  sweep removes one whose tab never got to say so. */
    const shown = useRef(0);
    shown.current = chat.messages.length;
    const discardTemporary = useCallback(() => {
        if (!live.current.temporary || shown.current === 0) return;
        void fetch(`/api/polar/threads/${live.current.threadId}`, {
            method: "DELETE",
            keepalive: true
        }).catch(() => undefined);
    }, []);
    useEffect(() => {
        window.addEventListener("pagehide", discardTemporary);
        return () => {
            window.removeEventListener("pagehide", discardTemporary);
            discardTemporary();
        };
    }, [discardTemporary]);

    const openThread = async (id: string) => {
        const response = await fetch(`/api/polar/threads/${id}`).catch(() => null);
        // A remembered chat that was deleted, or belongs to another account.
        if (response?.status === 404 && readStored(threadKey) === id) writeStored(threadKey, "");
        if (!response?.ok) return;
        const { thread } = (await response.json().catch(() => ({}))) as {
            thread?: {
                id: string;
                projectId: string | null;
                messages: StoredMessage[];
                queue: QueuedMessage[];
                choice: ModelChoice | null;
            };
        };
        // An answer that is not a chat (a proxy page, an older server) opens nothing.
        if (!Array.isArray(thread?.messages)) return;
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
        discardTemporary();
        setTemporary(false);
        const roots = thread.messages.filter((message) => message.parentId === null);
        const newestRoot = roots.at(-1);
        const shown = newestRoot ? pathThrough(next, [], 0, newestRoot.id) : [];
        setOpening(shown);
        setThreadId(thread.id);
        setNewProject(thread.projectId);
        // The thread already open: the same chat, so its messages are set on it.
        if (thread.id === threadId) chat.setMessages(shown);
        setQueue(thread.queue);
        if (thread.choice) setChoice(thread.choice);
        setShowHistory(fullPage);
        setDrawer(false);
    };
    // A chat named in the page's address (a shared chat just continued, a
    // chat picked beside the settings) opens once, and the address goes back
    // to plain /polar; `new` starts one, in the project it names if any, and
    // `session` opens a Code session (`new` for a new task).
    // Otherwise the chat that was open before a reload opens again.
    useEffect(() => {
        const params = fullPage ? new URLSearchParams(window.location.search) : null;
        const named = params?.get("thread") ?? null;
        const fresh = params?.get("new") ?? null;
        const session = params?.get("session") ?? null;
        if (session) {
            window.history.replaceState(null, "", window.location.pathname);
            code.open(session === "new" ? null : session);
        } else if (named || fresh) {
            window.history.replaceState(null, "", window.location.pathname);
            code.setMode("chat");
        }
        if (fresh) {
            startNew(fresh === "1" ? null : fresh);
            return;
        }
        const reopen = named ?? readStored(threadKey);
        if (reopen) void openThread(reopen);
    }, []);
    // Remembered once it has something in it; a temporary chat is deleted when
    // the page goes, so there is nothing to come back to.
    useEffect(() => {
        if (temporary || chat.messages.length === 0) return;
        writeStored(threadKey, threadId);
        if (chatScope) keepScope(threadKey);
    }, [threadId, temporary, chat.messages.length]);

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
        setComparison((current) => {
            const columns = current?.columns.filter((column) => column.threadId !== id) ?? [];
            return current && columns.length > 0 ? { ...current, columns } : null;
        });
    };

    const startNew = (projectId: string | null = null) => {
        // Lets go of the answer on screen; it keeps running on the server.
        void chat.stop();
        setComparison(null);
        discardTemporary();
        setNewProject(projectId);
        if (projectId) sidebar.openProject(projectId);
        tree.current = new Map();
        setOpening([]);
        setThreadId(newId());
        writeStored(threadKey, "");
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

    /** Copies the path up to a message into a new conversation and opens it. */
    const branchFrom = async (messageId: string) => {
        const from = live.current.threadId;
        const response = await fetch(`/api/polar/threads/${from}/branch`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId })
        }).catch(() => null);
        const data = response?.ok
            ? ((await response.json().catch(() => null)) as { thread?: { id: string } } | null)
            : null;
        if (!data?.thread) {
            toast.show({ title: t("errors.branchFailed") });
            return;
        }
        if (showHistory) sidebar.refresh(true);
        await openThread(data.thread.id);
    };

    /** Uploads one staged file, drawing its progress, and leaves it ready or failed. */
    const upload = (key: string, file: File) =>
        settle(
            key,
            file.name,
            uploadFile(file, (share) =>
                setFiles((current) =>
                    current.map((entry) =>
                        entry.id === key ? { ...entry, progress: share } : entry
                    )
                )
            )
        );

    /** One staged attachment, ready or failed once its store answers. */
    const settle = async (key: string, name: string, storing: Promise<AttachmentData | string>) => {
        const stored = await storing;
        if (typeof stored === "string") {
            const code: UploadError = (UPLOAD_ERRORS as readonly string[]).includes(stored)
                ? (stored as UploadError)
                : "upload_failed";
            const sentence = t(`files.errors.${code}`, { name });
            setFiles((current) =>
                current.map((entry) =>
                    entry.id === key ? { ...entry, pending: false, failed: sentence } : entry
                )
            );
            setFileError(sentence);
            return;
        }
        picked.current.delete(key);
        dropped.current.delete(key);
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

    /** Things dragged in from Mail, Drive or Chat, each stored by the server. */
    const addItems = (items: droppedItems.DroppedItem[]) => {
        const room = Math.max(0, POLAR_ATTACHMENT_MOST - filesNow.current.length);
        setFileError(
            items.length > room ? t("files.tooMany", { most: POLAR_ATTACHMENT_MOST }) : null
        );
        for (const item of items.slice(0, room)) {
            const key = newId();
            const name = droppedItems.itemLabel(item);
            dropped.current.set(key, item);
            setFiles((current) => [
                ...current,
                {
                    id: key,
                    url: "",
                    filename: name,
                    mediaType: "",
                    size: 0,
                    pending: true,
                    progress: 0
                }
            ]);
            void settle(key, name, attachItem(item));
        }
    };

    /** A drop of files from the computer or of items from an app, anywhere on the chat. */
    const droppable = (types: readonly string[]) =>
        !noKeys && (types.includes("Files") || droppedItems.carriesItems(types));
    const dropHandlers = {
        // Code's composer takes no files: a drop there must not land, unseen,
        // on the chat kept mounted underneath.
        onDragOver: (event: React.DragEvent) => {
            if (code.mode !== "chat") return;
            if (!droppable(Array.from(event.dataTransfer.types))) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDragging(true);
        },
        onDragLeave: (event: React.DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
        },
        onDrop: (event: React.DragEvent) => {
            const types = Array.from(event.dataTransfer.types);
            if (code.mode !== "chat" || !droppable(types)) return;
            event.preventDefault();
            setDragging(false);
            const items = droppedItems.carriesItems(types)
                ? droppedItems.readDraggedItems(event.dataTransfer)
                : null;
            if (items) addItems(items);
            else if (types.includes("Files")) addFiles(Array.from(event.dataTransfer.files));
        }
    };

    const retryFile = (file: AttachmentData) => {
        const item = dropped.current.get(file.id);
        if (item) {
            setFileError(null);
            setFiles((current) =>
                current.map((entry) =>
                    entry.id === file.id ? { ...entry, pending: true, failed: undefined } : entry
                )
            );
            void settle(file.id, droppedItems.itemLabel(item), attachItem(item));
            return;
        }
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
        dropped.current.delete(file.id);
        const stored = file.pending ? null : polarAttachmentId(file.url);
        if (stored) {
            void fetch(`/api/polar/attachments/${encodeURIComponent(stored)}`, {
                method: "DELETE"
            }).catch(() => undefined);
        }
    };

    // Asks again on another model, from a failure's "try with" offer.
    const tryWith = (model: { provider: string; model: string }) => {
        if (!choice) return;
        const next: ModelChoice = {
            ...choice,
            provider: model.provider,
            model: model.model,
            payer: null
        };
        // Read by the transport on this very send, before the state below has rendered.
        live.current = { ...live.current, choice: next };
        setChoice(next);
        turnChoice.current = null;
        void chat.regenerate();
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
        if (command === "page") {
            if (!context) return void toast.show({ title: t("context.none") });
            pageOnce.current = true;
            return void toast.show({ title: t("context.attached") });
        }
        if (command === "model") return setModelOpen(true);
        if (command === "file") {
            return document
                .getElementById(fullPage ? "polar-attach-page" : "polar-attach")
                ?.querySelector("button")
                ?.click();
        }
        if (command === "tools" && choice && !busy) {
            turnChoice.current = null;
            void chat.sendMessage(withScreen({ text: t("slash.toolsPrompt") }));
        }
    };

    /** Summarises the conversation so far into a marker the next turns send
     *  instead of the history. True once the marker is in. */
    const compact = async (instructions: string | null, auto: boolean): Promise<boolean> => {
        const leaf = chat.messages.at(-1);
        const current = live.current.choice;
        if (!leaf || !current || compactionOf(leaf)) {
            if (!auto) toast.show({ title: t("compact.nothing") });
            return false;
        }
        setCompacting(true);
        const response = await fetch(`/api/polar/threads/${live.current.threadId}/compact`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId: leaf.id, choice: current, instructions, auto })
        }).catch(() => null);
        const data = (await response?.json().catch(() => null)) as {
            message?: UIMessage;
            error?: string;
        } | null;
        setCompacting(false);
        if (!response?.ok || !data?.message) {
            toast.show({
                title: t(data?.error === "nothing" ? "compact.nothing" : "compact.failed")
            });
            return false;
        }
        chat.setMessages([...chat.messages, data.message]);
        return true;
    };

    /** Sends a turn, compacting the chat first when this turn would bring it
     *  near the model's window and the person has automatic compaction on. */
    /** The message with the screen it is asked on, kept for later turns. */
    const withScreen = (message: Parameters<typeof chat.sendMessage>[0]) => {
        if (!message || !("text" in message)) return message;
        const screen = sharedContext();
        pageOnce.current = false;
        pageTurn.current = screen;
        return screen
            ? {
                  ...message,
                  metadata: { ...((message.metadata as object | undefined) ?? {}), screen }
              }
            : message;
    };
    const sendWithRoom = (message: Parameters<typeof chat.sendMessage>[0]) =>
        compactBeforeSending({
            used: contextUsed(chat.messages),
            draft: estimateTokens(message && "text" in message ? (message.text ?? "") : ""),
            window: windowOf(providers, live.current.choice),
            enabled: display.autoCompact,
            compact: () => compact(null, true),
            send: () => chat.sendMessage(withScreen(message))
        });

    /** Renames the open chat, shown in the list at once and put back if refused. */
    const renameChat = async (typed: string) => {
        const title = polarShared.threadTitleSchema.safeParse(typed);
        if (!title.success) {
            toast.show({ title: t("control.renameHow") });
            return;
        }
        const id = live.current.threadId;
        sidebar.retitle(id, title.data);
        const response = await fetch(`/api/polar/threads/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: title.data })
        }).catch(() => null);
        if (response?.ok) return void toast.show({ title: t("control.renamed") });
        sidebar.refresh(true);
        toast.show({ title: t("control.renameFailed") });
    };

    /** What a command that acts on the chat itself does. Never sent as text. */
    const runControl = (command: Control, rest: string) => {
        setInput("");
        if (command === "clear") return startNew();
        if (command === "temp") {
            startNew();
            return setTemporary(!temporary);
        }
        if (command === "memory")
            return settingsPath.openFromChat((href) => router.push(href), "#memory");
        if (command === "context") return setShowContext(true);
        if (command === "usage") {
            return chat.messages.length === 0 ? setShowUsage(true) : setShowContext(true);
        }
        if (command === "help") {
            setInput("/");
            return textarea.current?.focus();
        }
        if (busy || compacting) return void toast.show({ title: t("control.busy") });
        if (chat.messages.length === 0) return void toast.show({ title: t("control.empty") });
        if (command === "compact") return void compact(rest || null, false);
        if (temporary) return void toast.show({ title: t("control.temporary") });
        if (command === "rename") return void renameChat(rest);
        if (command === "branch") {
            const last = chat.messages.at(-1);
            return last ? void branchFrom(last.id) : undefined;
        }
        if (command === "export") {
            const link = document.createElement("a");
            link.href = `/api/polar/threads/${live.current.threadId}/export?format=markdown`;
            link.download = "";
            link.click();
        }
    };

    const submit = () => {
        const raw = input.trim();
        // A command that acts on the chat runs here, before a person's own
        // command of the same name could: it never reaches the model.
        const control = polarShared.controlCommandIn(raw);
        if (control) return runControl(control.command, control.rest);
        if (compacting) return;
        const ready = files.filter((file) => !file.pending && !file.failed);
        if ((!raw && ready.length === 0) || !choice || files.some(stillStaging)) return;
        const typed = COMMANDS.find((command) => raw === `/${command}`);
        if (typed) return runCommand(typed);
        // One of the person's own: its prompt, with what followed the shortcut,
        // on its model for this turn - unless that model is gone, then the
        // chosen one answers.
        const own = ownCommandIn(raw, commands.commands);
        const body = own ? polarShared.commandText(own.row.prompt, own.rest) : raw;
        const ownChoice =
            own && (polarShared.isAutomatic(own.row.choice) || offered(providers, own.row.choice))
                ? own.row.choice
                : null;
        const text = quote ? `${polarShared.quoteBlock(quote)}\n\n${body}` : body;
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
                turnChoice.current = ownChoice;
                chat.setMessages(chat.messages.slice(0, index));
                return void chat.sendMessage(withScreen(message));
            }
        }
        if (busy || waitingApproval) {
            if (queue.length < MAX_QUEUE && text) saveQueue([...queue, { id: newId(), text }]);
            return;
        }
        setLastApproved(false);
        turnChoice.current = ownChoice;
        void sendWithRoom(message);
    };

    /** What was said in voice mode, sent as the next message of this thread. */
    const sendSpoken = async (text: string) => {
        if (!live.current.choice) return;
        if (chat.status === "submitted" || chat.status === "streaming") await stopAnswer();
        turnChoice.current = null;
        setLastApproved(false);
        void chat.sendMessage(withScreen({ text }));
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
    const lastMessage = chat.messages.at(-1);
    const canCompact = !busy && !compacting && !!lastMessage && !compactionOf(lastMessage);
    const commandsFull = commands.commands.length >= polarShared.POLAR_COMMAND_MOST;
    const slashFound = slashMatches(input, commands.commands);
    const slashItems: SuggestionListItem[] = [
        ...slashFound.map((match): SuggestionListItem =>
            match.kind === "control"
                ? {
                      key: `control:${match.command}`,
                      label: `/${match.command}`,
                      detail: t(`slash.control.${match.command}`),
                      icon: CONTROL_ICONS[match.command],
                      group: t("slash.groups.control")
                  }
                : match.kind === "builtin"
                  ? {
                        key: match.command,
                        label: `/${match.command}`,
                        detail: LATER.has(match.command)
                            ? t("slash.later")
                            : t(`slash.${match.command}`),
                        icon: COMMAND_ICONS[match.command],
                        disabled: LATER.has(match.command),
                        group: t("slash.groups.polar")
                    }
                  : {
                        key: `own:${match.row.id}`,
                        label: `/${match.row.shortcut}`,
                        detail: polarShared.firstLine(match.row.prompt),
                        icon: Zap,
                        group: t("slash.groups.own")
                    }
        ),
        ...(input.startsWith("/") && !/\s/.test(input)
            ? [
                  {
                      key: NEW_COMMAND,
                      label: t("commands.new"),
                      detail: commandsFull
                          ? t("commands.errors.too_many", {
                                most: polarShared.POLAR_COMMAND_MOST
                            })
                          : t("commands.newDetail"),
                      icon: Plus,
                      disabled: commandsFull
                  }
              ]
            : [])
    ];
    const slashOpen = !slashDismissed && slashItems.length > 0;
    const slashHighlight =
        slashItems[slashActive] && !slashItems[slashActive].disabled
            ? slashActive
            : firstPickable(slashItems);
    const ids = fullPage
        ? {
              input: "polar-input-page",
              slash: "polar-slash-page",
              attach: "polar-attach-page",
              suggestion: "polar-suggestion-page"
          }
        : {
              input: "polar-input",
              slash: "polar-slash",
              attach: "polar-attach",
              suggestion: "polar-suggestion"
          };
    const pickSlash = (index: number) => {
        const key = slashItems[index]?.key;
        if (!key) return;
        if (key === NEW_COMMAND) {
            // What was typed after the "/" is the shortcut it was looking for.
            setCommandDraft({ shortcut: input.slice(1) });
            setInput("");
            return;
        }
        const match = slashFound[index];
        if (match?.kind === "own") {
            // The shortcut goes into the box, and what is typed after it is
            // added to the prompt when the message is sent.
            setInput(`/${match.row.shortcut} `);
            textarea.current?.focus();
            return;
        }
        if (match?.kind === "control") {
            if (TAKES_TEXT.has(match.command)) {
                setInput(`/${match.command} `);
                textarea.current?.focus();
                return;
            }
            return runControl(match.command, "");
        }
        if (match?.kind === "builtin") runCommand(match.command);
    };
    /** Tab on the "/" list: the highlighted command's name goes into the box,
     *  ready to run with Enter, and nothing runs - as in Discord and ChatGPT. */
    const completeSlash = (index: number) => {
        const key = slashItems[index]?.key;
        if (!key) return;
        const match = slashFound[index];
        const name =
            key === NEW_COMMAND || !match
                ? input.slice(1)
                : match.kind === "own"
                  ? match.row.shortcut
                  : match.command;
        // The space after the name closes the list on its own.
        setInput(`/${name}${key === NEW_COMMAND ? "" : " "}`);
        textarea.current?.focus();
    };
    // The keys the "/" list answers while it is open, as Chat's does: arrows
    // walk the commands that can run, Enter runs the highlighted one, Tab
    // completes its name into the box without running it, and Escape closes
    // the list and leaves the text as it is.
    const onComposerKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (!slashOpen) {
            if (!ghost) return;
            if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                acceptSuggestion(ghost);
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setSuggested(null);
            }
            return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSlashActive(
                stepPickable(slashItems, slashHighlight, event.key === "ArrowDown" ? 1 : -1)
            );
        } else if (event.key === "Tab" && !event.shiftKey) {
            if (slashHighlight < 0) return;
            event.preventDefault();
            completeSlash(slashHighlight);
        } else if (event.key === "Enter" && !event.shiftKey) {
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
            {(["page", "summary", "tools"] as const)
                .filter((key) => key !== "page" || (pageOn && context))
                .map((key) => (
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
    const chatMode = code.mode === "chat";
    /** A new conversation on the side on screen: a chat, or a Code task. */
    const startNewHere = () => (chatMode ? startNew() : code.open(null));
    // One history for both sides: the chats, and the Code sessions beside them.
    const threadList = (hide: Parameters<typeof PolarThreads>[0]["hide"]) => (
        <PolarThreads
            sidebar={sidebar}
            activeId={chatMode ? threadId : ""}
            runs={runMarks}
            onOpen={(id) => {
                setComparison(null);
                code.setMode("chat");
                void openThread(id);
            }}
            onNew={(projectId) => {
                if (projectId === null && !chatMode) {
                    code.open(null);
                    setDrawer(false);
                    setShowHistory(false);
                    return;
                }
                code.setMode("chat");
                startNew(projectId);
            }}
            hide={hide}
            newLabel={chatMode ? undefined : t("code.newTask")}
            code={
                code.access === null || code.access === "none"
                    ? null
                    : {
                          history: code.history,
                          activeId: chatMode ? null : code.selected,
                          first: !chatMode,
                          onOpen: (id) => {
                              code.open(id);
                              setDrawer(false);
                              setShowHistory(false);
                          }
                      }
            }
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
            {slashOpen && !inCall ? (
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
            {/* Voice mode takes the composer's place, as in ChatGPT; the
                composer stays mounted, so a draft is still there after. */}
            <PolarComposer
                kit={voiceKit}
                notice={voiceNotice}
                onNotice={setVoiceNotice}
                streaming={chat.status === "streaming"}
                hidden={inCall}
                highlighted={dragging}
                inputId={ids.input}
                label={t("composer.label")}
                value={input}
                onValueChange={(value) => {
                    if (value) setSuggested(null);
                    setInput(value);
                }}
                placeholder={ghost ?? t("composer.placeholder")}
                disabled={noKeys}
                textareaRef={textarea}
                textareaProps={{
                    "aria-describedby": ghost ? ids.suggestion : undefined,
                    "aria-controls": slashOpen ? ids.slash : undefined,
                    "aria-activedescendant":
                        slashOpen && slashHighlight >= 0
                            ? suggestionOptionId(ids.slash, slashHighlight)
                            : undefined,
                    onKeyDown: onComposerKey,
                    onPaste: (event) => {
                        const pasted = pastedFiles(event.clipboardData);
                        if (pasted.length > 0) {
                            event.preventDefault();
                            addFiles(pasted);
                        }
                    }
                }}
                onSubmit={submit}
                header={
                    <>
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
                    </>
                }
                beforeInput={
                    ghost ? (
                        <>
                            <span id={ids.suggestion} className="sr-only">
                                {t("composer.suggestion.described", { text: ghost })}
                            </span>
                            {/* No Tab key on a touch screen: the suggestion is a tap. */}
                            <div className="hidden min-w-0 px-3 pt-2 [@media(pointer:coarse)]:flex">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="min-h-11 max-w-full"
                                    aria-label={t("composer.suggestion.use", { text: ghost })}
                                    onClick={() => acceptSuggestion(ghost)}
                                >
                                    <span className="truncate" title={ghost}>
                                        {ghost}
                                    </span>
                                </Button>
                            </div>
                        </>
                    ) : null
                }
                picker={
                    <>
                        <ModelSelector
                            providers={providers ?? []}
                            choice={choice}
                            onChoice={setChoice}
                            open={modelOpen}
                            onOpenChange={setModelOpen}
                        />
                        {welcome && !temporary ? (
                            <polarCompare.AskSeveral
                                providers={providers ?? []}
                                choice={choice}
                                question={input}
                                hasFiles={files.length > 0}
                                onStart={(choices) => {
                                    writeStored(threadKey, "");
                                    setComparison({
                                        question: input.trim(),
                                        columns: choices.map((one) => ({
                                            threadId: newId(),
                                            choice: one,
                                            sent: false
                                        }))
                                    });
                                    setInput("");
                                }}
                            />
                        ) : null}
                    </>
                }
                attachId={ids.attach}
                attach={{
                    files,
                    error: fileError,
                    accept: POLAR_ATTACHMENT_TYPES,
                    disabled: noKeys || files.length >= POLAR_ATTACHMENT_MOST,
                    onFiles: addFiles,
                    onFailed: setFileError,
                    onRemove: removeFile,
                    onRetry: retryFile
                }}
                voiceMode={{
                    disabled: noKeys || !choice,
                    onOpen: () => {
                        answerActions.stopReading();
                        setInCall(true);
                    }
                }}
                submit={{
                    busy,
                    disabled: !choice || files.some(stillStaging),
                    sendLabel: t("actions.send"),
                    stopLabel: t("actions.stop"),
                    onStop: stopTurn
                }}
            />
            {inCall ? (
                <VoiceCall
                    messages={chat.messages}
                    status={chat.status}
                    speech={voice.speech}
                    payer={choice?.payer}
                    transcriber={voice.transcriber}
                    transcribers={voice.transcribers}
                    onTranscriber={chooseTranscriber}
                    tools={tools}
                    onSend={(text) => void sendSpoken(text)}
                    onStop={stopTurn}
                    onApprove={(id, approved) => {
                        setLastApproved(approved);
                        void chat.addToolApprovalResponse({ id, approved });
                    }}
                    onEnd={() => {
                        setInCall(false);
                        // Once the composer is shown again.
                        requestAnimationFrame(() => textarea.current?.focus());
                    }}
                />
            ) : null}
        </div>
    );

    return (
        <div className="relative flex h-full min-h-0 min-w-0 flex-1" {...dropHandlers}>
            {dragging ? (
                // The whole chat takes the drop, so it is the whole chat that says so.
                <div
                    aria-hidden
                    data-polar-drop-target
                    className="pointer-events-none absolute inset-1 z-30 rounded-lg border-2 border-dashed border-primary bg-primary/5"
                />
            ) : null}
            {sidebarShown ? (
                // The app rail's own width and surface: on this page it is the
                // only sidebar, so it reads as the one every other app has.
                <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
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
                        "polar-head flex h-11 shrink-0 items-center gap-2 px-3",
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
                    <PolarAvatar state={avatarState} size={24} label={t(`mood.${mood}`)} />
                    <span className="polar-head-title min-w-0 truncate text-sm font-semibold text-foreground">
                        {t("page.title")}
                    </span>
                    <PolarModeSwitch code={code} />
                    <span className="flex-1" />
                    {chatMode ? (
                        <>
                            <span className="polar-head-wide flex items-center gap-2">
                                <MessageAction
                                    label={temporary ? t("temporary.off") : t("temporary.on")}
                                    aria-pressed={temporary}
                                    className={cn(temporary && "bg-muted text-foreground")}
                                    onClick={() => {
                                        startNew();
                                        setTemporary(!temporary);
                                    }}
                                >
                                    <Ghost />
                                </MessageAction>
                                <MessageAction
                                    label={t("commands.manage")}
                                    onClick={() => setManaging(true)}
                                >
                                    <SquareSlash />
                                </MessageAction>
                                <MessageAction
                                    label={t("usage.title")}
                                    onClick={() => setShowUsage(true)}
                                >
                                    <Gauge />
                                </MessageAction>
                                {/* A page, not a dialog: it holds every section and the
                                    connectors, which is more than a dialog over the chat
                                    reads well. The panel is hidden on Polar's own pages, so
                                    settings open in the main window and the browser's back
                                    returns to the page the panel was open on, still open. */}
                                <MessageAction
                                    label={t("settings.open")}
                                    onClick={() =>
                                        settingsPath.openFromChat((href) => router.push(href))
                                    }
                                >
                                    <Settings2 />
                                </MessageAction>
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <MessageAction
                                        label={t("actions.more")}
                                        className="polar-head-narrow"
                                    >
                                        <MoreHorizontal />
                                    </MessageAction>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="min-w-48">
                                    <DropdownMenuItem
                                        onSelect={() => {
                                            startNew();
                                            setTemporary(!temporary);
                                        }}
                                    >
                                        <Ghost />
                                        {temporary ? t("temporary.off") : t("temporary.on")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => setManaging(true)}>
                                        <SquareSlash />
                                        {t("commands.manage")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => setShowUsage(true)}>
                                        <Gauge />
                                        {t("usage.title")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        onSelect={() =>
                                            settingsPath.openFromChat((href) => router.push(href))
                                        }
                                    >
                                        <Settings2 />
                                        {t("settings.open")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </>
                    ) : null}
                    {fullPage ? (
                        !wide || collapsed ? (
                            <MessageAction
                                label={chatMode ? t("actions.new") : t("code.newTask")}
                                onClick={startNewHere}
                            >
                                <SquarePen />
                            </MessageAction>
                        ) : null
                    ) : (
                        <>
                            <MessageAction
                                label={chatMode ? t("actions.new") : t("code.newTask")}
                                onClick={startNewHere}
                            >
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

                {/* Chat stays mounted under Code, so a draft or an answer on its
                    way is still there when the switch goes back. */}
                {chatMode ? null : (
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <PolarCodeView
                            code={code}
                            fullPage={fullPage}
                            avatar={<PolarAvatar state={avatarState} size={64} />}
                            voiceKit={voiceKit}
                        />
                    </div>
                )}
                <div
                    className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !chatMode && "hidden")}
                    inert={chatMode ? undefined : true}
                >
                    {comparison ? (
                        <polarCompare.PolarCompare
                            comparison={comparison}
                            onChange={setComparison}
                            providers={providers ?? []}
                            isAdmin={isAdmin}
                            settings={{ web, toolNames: Object.keys(tools) }}
                            onClose={() => setComparison(null)}
                            onContinue={(id) => {
                                setComparison(null);
                                void openThread(id);
                            }}
                            onSettled={(id, answered) => {
                                sidebar.refresh(true);
                                if (answered) askTitle(id);
                            }}
                        />
                    ) : welcome ? (
                        <PolarWelcome
                            avatar={<PolarAvatar state={avatarState} size={64} />}
                            title={temporary ? t("temporary.title") : t("welcome")}
                            description={temporary ? t("temporary.body") : undefined}
                        >
                            {queueView}
                            {composer}
                            {suggestions}
                        </PolarWelcome>
                    ) : (
                        <PolarThreadFrame
                            fullPage={fullPage}
                            dock={
                                <>
                                    {queueView}
                                    <ContextBar
                                        used={contextUsed(chat.messages)}
                                        draft={estimateTokens(input)}
                                        window={windowOf(providers, choice)}
                                        canCompact={canCompact}
                                        onCompact={() => void compact(null, false)}
                                    />
                                    {composer}
                                </>
                            }
                        >
                            {temporary ? (
                                <p className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                                    <Ghost className="size-3.5 shrink-0" />
                                    <span className="min-w-0">{t("temporary.banner")}</span>
                                </p>
                            ) : null}
                            {noKeys ? (
                                <div className="rounded-lg border border-border bg-background p-3 text-sm text-muted-foreground">
                                    <p className="text-foreground">{t("noKeys.title")}</p>
                                    <p className="mt-1">
                                        {t(spendsDeployment ? "noKeys.body" : "noKeys.ownOnly")}
                                    </p>
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
                                    icon={<PolarAvatar state={avatarState} size={64} />}
                                    description={t("empty")}
                                >
                                    {suggestions}
                                </ConversationEmptyState>
                            ) : null}
                            {chat.messages.map((message, index) => {
                                const marker = compactionOf(message);
                                if (marker) {
                                    return (
                                        <CompactionDivider
                                            key={message.id}
                                            summary={summaryOf(message)}
                                            auto={marker.auto}
                                        />
                                    );
                                }
                                const versions = versionsOf(tree.current, message.id);
                                const at = versions.indexOf(message.id);
                                return (
                                    <MessageView
                                        key={message.id}
                                        message={message}
                                        tools={tools}
                                        last={index === chat.messages.length - 1}
                                        busy={busy}
                                        explained={
                                            message.id === stopped ||
                                            (index === chat.messages.length - 1 && !!looseError)
                                        }
                                        version={{
                                            current: at + 1,
                                            total: versions.length
                                        }}
                                        onVersion={(step) => {
                                            const target = versions[at + step];
                                            if (target) switchVersion(index, target);
                                        }}
                                        onApprove={(id, approved, reason) => {
                                            setLastApproved(approved);
                                            void chat.addToolApprovalResponse({
                                                id,
                                                approved,
                                                ...(reason ? { reason } : {})
                                            });
                                        }}
                                        onEdit={() => {
                                            setEditing(message.id);
                                            setInput(textOf(message));
                                            textarea.current?.focus();
                                        }}
                                        onQuote={() => setQuote(textOf(message).slice(0, 200))}
                                        onSaveCommand={() =>
                                            setCommandDraft({
                                                prompt: textOf(message).slice(
                                                    0,
                                                    polarShared.POLAR_COMMAND_PROMPT_MAX
                                                )
                                            })
                                        }
                                        onRegenerate={regenerateWith}
                                        onAsk={(text) => void sendSpoken(text)}
                                        providers={providers ?? []}
                                        mark={marks[message.id] ?? null}
                                        onMark={(change) => markAnswer(message.id, change)}
                                        speech={voice.speech}
                                        payer={choice?.payer ?? null}
                                        onShare={
                                            temporary ? undefined : () => setSharingFrom(message.id)
                                        }
                                        renderFailure={(failure) => (
                                            <PolarFailureNotice
                                                failure={failure}
                                                isAdmin={isAdmin}
                                                providers={providers ?? []}
                                                failedModel={choice?.model ?? null}
                                                // Only the newest answer offers to
                                                // try again; older ones say what
                                                // happened.
                                                onRetry={
                                                    index === chat.messages.length - 1
                                                        ? () => void chat.regenerate()
                                                        : undefined
                                                }
                                                onTryWith={
                                                    index === chat.messages.length - 1
                                                        ? tryWith
                                                        : undefined
                                                }
                                            />
                                        )}
                                        onBranch={
                                            temporary
                                                ? undefined
                                                : () => void branchFrom(message.id)
                                        }
                                    />
                                );
                            })}
                            {compacting ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <ThinkingOrb state="breathing" size={20} decorative />
                                    <Shimmer>{t("compact.working")}</Shimmer>
                                </div>
                            ) : null}
                            {chat.status === "submitted" ? (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <ThinkingOrb state="breathing" size={20} decorative />
                                    <Shimmer>
                                        <BusyVerb />
                                    </Shimmer>
                                </div>
                            ) : null}
                            {looseError ? (
                                <PolarFailureNotice
                                    failure={polarFailure.decodeLooseFailure(looseError.message)}
                                    isAdmin={isAdmin}
                                    providers={providers ?? []}
                                    failedModel={choice?.model ?? null}
                                    onRetry={() => void chat.regenerate()}
                                    onTryWith={tryWith}
                                />
                            ) : null}
                        </PolarThreadFrame>
                    )}
                </div>
            </div>
            {showUsage ? <UsageDialog onClose={() => setShowUsage(false)} /> : null}
            {showContext ? (
                <ContextDialog
                    used={contextUsed(chat.messages)}
                    window={windowOf(providers, choice)}
                    threadId={temporary ? null : threadId}
                    canCompact={canCompact}
                    onCompact={() => {
                        setShowContext(false);
                        void compact(null, false);
                    }}
                    onMonth={() => {
                        setShowContext(false);
                        setShowUsage(true);
                    }}
                    onClose={() => setShowContext(false)}
                />
            ) : null}
            {managing ? (
                <polarCommands.CommandsDialog
                    store={commands}
                    providers={providers ?? []}
                    onClose={() => setManaging(false)}
                    onEdit={setCommandDraft}
                />
            ) : null}
            {sharingFrom ? (
                <PolarShareDialog
                    row={{ id: threadId }}
                    upTo={sharingFrom}
                    onClose={() => setSharingFrom(null)}
                />
            ) : null}
            {commandDraft ? (
                <polarCommands.CommandForm
                    draft={commandDraft}
                    commands={commands.commands}
                    providers={providers ?? []}
                    onClose={() => setCommandDraft(null)}
                    onSaved={commands.saved}
                />
            ) : null}
        </div>
    );
}

/** The window of the chosen model: the provider's own figure when its API
 *  reports one, else the catalogue's; null for Automatic (the model is picked
 *  per turn) or a model with no known window. */
export function windowOf(
    providers: ModelSelectorProvider[] | null,
    choice: ModelChoice | null
): number | null {
    if (!choice || isAutomatic(choice)) return null;
    const model = providers
        ?.find((entry) => entry.provider === choice.provider)
        ?.models.find((entry) => entry.model === choice.model) as
        { contextTokens?: unknown; providerContextTokens?: unknown } | undefined;
    return contextWindowOf({
        provider:
            typeof model?.providerContextTokens === "number" ? model.providerContextTokens : null,
        catalogue: typeof model?.contextTokens === "number" ? model.contextTokens : null
    });
}

/** Whether the picker offers this model to the person now. */

function offered(providers: ModelSelectorProvider[] | null, choice: ModelChoice): boolean {
    return (providers ?? []).some((entry) =>
        entry.models.some(
            (model) => model.provider === choice.provider && model.model === choice.model
        )
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
    removeLabel,
    onRemove
}: {
    label: string;
    removeLabel: string;
    onRemove: () => void;
}) {
    return (
        <span
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            title={label}
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
    explained,
    version,
    onVersion,
    onApprove,
    onEdit,
    onQuote,
    onSaveCommand,
    onRegenerate,
    onAsk,
    providers,
    mark,
    onMark,
    speech,
    payer,
    onShare,
    onBranch,
    renderFailure
}: {
    message: UIMessage;
    tools: Record<string, ToolDescription>;
    last: boolean;
    busy: boolean;
    /** Whether something else already says why this answer is empty: a stop, a dropped turn. */
    explained: boolean;
    version: { current: number; total: number };
    onVersion: (step: -1 | 1) => void;
    onApprove: (id: string, approved: boolean, reason?: string) => void;
    onEdit: () => void;
    onQuote: () => void;
    onSaveCommand: () => void;
    onRegenerate: (options: answerActions.RegenerateOptions) => void;
    /** Sends a line as the next question, for a step offered under an answer. */
    onAsk?: (text: string) => void;
    providers: ModelSelectorProvider[];
    mark: PolarMark | null;
    onMark: (change: answerActions.MarkChange) => Promise<boolean>;
    /** Whether this person has a voice to read answers aloud with. */
    speech: boolean;
    payer: string | null;
    onShare?: () => void;
    onBranch?: () => void;
    /** Why this answer has nothing else to show, drawn the way the panel words it. */
    renderFailure: (failure: polarFailure.StoredFailure) => ReactNode;
}) {
    const t = useTranslations("polar");
    const mine = message.role === "user";
    const from = mine ? "user" : "assistant";
    const meta = (message.metadata ?? {}) as {
        fellBackFrom?: string | null;
        workedMs?: number;
        model?: string;
        automatic?: boolean;
        usage?: unknown;
    };
    const spent = answerSpendOf(meta.usage);
    const files = message.parts.filter((part) => part.type === "file");
    const streaming = busy && last;
    const toolName = (name: string) =>
        tools[name]?.title ??
        (name === "polar_remember"
            ? t("memory.remember")
            : name === "polar_forget"
              ? t("memory.forget")
              : name === "polar_show"
                ? t("visual.tool")
                : name);
    // A web step names what it searched for or which site it read.
    const stepTitle = (name: string, input: unknown) => {
        const repo = repoStepOf(name, input);
        if (repo) {
            return repo.kind === "search"
                ? t("repo.search", { repo: repo.repo, query: repo.detail })
                : t(`repo.${repo.kind}`, { repo: repo.repo, path: repo.detail });
        }
        const browser = browserStepOf(name, input);
        if (browser) {
            const values = { site: browser.site, element: browser.element || "?" };
            if (browser.kind === "close") return t("web.browserClose");
            return t(`web.browserSteps.${browser.kind}`, values);
        }
        const step = webStepOf(name, input);
        if (!step) return toolName(name);
        if (step.kind === "read") return t("web.reading", { site: step.detail });
        return step.detail ? t("web.searching", { query: step.detail }) : t("web.searched");
    };
    const sources = mine ? [] : sourcesOf(message.parts as never);
    // A repository read refused over the GitHub App carries the step that fixes
    // it; the answer relays the reason and this draws the button.
    const gaps = mine
        ? []
        : gapsOf(
              message.parts.flatMap((part) => {
                  const tool = part as unknown as ToolPart;
                  const name =
                      part.type === "dynamic-tool" ? (tool.toolName ?? "") : part.type.slice(5);
                  return part.type.startsWith("tool-") || part.type === "dynamic-tool"
                      ? repoStepOf(name, tool.input) && tool.state === "output-available"
                          ? [tool.output]
                          : []
                      : [];
              })
          );
    const unanswered =
        !mine &&
        !streaming &&
        !explained &&
        !gaps.length &&
        answeredNothing(message.parts as never);
    const { copied, copy } = useCopied();
    const toast = useToast();
    const reading = answerActions.useReading(message.id);
    const toolOf = (part: UIMessage["parts"][number]) => {
        if (!part.type.startsWith("tool-") && part.type !== "dynamic-tool") return null;
        const tool = part as unknown as ToolPart;
        const name = part.type === "dynamic-tool" ? (tool.toolName ?? "tool") : part.type.slice(5);
        return { tool, name };
    };
    // Thinking and tool calls fold into one line above the answer. A call
    // waiting for (or given) an approval and a call that failed stay in view.
    // A view Polar drew is part of the answer, not of the work; one the model
    // got wrong is a failed step like any other and folds with them.
    const drawn = (part: UIMessage["parts"][number]) =>
        isVisualPart(part) && (part as unknown as ToolPart).state !== "output-error";
    const folded = (part: UIMessage["parts"][number]) => {
        if (part.type === "reasoning") return true;
        if (isVisualPart(part)) return !drawn(part);
        const found = toolOf(part);
        return !!found && !found.tool.approval && found.tool.state !== "output-error";
    };
    const work = message.parts.filter(folded);
    const toolParts = message.parts.flatMap((part) => {
        const found = drawn(part) ? null : toolOf(part);
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
            ? stepTitle(lastTool.name, lastTool.tool.input)
            : null;
    const workIndex = message.parts.findIndex(folded);
    const renderTool = (part: UIMessage["parts"][number], index: number, opened = false) => {
        const found = toolOf(part);
        if (!found) return null;
        const { tool, name } = found;
        return (
            <Tool
                key={index}
                title={stepTitle(name, tool.input)}
                state={tool.state}
                orb={orbForTool(part)}
                defaultOpen={opened}
            >
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
                            orb={
                                streaming && !answering
                                    ? (orbForActivity({
                                          status: "streaming",
                                          parts: message.parts
                                      }) ?? undefined)
                                    : undefined
                            }
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
                const failure = polarFailure.failureOf(part);
                if (failure) return <div key={index}>{renderFailure(failure)}</div>;
                if (part.type === "text") {
                    if (!part.text.trim()) return null;
                    return (
                        <MessageContent key={index} from={from}>
                            {mine ? (
                                <p className="whitespace-pre-wrap">{part.text}</p>
                            ) : (
                                <MessageResponse>{citeSources(part.text, sources)}</MessageResponse>
                            )}
                        </MessageContent>
                    );
                }
                if (drawn(part)) {
                    const tool = part as unknown as ToolPart;
                    if (tool.state === "input-streaming") return <VisualDrawing key={index} />;
                    const visual = visualOf(tool.input);
                    return visual ? <PolarVisualView key={index} visual={visual} /> : null;
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
                                action={stepTitle(name, tool.input)}
                                affects={
                                    name === "polar_remember"
                                        ? affectedBy({
                                              name: (tool.input as { text?: unknown } | undefined)
                                                  ?.text
                                          })
                                        : affectedBy(tool.input)
                                }
                                destructive={
                                    described?.destructive ??
                                    (name !== "polar_remember" &&
                                        !isWebTool(name) &&
                                        !isBrowserTool(name))
                                }
                                input={tool.input}
                                tool={described?.writes ? name : undefined}
                                onApprove={() => tool.approval && onApprove(tool.approval.id, true)}
                                onReject={() => tool.approval && onApprove(tool.approval.id, false)}
                                site={browserStepOf(name, tool.input)?.site || undefined}
                                onAlwaysSite={() =>
                                    tool.approval &&
                                    onApprove(tool.approval.id, true, ALWAYS_SITE_REASON)
                                }
                            />
                        );
                    }
                    // A failed call stays in view, opened: it may be why the
                    // answer reads the way it does.
                    return renderTool(part, index, true);
                }
                return null;
            })}
            {sources.length > 0 ? (
                <WebSources sources={sources} calls={webCallsOf(message.parts as never)} />
            ) : null}
            {gaps.map((gap) => (
                <GithubAppGapNotice
                    key={gapIdentity(gap)}
                    gap={gap}
                    onCheckAgain={!streaming && last && !busy ? () => onRegenerate({}) : undefined}
                    onUseBrowser={!streaming && last && !busy ? onAsk : undefined}
                />
            ))}
            {/* The browser tool found no extension connected: the step that
                connects one, as a button. */}
            {!mine && noBrowserIn(message.parts as never) ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
                    <span className="min-w-0">{t("web.browserMissing")}</span>
                    <Button size="sm" variant="outline" asChild>
                        <a href="/account/downloads">{t("web.browserConnect")}</a>
                    </Button>
                </div>
            ) : null}
            {/* A turn that ended on its steps with nothing said is named, so
                the empty space under them never reads as an answer. */}
            {unanswered ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-foreground-muted">
                    <span>{t("errors.unanswered")}</span>
                    {last && !busy ? (
                        <Button size="sm" variant="outline" onClick={() => onRegenerate({})}>
                            {t("errors.provider.retry")}
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {!mine && typeof meta.model === "string" ? (
                <p className="text-xs text-foreground-subtle">
                    {t(meta.automatic ? "picker.autoPicked" : "picker.answeredBy", {
                        model: meta.model
                    })}
                    {spent ? <AnswerSpendLine spent={spent} /> : null}
                </p>
            ) : null}
            {!streaming ? (
                <MessageActions className="opacity-0 transition-opacity duration-fast focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                    <MessageBranchSelector
                        current={version.current}
                        total={version.total}
                        onPrevious={() => onVersion(-1)}
                        onNext={() => onVersion(1)}
                    />
                    {mine ? (
                        <>
                            <MessageAction label={t("actions.edit")} onClick={onEdit}>
                                <Pencil />
                            </MessageAction>
                            <MessageAction label={t("commands.saveAs")} onClick={onSaveCommand}>
                                <BookmarkPlus />
                            </MessageAction>
                        </>
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
                    {!busy && onBranch ? (
                        <MessageAction label={t("actions.branch")} onClick={onBranch}>
                            <GitBranchPlus />
                        </MessageAction>
                    ) : null}
                    {!mine ? <answerActions.AnswerMarks mark={mark} onMark={onMark} /> : null}
                    {!mine && speech && wordsOf(message) ? (
                        <MessageAction
                            label={
                                reading.active ? t("actions.stopReading") : t("actions.readAloud")
                            }
                            aria-pressed={reading.active}
                            aria-busy={reading.loading}
                            className={cn(reading.loading && "motion-safe:animate-pulse")}
                            onClick={() =>
                                reading.active
                                    ? answerActions.stopReading()
                                    : answerActions.readAloud(
                                          message.id,
                                          wordsOf(message),
                                          payer,
                                          (error) =>
                                              toast.show({ title: t(`voice.errors.${error}`) })
                                      )
                            }
                        >
                            {reading.active ? <Square /> : <Volume2 />}
                        </MessageAction>
                    ) : null}
                    {!mine && onShare ? (
                        <MessageAction label={t("actions.share")} onClick={onShare}>
                            <Share2 />
                        </MessageAction>
                    ) : null}
                    {!mine && last && !busy ? (
                        <answerActions.RegenerateMenu
                            providers={providers}
                            currentModel={typeof meta.model === "string" ? meta.model : null}
                            onRegenerate={onRegenerate}
                        />
                    ) : null}
                </MessageActions>
            ) : null}
        </Message>
    );
}
