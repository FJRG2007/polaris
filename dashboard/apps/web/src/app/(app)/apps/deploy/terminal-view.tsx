"use client";

/**
 * The one terminal surface in the dashboard: xterm.js mounted lazily (it stays
 * out of the server bundle), fitted to its box, themed, with the find bar, the
 * right-click menu, Ask Polar and the phone key row. What it is a terminal OF is
 * the transport's business - a shell over the deploy sidecar, a pane a terminal
 * shared from the desktop, a game server's console - so every one of them looks
 * and behaves the same.
 *
 * A transport is handed a sink once the terminal is on screen: it writes output
 * into it, says where typed input goes (or nothing, for a read-only view), and
 * is told every size change. It returns its own teardown.
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
    Search,
    TextSelect
} from "lucide-react";
import { SELECTION_QUOTE_MAX } from "@/lib/polar/shared";
import { useTerminalLayout } from "@/lib/use-terminal-layout";
import { contextMenuNotice } from "@/lib/context-menu/target";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { copyText, readClipboard } from "@/lib/context-menu/editing";
import { usePolarOptional, type PolarServerBinding } from "@/components/polar/polar-panel";
import { FIND_HIGHLIGHT_LIMIT, TerminalFindBar, type TerminalSearch } from "./terminal-find-bar";
import * as keys from "@/lib/terminal-keys";

/** What a transport gets from the terminal it feeds. */
export interface TerminalSink {
    write: (data: string | Uint8Array) => void;
    /** The size now; later ones arrive through `onResize`. */
    size: () => { cols: number; rows: number };
    onResize: (listener: (size: { cols: number; rows: number }) => void) => () => void;
    /** Fit the terminal to its box again (after the far end answered, say). */
    refit: () => void;
    /** Where typed input goes from now on; null drops it. */
    input: (send: ((data: string) => void) | null) => void;
}

/** Connects a terminal to whatever it shows; returns the teardown. */
export type TerminalTransport = (sink: TerminalSink) => () => void;

/** The live terminal, for the parts of the view outside the mount effect. */
interface LiveTerminal {
    term: Terminal;
    send: ((data: string) => void) | null;
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
    const start = Math.max(0, buffer.length - keys.POLAR_LINES * 3);
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

/** Ctrl+Shift+F (Cmd+Shift+F on a Mac): open the find bar. Plain Ctrl+F stays
 *  with the shell, where it is a key readline and editors use. */
export function isFindShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
    return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f";
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

export function TerminalView({
    transport,
    transportKey,
    readOnly = false,
    label,
    status,
    polarPlace,
    polarServer = null,
    toolbar,
    fill = false,
    menuContainer,
    height = "h-80",
    children
}: {
    transport: TerminalTransport;
    /** The connection's identity: a new key is a fresh terminal and a fresh
     *  transport; anything else keeps the one on screen. */
    transportKey: string;
    /** Output only: no cursor, no typing, no key row. */
    readOnly?: boolean;
    /** Who and where, at the start of the header. */
    label?: string;
    /** The connection's state, at the end of the header. */
    status?: string;
    /** Where this terminal is, as Polar is told when asked about it. */
    polarPlace?: string;
    /** A server's shell binds Polar's chat to that server and account. */
    polarServer?: PolarServerBinding | null;
    /** More buttons for the header, after the view's own. */
    toolbar?: ReactNode;
    /** Fill the parent's height instead of the fixed `height`. */
    fill?: boolean;
    /** Where the right-click menu is portalled: the element shown full screen,
     *  when there is one, or nothing would be seen of it. */
    menuContainer?: HTMLElement | null;
    height?: string;
    /** Shown under the terminal: a failure note, a line to send. */
    children?: ReactNode;
}) {
    const t = useTranslations("common");
    const polar = usePolarOptional();
    const coarse = useCoarsePointer();
    const { layout, change } = useTerminalLayout();
    const keysShown = !readOnly && (layout.keys ?? coarse);
    const mountRef = useRef<HTMLDivElement>(null);
    const transportRef = useRef(transport);
    transportRef.current = transport;
    // The key bar's and the menu's way into the live session, and the bar's
    // Ctrl and Alt held for the next key.
    const live = useRef<LiveTerminal | null>(null);
    const heldRef = useRef({ ctrl: false, alt: false });
    const [held, setHeld] = useState({ ctrl: false, alt: false });
    const [menu, setMenu] = useState<MenuAt | null>(null);
    // Find in the output (terminal-find-bar.tsx); the addon is the terminal's,
    // so it comes and goes with it.
    const [search, setSearch] = useState<TerminalSearch | null>(null);
    const [finding, setFinding] = useState(false);
    // Read by the menu's close, which must leave the keyboard in the find bar
    // it just opened rather than take it back to the terminal.
    const findingRef = useRef(false);
    findingRef.current = finding;

    const release = (): void => {
        heldRef.current = { ctrl: false, alt: false };
        setHeld(heldRef.current);
    };

    useEffect(() => {
        let disposed = false;
        // Everything the terminal set up, undone in reverse when it goes - also
        // while xterm is still loading, so a closed dialog leaves nothing behind.
        const undo: (() => void)[] = [];

        async function start(): Promise<void> {
            const [{ Terminal: XTerm }, { FitAddon }, { SearchAddon }] = await Promise.all([
                import("@xterm/xterm"),
                import("@xterm/addon-fit"),
                import("@xterm/addon-search")
            ]);
            const mount = mountRef.current;
            if (disposed || !mount) return;

            const term = new XTerm({
                fontSize: 13,
                cursorBlink: !readOnly,
                disableStdin: readOnly,
                scrollback: 5000,
                theme: { background: "#0b0e14" },
                // The search addon draws its match highlights as decorations,
                // which xterm only offers behind this flag.
                allowProposedApi: true
            });
            undo.push(() => term.dispose());
            const fit = new FitAddon();
            term.loadAddon(fit);
            const finder = new SearchAddon({ highlightLimit: FIND_HIGHLIGHT_LIMIT });
            term.loadAddon(finder);
            setSearch(finder);
            undo.push(() => setSearch(null));
            term.open(mount);
            const refit = (): void => {
                try {
                    fit.fit();
                } catch {
                    // Not laid out yet (a hidden tab): the next resize fits it.
                }
            };
            refit();

            // Copy and paste the way a desktop terminal does (`keys.clipboardShortcut`).
            // A paste is left to the browser: the key's own paste lands on
            // xterm's focused input, which xterm reads - bracketed where the
            // shell asked for it - with no clipboard permission to ask for.
            const mac = keys.isMacPlatform(navigator.platform ?? "");
            term.attachCustomKeyEventHandler((event) => {
                if (isFindShortcut(event)) {
                    if (event.type === "keydown") {
                        event.preventDefault();
                        setFinding(true);
                    }
                    return false;
                }
                const action = keys.clipboardShortcut(event, term.hasSelection(), mac);
                if (action === "paste") return false;
                if (action !== "copy") return true;
                event.preventDefault();
                const text = term.getSelection();
                // Ctrl+C clears what it copied, so the next one is the interrupt.
                if (!event.shiftKey) term.clearSelection();
                void copyText(text);
                return false;
            });

            const current: LiveTerminal = { term, send: null };
            live.current = current;
            undo.push(() => {
                live.current = null;
            });
            const onData = term.onData((typed) => {
                const send = current.send;
                if (!send) return;
                const { ctrl, alt } = heldRef.current;
                if (!ctrl && !alt) return send(typed);
                release();
                send(keys.withModifiers(typed, ctrl, alt));
            });
            undo.push(() => onData.dispose());
            // Every size change - the window, the dialog filling it, full screen,
            // a phone's keyboard - refits.
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

            const stop = transportRef.current({
                write: (data) => term.write(data),
                size: () => ({ cols: term.cols, rows: term.rows }),
                onResize: (listener) => {
                    const subscription = term.onResize(listener);
                    return () => subscription.dispose();
                },
                refit,
                input: (send) => {
                    current.send = readOnly ? null : send;
                }
            });
            undo.push(stop);
        }

        void start();
        return () => {
            disposed = true;
            for (const step of undo.reverse()) step();
        };
    }, [transportKey, readOnly]);

    const focus = (): void => live.current?.term.focus();

    const closeFind = (): void => {
        setFinding(false);
        focus();
    };

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
        const excerpt = keys.terminalExcerpt(current ? bufferLines(current.term) : [], selection, SELECTION_QUOTE_MAX);
        const place = polarPlace ?? label ?? "";
        polar.ask(
            excerpt?.text ?? "",
            excerpt
                ? t(excerpt.source === "selection" ? "terminal.polar.aboutSelection" : "terminal.polar.aboutOutput", {
                      place
                  })
                : t("terminal.polar.aboutNothing", { place }),
            false,
            polarServer
        );
    };

