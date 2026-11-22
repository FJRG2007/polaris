"use client";

/**
 * Interactive terminal. Mints a one-shot ticket, opens a WebSocket to the deploy
 * sidecar presenting the token over Sec-WebSocket-Protocol, and wires xterm.js to
 * it: server output -> terminal, keystrokes -> server, and a resize control frame
 * on fit. xterm is imported dynamically so it stays out of the server bundle.
 *
 * The same panel serves a container on a deploy target, a container on a
 * Containers connection, and a shell on a registered server; which one is
 * decided server-side from the ticket, so the only difference here is what the
 * ticket is minted for.
 */

import "@xterm/xterm/css/xterm.css";
import type { Terminal } from "@xterm/xterm";
import {
    AppLogo,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuShortcut
} from "@polaris/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    ClipboardPaste,
    Command,
    Copy,
    Eraser,
    Keyboard,
    Loader2,
    RotateCw,
    Search,
    ShieldAlert,
    TextSelect
} from "lucide-react";
import { SELECTION_QUOTE_MAX } from "@/lib/polar/shared";
import type { LocalPath } from "@/lib/server-local-path";
import { useTerminalLayout } from "@/lib/use-terminal-layout";
import { contextMenuNotice } from "@/lib/context-menu/target";
import { usePolarOptional } from "@/components/polar/polar-panel";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { copyText, readClipboard } from "@/lib/context-menu/editing";
import {
    BAR_KEYS,
    POLAR_LINES,
    barKeyFace,
    barKeySequence,
    clipboardShortcut,
    isMacPlatform,
    keyboardInset,
    terminalExcerpt,
    withModifiers,
    type BarKey
} from "@/lib/terminal-keys";

/** What to attach to: a container on a deploy target, a container on a
 *  Containers connection, a registered server - as the Polaris login, or as root
 *  where that server granted it - or the terminal a coding-agent session is
 *  running in. */
export type TerminalTarget =
    | { kind: "container"; applicationId: string }
    | { kind: "docker"; connectionId: string; containerRef: string }
    | { kind: "host"; hostId: string; asRoot?: boolean }
    /** `shell` names one more shell beside the agent (a tab); absent attaches
     *  to the agent itself. */
    | { kind: "agent"; sessionId: string; shell?: number };

/**
 * Why a session ended before it ever started. `unreachable` is the one that used
 * to read as a plain "disconnected": the socket closed without the far end ever
 * answering, which on a WebSocket almost always means the browser refused it
 * before it left - and the usual reason is a certificate it does not trust, which
 * it will not offer to click through the way it does for a page.
 */
type Failure = { kind: "unreachable" } | { kind: "refused"; reason: string };

/**
 * The reasons the terminal sidecar closes with (`ws-server.mjs`), and the
 * sentence each one is shown as. The sidecar accepts the socket BEFORE it
 * redeems the ticket or dials the server, so every one of these arrives on a
 * connection that has already opened - which is why they used to read as a
 * plain "disconnected" with nothing said and nothing to press.
 */
type CloseReason =
    | "expired"
    | "noTerminal"
    | "gone"
    | "unreachable"
    | "identity"
    | "login"
    | "shell"
    | "limit"
    | "ended"
    | "elsewhere";

export const CLOSE_REASONS: Record<string, CloseReason | undefined> = {
    "invalid ticket": "expired",
    "could not open terminal": "noTerminal",
    "server unavailable": "gone",
    "connection unavailable": "gone",
    "server unreachable": "unreachable",
    "server identity changed": "identity",
    "server refused the login": "login",
    "could not open a shell on the server": "shell",
    "session limit reached": "limit",
    "session ended": "ended",
    "session opened elsewhere": "elsewhere"
};

/** The control frame a server shell opens with, naming the long-lived session
 *  the socket is attached to. Anything else is terminal output. Pure. */
export function sessionFrame(data: unknown): { id: string; number: number } | null {
    if (typeof data !== "string" || !data.startsWith('{"session"')) return null;
    try {
        const parsed = JSON.parse(data) as { session?: { id?: unknown; number?: unknown } };
        const { id, number } = parsed.session ?? {};
        return typeof id === "string" && typeof number === "number" ? { id, number } : null;
    } catch {
        return null;
    }
}

/** Close codes the sidecar uses for a session it refused or ended (4001-4007). A close
 *  in this range is a refusal even after the socket opened. */
function isRefusal(code: number): boolean {
    return code >= 4000 && code < 5000;
}

/**
 * What a closed socket means for the panel. A session that ran and ended is just
 * over. A refusal - a 4xxx close, which the sidecar sends after the socket has
 * opened - says why, as does any close with a reason before it opened. A close
 * that never opened and says nothing never reached the sidecar at all, which is
 * almost always the certificate. Pure and unit-tested.
 */
export function closeOutcome(
    opened: boolean,
    code: number,
    rawReason: string
): { status: Status; failure: Failure | null } {
    const reason = rawReason.trim();
    if (opened && !(isRefusal(code) && reason)) {
        return { status: { kind: "disconnected" }, failure: null };
    }
    return {
        status:
            reason && !CLOSE_REASONS[reason]
                ? { kind: "reason", text: reason }
                : { kind: "couldNotConnect" },
        failure: reason ? { kind: "refused", reason } : { kind: "unreachable" }
    };
}

/** What looking for a server that stopped answering where it is recorded found:
 *  the address it moved to, or what the search saw instead. */
export type FindServerResult = { found?: string; error?: string; path?: LocalPath };

/** What the note says about the search, from what it returned. */
type Search =
    { kind: "idle" | "looking" | "notFound" | "cannotLook" } | { kind: "error"; text: string };

/** Sort a search result into retry (it moved and was adopted, or it answers
 *  where it is recorded again) or what to say. Pure and unit-tested. */
export function searchOutcome(result: FindServerResult | null): "retry" | Search {
    if (!result) return { kind: "notFound" };
    if (result.found) return "retry";
    if (result.error) return { kind: "error", text: result.error };
    switch (result.path?.kind) {
        case "unknown":
            return { kind: "cannotLook" };
        case "already":
        case "none":
        case "found":
            return "retry";
        default:
            return { kind: "notFound" };
    }
}

/** What the corner of the panel says: one of its own states, or the reason the
 *  far end gave, which is shown as it came. */
type Status =
    | {
          kind:
              | "connecting"
              | "connected"
              | "disconnected"
              | "couldNotConnect"
              | "couldNotAuthorize"
              | "looking";
      }
    | { kind: "connectingTo"; address: string }
    | { kind: "reason"; text: string };

/** The live terminal, for the parts of the panel outside the session effect. */
interface LiveTerminal {
    term: Terminal;
    send: (data: string) => void;
}

/** A right-click on the terminal: where, and what was selected at that moment. */
interface MenuAt {
    x: number;
    y: number;
    selection: string;
}

/**
 * The rows of the terminal's buffer as text, newest last, a wrapped row joined
 * to the one it continues. Reads only the tail Polar is ever given.
 */
function bufferLines(term: Terminal): string[] {
    const buffer = term.buffer.active;
    const start = Math.max(0, buffer.length - POLAR_LINES * 3);
    const lines: string[] = [];
    for (let row = start; row < buffer.length; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const text = line.translateToString(true);
        if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
        else lines.push(text);
    }
    return lines;
}

/** Whether this is a touch screen, kept current. */
function useCoarsePointer(): boolean {
    const [coarse, setCoarse] = useState(false);
    useEffect(() => {
        const query = window.matchMedia?.("(pointer: coarse)");
        if (!query) return;
        const update = () => setCoarse(query.matches);
        update();
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
    }, []);
    return coarse;
}