    return (
        <div className={`flex min-w-0 flex-col gap-2 ${fill ? "min-h-0 flex-1" : ""}`}>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="min-w-0 flex-1 truncate" title={label}>
                    {label}
                </span>
                {status ? (
                    <span className="min-w-0 max-w-[45%] truncate" title={status} aria-live="polite">
                        {status}
                    </span>
                ) : null}
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
                    {coarse && !readOnly ? (
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
                        aria-pressed={finding}
                        aria-label={t("terminal.toolbar.find")}
                        title={t("terminal.toolbar.find")}
                        onClick={() => (finding ? closeFind() : setFinding(true))}
                    >
                        <Search />
                    </Button>
                    {readOnly ? null : (
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
                    )}
                    {toolbar}
                </div>
            </div>
            {finding ? <TerminalFindBar search={search} onClose={closeFind} /> : null}
            <div
                ref={mountRef}
                data-terminal-mount
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
                            // Back to the terminal, not to the invisible anchor -
                            // unless the menu just opened the find bar.
                            event.preventDefault();
                            if (!findingRef.current) focus();
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
                        {readOnly ? null : (
                            <DropdownMenuItem onSelect={() => void pasteFromMenu()}>
                                <ClipboardPaste />
                                {t("terminal.menu.paste")}
                                <MenuShortcut keys="Mod+V" />
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                            onSelect={() => {
                                findingRef.current = true;
                                setFinding(true);
                            }}
                        >
                            <Search />
                            {t("terminal.menu.find")}
                            <MenuShortcut keys="Mod+Shift+F" />
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
                            live.current?.send?.(keys.barKeySequence(barKey, ctrl, alt));
                            release();
                        }
                        focus();
                    }}
                />
            ) : null}
            {children}
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
        const measure = () => setInset(keys.keyboardInset(window.innerHeight, viewport.height, viewport.offsetTop));
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
function KeyBar({ held, onKey }: { held: { ctrl: boolean; alt: boolean }; onKey: (key: keys.BarKey) => void }) {
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
            {keys.BAR_KEYS.map((key) => {
                const Icon = key === "up" || key === "down" || key === "left" || key === "right" ? KEY_ICON[key] : null;
                const named = key === "esc" || key === "tab" || key === "ctrl" || key === "alt";
                const name = named ? t(`terminal.keys.${key}Name`) : t(`terminal.keys.${key}`);
                const face = keys.barKeyFace(key) ?? (named ? t(`terminal.keys.${key}`) : null);
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