export function TerminalPanel({
    target,
    label,
    findServer,
    resumeId,
    onSession,
    onClosed,
    onMoved,
    polarPlace,
    toolbar,
    fill = false,
    menuContainer,
    height = "h-80"
}: {
    target: TerminalTarget;
    label: string;
    /** For a server shell: the long-lived session to return to. Absent opens a
     *  new one, whose id arrives through `onSession`. */
    resumeId?: string;
    onSession?: (id: string, number: number) => void;
    /** The socket closed, for whatever reason. */
    onClosed?: () => void;
    /** The server was found at another address, and the terminal is opening
     *  there. */
    onMoved?: (address: string) => void;
    /** Where this terminal is, as Polar is told when asked about it. Defaults
     *  to the label. */
    polarPlace?: string;
    /** More buttons for the header, after the panel's own. */
    toolbar?: ReactNode;
    /** Fill the parent's height instead of the fixed `height`. */
    fill?: boolean;
    /** Where the right-click menu is portalled: the element shown full screen,
     *  when there is one, or nothing would be seen of it. */
    menuContainer?: HTMLElement | null;
    height?: string;
    /** For a server shell: look for the server on the network after nothing
     *  answered at its recorded address, and move it there when found. */
    findServer?: () => Promise<FindServerResult>;
}) {
    const t = useTranslations("common");
    const polar = usePolarOptional();
    const coarse = useCoarsePointer();
    const { layout, change } = useTerminalLayout();
    const keysShown = layout.keys ?? coarse;
    const mountRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<Status>({ kind: "connecting" });
    const [failure, setFailure] = useState<Failure | null>(null);
    // Bumped by Retry: the session is keyed on it, so asking again is a fresh
    // ticket and a fresh socket rather than a reconnect of the dead one.
    const [attempt, setAttempt] = useState(0);
    // The address the server was just found at, said while connecting there.
    const movedTo = useRef<string | null>(null);
    // The server is looked for on its own once per panel, not once per failure:
    // found and still refusing would otherwise go round for as long as it is open.
    const lookedForServer = useRef(false);
    // A Retry returns to the session this panel was on, not a fresh one.
    const sessionRef = useRef(resumeId);
    const callbacks = useRef({ onSession, onClosed });
    callbacks.current = { onSession, onClosed };
    // The key bar's and the menu's way into the live session, and the bar's
    // Ctrl and Alt held for the next key.
    const live = useRef<LiveTerminal | null>(null);
    const heldRef = useRef({ ctrl: false, alt: false });
    const [held, setHeld] = useState({ ctrl: false, alt: false });
    const [menu, setMenu] = useState<MenuAt | null>(null);
    // The object identity of `target` would restart the session on every parent
    // render; its contents are what actually decide the connection.
    const key =
        target.kind === "host"
            ? `host:${target.hostId}:${target.asRoot ? "root" : "login"}`
            : target.kind === "docker"
              ? `docker:${target.connectionId}:${target.containerRef}`
              : target.kind === "agent"
                ? `agent:${target.sessionId}:${target.shell ?? "agent"}`
                : `app:${target.applicationId}`;

    const release = (): void => {
        heldRef.current = { ctrl: false, alt: false };
        setHeld(heldRef.current);
    };

    useEffect(() => {
        let disposed = false;
        let socket: WebSocket | undefined;
        let opened = false;
        // Everything the session set up, undone in reverse when it ends - also
        // when it ends half way, while a ticket or the socket is still on its
        // way, so a closed dialog never leaves a terminal opening behind it.
        const undo: (() => void)[] = [];
        setFailure(null);
        setStatus(
            movedTo.current ? { kind: "connectingTo", address: movedTo.current } : { kind: "connecting" }
        );

        async function start(): Promise<void> {
            const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
                import("@xterm/xterm"),
                import("@xterm/addon-fit")
            ]);
            const mount = mountRef.current;
            if (disposed || !mount) return;

            const term = new XTerm({
                fontSize: 13,
                cursorBlink: true,
                theme: { background: "#0b0e14" }
            });
            undo.push(() => term.dispose());
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(mount);
            const refit = (): void => {
                try {
                    fit.fit();
                } catch {
                    // Not laid out yet (a hidden tab): the next resize fits it.
                }
            };
            refit();

            // Copy and paste the way a desktop terminal does (`clipboardShortcut`).
            // A paste is left to the browser: the key's own paste lands on
            // xterm's focused input, which xterm reads - bracketed where the
            // shell asked for it - with no clipboard permission to ask for.
            const mac = isMacPlatform(navigator.platform ?? "");
            term.attachCustomKeyEventHandler((event) => {
                const action = clipboardShortcut(event, term.hasSelection(), mac);
                if (action === "paste") return false;
                if (action !== "copy") return true;
                event.preventDefault();
                const text = term.getSelection();
                // Ctrl+C clears what it copied, so the next one is the interrupt.
                if (!event.shiftKey) term.clearSelection();
                void copyText(text);
                return false;
            });

            // Mint a ticket, then open the WS with the token as the subprotocol.
            const res = await fetch("/api/deploy/terminal/ticket", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(
                    target.kind === "host"
                        ? {
                              hostId: target.hostId,
                              mode: target.asRoot ? "ssh-root" : "ssh",
                              terminalSessionId: sessionRef.current
                          }
                        : target.kind === "docker"
                          ? { connectionId: target.connectionId, containerRef: target.containerRef }
                          : target.kind === "agent"
                            ? { sessionId: target.sessionId, ...(target.shell === undefined ? {} : { shell: true }) }
                            : { applicationId: target.applicationId, mode: "terminal" }
                )
            }).catch(() => null);
            if (disposed) return;
            if (!res?.ok) {
                // The route says why (no such connection, no pinned key, not
                // permitted), and that is more use than "could not authorize".
                const reason = (await res?.json().catch(() => null)) as { error?: string } | null;
                if (disposed) return;
                setStatus(
                    reason?.error
                        ? { kind: "reason", text: reason.error }
                        : { kind: "couldNotAuthorize" }
                );
                return;
            }
            const { token } = (await res.json()) as { token: string };
            if (disposed) return;
            const scheme = window.location.protocol === "https:" ? "wss" : "ws";
            const ws = new WebSocket(`${scheme}://${window.location.host}/api/deploy/ws`, token);
            socket = ws;
            ws.binaryType = "arraybuffer";

            const sendSize = (): void => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
                }
            };

            ws.onopen = () => {
                opened = true;
                movedTo.current = null;
                setStatus({ kind: "connected" });
                refit();
                sendSize();
            };
            ws.onmessage = (event) => {
                const frame = target.kind === "host" ? sessionFrame(event.data) : null;
                if (frame) {
                    sessionRef.current = frame.id;
                    callbacks.current.onSession?.(frame.id, frame.number);
                    return;
                }
                term.write(
                    event.data instanceof ArrayBuffer
                        ? new Uint8Array(event.data)
                        : (event.data as string)
                );
            };
            // A session that ran and ended is just over. One that never opened is a
            // failure, and which of the two it is decides what there is to say: the
            // far end closing with a reason (no ticket, no shell) is that reason,
            // while a close with nothing to say never got there at all.
            ws.onclose = (event) => {
                if (disposed) return;
                const outcome = closeOutcome(opened, event.code, event.reason);
                setStatus(outcome.status);
                setFailure(outcome.failure);
                callbacks.current.onClosed?.();
            };
            // Fires before the close on a connection that never opened; the close
            // handler has the code and reason, so this only avoids a silent gap.
            ws.onerror = () => !opened && !disposed && setStatus({ kind: "couldNotConnect" });

            const send = (data: string): void => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            };
            live.current = { term, send };
            undo.push(() => {
                live.current = null;
            });
            const onData = term.onData((typed) => {
                const { ctrl, alt } = heldRef.current;
                if (!ctrl && !alt) return send(typed);
                release();
                send(withModifiers(typed, ctrl, alt));
            });
            undo.push(() => onData.dispose());
            // Every size change - the window, the dialog filling it, full screen,
            // a phone's keyboard - refits, and a new size is told to the shell.
            const onResize = term.onResize(sendSize);
            undo.push(() => onResize.dispose());
            let frame = 0;
            const observer = new ResizeObserver(() => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(refit);
            });
            observer.observe(mount);
            undo.push(() => {
                cancelAnimationFrame(frame);
                observer.disconnect();
            });
        }

        void start();
        return () => {
            disposed = true;
            socket?.close();
            for (const step of undo.reverse()) step();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in
        // for the target's contents; depending on the object would reconnect on
        // every parent render.
    }, [key, attempt]);

    useEffect(() => {
        if (resumeId === undefined || resumeId === sessionRef.current) return;
        sessionRef.current = resumeId;
        setAttempt((n) => n + 1);
    }, [resumeId]);

    const focus = (): void => live.current?.term.focus();

    const copySelection = async (text: string): Promise<void> => {
        if (!text) return;
        contextMenuNotice(t((await copyText(text)) ? "terminal.menu.copied" : "terminal.menu.copyFailed"));
    };

    // The menu's Paste has to read the clipboard itself (a key's paste does not):
    // through the one reader the app's menus share, then into xterm's own paste
    // so a shell that asked for bracketed paste gets it.
    const pasteFromMenu = async (): Promise<void> => {
        const read = await readClipboard();
        const current = live.current;
        if (!read.ok) {
            contextMenuNotice(t("terminal.menu.pasteBlocked"));
        } else if (current && read.contents.text) {
            // A shell takes text only: a picture on the clipboard pastes nothing.
            current.term.paste(read.contents.text);
        }
        focus();
    };

    const askPolar = (selection: string): void => {
        if (!polar?.allowed) return;
        const current = live.current;
        const excerpt = terminalExcerpt(current ? bufferLines(current.term) : [], selection, SELECTION_QUOTE_MAX);
        const place = polarPlace ?? label;
        polar.ask(
            excerpt?.text ?? "",
            excerpt
                ? t(excerpt.source === "selection" ? "terminal.polar.aboutSelection" : "terminal.polar.aboutOutput", {
                      place
                  })
                : t("terminal.polar.aboutNothing", { place }),
            false,
            // A server's shell binds the chat to that server and account, so
            // a command Polar proposes goes there unless it names another.
            target.kind === "host"
                ? { id: target.hostId, root: target.asRoot === true, name: place }
                : null
        );
    };

    const statusText =
        status.kind === "reason"
            ? status.text
            : status.kind === "connectingTo"
              ? t("terminal.status.connectingTo", { address: status.address })
              : t(`terminal.status.${status.kind}`);

    return (
        <div className={`flex min-w-0 flex-col gap-2 ${fill ? "min-h-0 flex-1" : ""}`}>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                </span>
                <span className="min-w-0 max-w-[45%] truncate" title={statusText} aria-live="polite">
                    {statusText}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                    {polar?.allowed ? (
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t("terminal.toolbar.askPolar")}
                            title={t("terminal.toolbar.askPolar")}
                            onClick={() => askPolar(live.current?.term.getSelection() ?? "")}
                        >
                            <AppLogo appId="polar" size={14} />
                        </Button>
                    ) : null}
                    {coarse ? (
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t("terminal.toolbar.typeHere")}
                            title={t("terminal.toolbar.typeHere")}
                            onClick={focus}
                        >
                            <Keyboard />
                        </Button>
                    ) : null}
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-pressed={keysShown}
                        aria-label={t(keysShown ? "terminal.toolbar.hideKeys" : "terminal.toolbar.showKeys")}
                        title={t(keysShown ? "terminal.toolbar.hideKeys" : "terminal.toolbar.showKeys")}
                        onClick={() => change({ keys: !keysShown })}
                    >
                        <Command />
                    </Button>
                    {toolbar}
                </div>
            </div>
            <div
                ref={mountRef}
                className={`${fill ? "min-h-40 flex-1" : height} w-full min-w-0 overflow-hidden rounded-md bg-[#0b0e14] p-2`}
                onContextMenu={(event) => {
                    // The terminal's own menu: Polaris's global one would see
                    // only xterm's hidden input, when the click landed on it.
                    event.preventDefault();
                    setMenu({
                        x: event.clientX,
                        y: event.clientY,
                        selection: live.current?.term.getSelection() ?? ""
                    });
                }}
            />
            <DropdownMenu open={menu !== null} onOpenChange={(open) => (open ? undefined : setMenu(null))}>
                <DropdownMenuTrigger asChild>
                    <span
                        aria-hidden
                        tabIndex={-1}
                        className="pointer-events-none fixed size-0"
                        style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }}
                    />
                </DropdownMenuTrigger>
                {menu ? (
                    <DropdownMenuContent
                        align="start"
                        sideOffset={2}
                        container={menuContainer}
                        data-terminal-menu
                        onCloseAutoFocus={(event) => {
                            // Back to the terminal, not to the invisible anchor.
                            event.preventDefault();
                            focus();
                        }}
                    >
                        <DropdownMenuItem
                            disabled={!menu.selection}
                            onSelect={() => void copySelection(menu.selection)}
                        >
                            <Copy />
                            {t("terminal.menu.copy")}
                            <MenuShortcut keys="Mod+Shift+C" />
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void pasteFromMenu()}>
                            <ClipboardPaste />
                            {t("terminal.menu.paste")}
                            <MenuShortcut keys="Mod+V" />
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => live.current?.term.selectAll()}>
                            <TextSelect />
                            {t("terminal.menu.selectAll")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => live.current?.term.clear()}>
                            <Eraser />
                            {t("terminal.menu.clear")}
                        </DropdownMenuItem>
                        {polar?.allowed ? (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onSelect={() => askPolar(menu.selection)}>
                                    <AppLogo appId="polar" size={16} />
                                    {t(menu.selection ? "terminal.menu.askPolarSelection" : "terminal.menu.askPolar")}
                                </DropdownMenuItem>
                            </>
                        ) : null}
                    </DropdownMenuContent>
                ) : null}
            </DropdownMenu>
            {keysShown ? (
                <KeyBar
                    held={held}
                    onKey={(barKey) => {
                        if (barKey === "ctrl" || barKey === "alt") {
                            heldRef.current = { ...heldRef.current, [barKey]: !heldRef.current[barKey] };
                            setHeld(heldRef.current);
                        } else {
                            const { ctrl, alt } = heldRef.current;
                            live.current?.send(barKeySequence(barKey, ctrl, alt));
                            release();
                        }
                        focus();
                    }}
                />
            ) : null}
            {failure ? (
                <FailureNote
                    failure={failure}
                    label={label}
                    findServer={findServer}
                    looked={lookedForServer}
                    onSearching={(searching) =>
                        setStatus((current) =>
                            searching
                                ? { kind: "looking" }
                                : current.kind === "looking"
                                  ? { kind: "couldNotConnect" }
                                  : current
                        )
                    }
                    onRetry={(found) => {
                        if (found) {
                            movedTo.current = found;
                            onMoved?.(found);
                        }
                        setAttempt((n) => n + 1);
                    }}
                />
            ) : null}
        </div>
    );
}

const KEY_ICON = { up: ArrowUp, down: ArrowDown, left: ArrowLeft, right: ArrowRight } as const;

/** How far the on-screen keyboard covers the window, kept current as it opens,
 *  closes and changes height. Zero where the browser cannot say. */
function useKeyboardInset(): number {
    const [inset, setInset] = useState(0);
    useEffect(() => {
        const viewport = window.visualViewport;
        if (!viewport) return;
        const measure = () => setInset(keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop));
        measure();
        viewport.addEventListener("resize", measure);
        viewport.addEventListener("scroll", measure);
        return () => {
            viewport.removeEventListener("resize", measure);
            viewport.removeEventListener("scroll", measure);
        };
    }, []);
    return inset;
}

/**
 * The keys a keyboard may lack - Escape, Tab, Ctrl and Alt for the next key,
 * the arrows, the shell's symbols, ^C ^D ^L - shown by default on a touch
 * screen and switched on or off from the header anywhere. Under the terminal
 * while the on-screen keyboard is down; pinned just above it while it is up,
 * the way Termius and Blink do it. A press never takes the focus, so the
 * keyboard stays where it is.
 */
function KeyBar({ held, onKey }: { held: { ctrl: boolean; alt: boolean }; onKey: (key: BarKey) => void }) {
    const t = useTranslations("common");
    const inset = useKeyboardInset();
    return (
        <div
            role="toolbar"
            aria-label={t("terminal.keys.bar")}
            style={inset > 0 ? { bottom: inset } : undefined}
            className={`flex min-w-0 gap-1 overflow-x-auto ${
                inset > 0 ? "fixed inset-x-0 z-50 border-t border-border bg-elevated px-2 py-1" : ""
            }`}
        >
            {BAR_KEYS.map((key) => {
                const Icon = key === "up" || key === "down" || key === "left" || key === "right" ? KEY_ICON[key] : null;
                const named = key === "esc" || key === "tab" || key === "ctrl" || key === "alt";
                const name = named ? t(`terminal.keys.${key}Name`) : t(`terminal.keys.${key}`);
                const face = barKeyFace(key) ?? (named ? t(`terminal.keys.${key}`) : null);
                const modifier = key === "ctrl" || key === "alt";
                const on = modifier && held[key];
                return (
                    <button
                        key={key}
                        type="button"
                        aria-label={name}
                        title={name}
                        aria-pressed={modifier ? on : undefined}
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => onKey(key)}
                        className={`grid min-h-11 min-w-11 shrink-0 place-items-center rounded-md px-2 font-mono text-xs [@media(pointer:fine)]:min-h-8 [@media(pointer:fine)]:min-w-8 ${
                            on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground active:bg-card-hover"
                        }`}
                    >
                        {Icon ? <Icon className="size-4" aria-hidden /> : face}
                    </button>
                );
            })}
        </div>
    );
}
/**
 * What to do about a session that never opened. A terminal that reaches the server
 * and is turned away says why and is worth another try; one the browser never let
 * out says nothing at all, and the answer is almost never "try again" - it is the
 * certificate for this address, which a WebSocket refuses silently where a page
 * would at least offer to continue.
 *
 * A server that did not answer at its recorded address is looked for once on the
 * network, without being asked: it is the one failure here Polaris can repair
 * itself, and almost always a DHCP lease that moved. Found, the terminal opens
 * again at the new address.
 */
function FailureNote({
    failure,
    label,
    findServer,
    looked,
    onSearching,
    onRetry
}: {
    failure: Failure;
    /** Who and where the terminal is, as the header shows it. */
    label: string;
    findServer?: () => Promise<FindServerResult>;
    looked: { current: boolean };
    /** The search for the server started or stopped. */
    onSearching: (searching: boolean) => void;
    /** Try again; `found` is the address the server was found at. */
    onRetry: (found?: string) => void;
}) {
    const t = useTranslations("common");
    const known = failure.kind === "refused" ? CLOSE_REASONS[failure.reason] : undefined;
    const canFind = known === "unreachable" && Boolean(findServer);
    const [search, setSearch] = useState<Search>({ kind: "idle" });
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const look = async (): Promise<void> => {
        if (!findServer) return;
        setSearch({ kind: "looking" });
        onSearching(true);
        const result = await findServer().catch(() => null);
        const outcome = searchOutcome(result);
        if (!mounted.current) return;
        onSearching(false);
        if (outcome === "retry") onRetry(result?.found);
        else setSearch(outcome);
    };

    useEffect(() => {
        if (!canFind || looked.current) return;
        looked.current = true;
        void look();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failure
    }, [canFind]);

    // A server that moved is the common case and Polaris is already on it: said
    // as what is happening, not as a warning that goes away a second later.
    if (canFind && search.kind === "looking") {
        return (
            <p
                role="status"
                className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
                <span className="min-w-0">{t("terminal.searching", { label })}</span>
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {failure.kind === "refused" ? (
                    <span className="min-w-0">
                        {known
                            ? t(`terminal.reasons.${known}`)
                            : t("terminal.refused", { reason: failure.reason })}
                        {search.kind === "looking" ? ` ${t("terminal.looking")}` : null}
                        {search.kind === "notFound" ? ` ${t("terminal.notFound")}` : null}
                        {search.kind === "cannotLook" ? ` ${t("terminal.cannotLook")}` : null}
                        {search.kind === "error" ? ` ${search.text}` : null}
                    </span>
                ) : (
                    <span>
                        {t.rich("terminal.untrusted", {
                            download: (chunks) => (
                                <a
                                    key="download"
                                    href="/api/system/local-ca"
                                    className="font-medium text-foreground underline underline-offset-2"
                                >
                                    {chunks}
                                </a>
                            )
                        })}
                    </span>
                )}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => onRetry()}>
                    <RotateCw className="size-3.5" /> {t("terminal.retry")}
                </Button>
                {canFind ? (
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={search.kind === "looking"}
                        onClick={() => void look()}
                    >
                        <Search className="size-3.5" /> {t("terminal.lookForIt")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
