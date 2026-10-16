"use client";

/**
 * The block editor every automation is edited with: each trigger, condition and
 * step is a row that reads as a sentence, with the facts that matter drawn as
 * chips beside it, and the row's menu does everything that can be done to one
 * block. Pressing a row selects it and opens its fields in a panel beside the
 * list - a drawer from the bottom on a phone - so the list itself stays short
 * enough to read as the automation it is.
 *
 * Every word arrives in `BlockStrings`, already in the reader's language; what a
 * block is, and what its sentence says, is the surface's own business.
 */

import { cn } from "../lib/cn";
import { Input } from "../components/input";
import { Button } from "../components/button";
import { Textarea } from "../components/textarea";
import * as RadixDialog from "@radix-ui/react-dialog";
import { ResizeHandle } from "../components/resize-handle";
import { applePlatform, formatShortcut } from "../lib/shortcut";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "../components/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "../components/dropdown-menu";
import {
    ArrowDown,
    ArrowUp,
    ClipboardPaste,
    Copy,
    CopyPlus,
    EyeOff,
    MoreVertical,
    Pencil,
    Power,
    Scissors,
    StickyNote,
    Trash2,
    X
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useId,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode
} from "react";

/** Every word the block editor says on its own. */
export interface BlockStrings {
    readonly menu: string;
    readonly rename: string;
    readonly addNote: string;
    readonly editNote: string;
    readonly duplicate: string;
    readonly copy: string;
    readonly cut: string;
    readonly paste: string;
    readonly moveUp: string;
    readonly moveDown: string;
    readonly disable: string;
    readonly enable: string;
    readonly remove: string;
    /** The chip on a block that is switched off. */
    readonly disabled: string;
    /** The note icon's name, read out. */
    readonly note: string;
    readonly closePanel: string;
    /** The panel's edge, for a screen reader. */
    readonly resizePanel: string;
    readonly save: string;
    readonly cancel: string;
    /** The button in the note dialog that takes the note away. */
    readonly removeNote: string;
}

/** What a shortcut is, written for `formatShortcut`. */
export const BLOCK_KEYS = {
    copy: "Mod+C",
    cut: "Mod+X",
    paste: "Mod+V",
    remove: "Mod+Delete",
    undo: "Mod+Z",
    redo: "Mod+Shift+Z",
    save: "Mod+S"
} as const;

/** A small fact about a block, drawn after its sentence: "above 10", "for 5 min". */
export function BlockChip({ children, tone }: { children: ReactNode; tone?: "muted" }) {
    return (
        <span
            className={cn(
                "inline-flex max-w-full shrink-0 items-center truncate rounded-full border border-border px-2 py-0.5 text-[0.6875rem] leading-4",
                tone === "muted" ? "text-muted-foreground" : "text-foreground"
            )}
        >
            {children}
        </span>
    );
}

/**
 * One block, collapsed to a line: drag handle, number, icon, its sentence (or
 * the name somebody gave it), its chips, the note behind an icon, and its menu.
 * The row itself is the button that selects it; Delete on a focused row removes
 * the block, the same as the menu's Delete.
 */
export function BlockRow({
    handle,
    number,
    icon,
    title,
    chips,
    note,
    enabled = true,
    selected,
    state = "ok",
    strings,
    menu,
    onSelect,
    onRemove
}: {
    handle?: ReactNode;
    number?: number;
    icon?: ReactNode;
    title: string;
    chips?: readonly ReactNode[];
    note?: string;
    enabled?: boolean;
    selected?: boolean;
    /** Whether something about it is unfinished or wrong, as the canvas marks it. */
    state?: "ok" | "incomplete" | "invalid";
    strings: BlockStrings;
    menu?: ReactNode;
    onSelect: () => void;
    onRemove?: () => void;
}) {
    const onKeyDown = (event: ReactKeyboardEvent) => {
        if (!onRemove || (event.key !== "Delete" && event.key !== "Backspace")) return;
        event.preventDefault();
        onRemove();
    };
    return (
        <div
            className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-lg border bg-card px-1.5 py-1",
                selected ? "border-primary ring-1 ring-primary" : "border-border",
                state === "invalid" && !selected && "border-danger",
                !enabled && "bg-muted/40"
            )}
        >
            {handle}
            {number !== undefined && (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
                    {number}
                </span>
            )}
            <button
                type="button"
                aria-pressed={selected ?? false}
                onClick={onSelect}
                onKeyDown={onKeyDown}
                className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                {icon && (
                    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                        {icon}
                    </span>
                )}
                <span
                    className={cn(
                        "min-w-0 truncate text-sm",
                        !enabled && "text-muted-foreground line-through decoration-1"
                    )}
                    title={title}
                >
                    {title}
                </span>
                {chips?.map((chip, index) => <BlockChip key={index}>{chip}</BlockChip>)}
                {!enabled && <BlockChip tone="muted">{strings.disabled}</BlockChip>}
                {state !== "ok" && (
                    <span
                        aria-hidden="true"
                        className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            state === "invalid" ? "bg-danger" : "bg-warning"
                        )}
                    />
                )}
            </button>
            {note && (
                <span
                    role="img"
                    aria-label={`${strings.note}: ${note}`}
                    title={note}
                    className="flex size-7 shrink-0 items-center justify-center text-muted-foreground"
                >
                    <StickyNote className="size-3.5" />
                </span>
            )}
            {menu}
        </div>
    );
}

/** The key a shortcut is pressed with, as this machine writes it; hidden on a
 *  touch screen, where there is no keyboard to press it on. */
function Hint({ spec }: { spec: string }) {
    const [text, setText] = useState("");
    useEffect(() => setText(formatShortcut(spec, applePlatform())), [spec]);
    if (!text) return null;
    return (
        <span className="ml-auto pl-4 text-[0.6875rem] tabular-nums text-muted-foreground [@media(pointer:coarse)]:hidden">
            {text}
        </span>
    );
}

/** What can be done to one block. Anything left undefined is not offered. */
export interface BlockActions {
    readonly onRename?: () => void;
    readonly onNote?: () => void;
    readonly hasNote?: boolean;
    readonly onDuplicate?: () => void;
    readonly onCopy?: () => void;
    readonly onCut?: () => void;
    /** Offered only when the clipboard holds a block that fits here. */
    readonly onPaste?: () => void;
    readonly onUp?: () => void;
    readonly onDown?: () => void;
    /** The switch, on a surface whose runs skip a disabled block. */
    readonly onToggle?: () => void;
    readonly enabled?: boolean;
    readonly onRemove?: () => void;
}

/** The row's menu: the same order and the same shortcuts on every surface. */
export function BlockMenu({
    strings,
    actions,
    label
}: {
    strings: BlockStrings;
    actions: BlockActions;
    /** What the menu is for, read out with its button: the block's title. */
    label: string;
}) {
    const item = (
        icon: ReactNode,
        text: string,
        run: (() => void) | undefined,
        spec?: string,
        danger?: boolean
    ) =>
        run ? (
            <DropdownMenuItem
                onSelect={run}
                className={cn("gap-2", danger && "text-danger focus:text-danger")}
            >
                {icon}
                <span className="min-w-0 flex-1 truncate" title={text}>
                    {text}
                </span>
                {spec && <Hint spec={spec} />}
            </DropdownMenuItem>
        ) : null;
    const name = `${strings.menu}: ${label}`;
    const first = actions.onRename || actions.onNote;
    const edit =
        actions.onDuplicate ||
        actions.onCopy ||
        actions.onCut ||
        actions.onPaste ||
        actions.onUp ||
        actions.onDown;
    const last = actions.onToggle || actions.onRemove;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-7 shrink-0 p-0"
                    aria-label={name}
                    title={strings.menu}
                >
                    <MoreVertical className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
                {item(<Pencil className="size-4" />, strings.rename, actions.onRename)}
                {item(
                    <StickyNote className="size-4" />,
                    actions.hasNote ? strings.editNote : strings.addNote,
                    actions.onNote
                )}
                {first && edit && <DropdownMenuSeparator />}
                {item(<CopyPlus className="size-4" />, strings.duplicate, actions.onDuplicate)}
                {item(<Copy className="size-4" />, strings.copy, actions.onCopy, BLOCK_KEYS.copy)}
                {item(<Scissors className="size-4" />, strings.cut, actions.onCut, BLOCK_KEYS.cut)}
                {item(
                    <ClipboardPaste className="size-4" />,
                    strings.paste,
                    actions.onPaste,
                    BLOCK_KEYS.paste
                )}
                {item(<ArrowUp className="size-4" />, strings.moveUp, actions.onUp)}
                {item(<ArrowDown className="size-4" />, strings.moveDown, actions.onDown)}
                {(first || edit) && last && <DropdownMenuSeparator />}
                {item(
                    actions.enabled === false ? (
                        <Power className="size-4" />
                    ) : (
                        <EyeOff className="size-4" />
                    ),
                    actions.enabled === false ? strings.enable : strings.disable,
                    actions.onToggle
                )}
                {item(
                    <Trash2 className="size-4" />,
                    strings.remove,
                    actions.onRemove,
                    BLOCK_KEYS.remove,
                    true
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Whether the window is at least this wide. True before the first measure and
 *  where there is no window to ask, so the server and a test draw the wide one. */
export function useWide(query = "(min-width: 1024px)"): boolean {
    const [wide, setWide] = useState(true);
    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
        const media = window.matchMedia(query);
        const update = () => setWide(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, [query]);
    return wide;
}

const PANEL_WIDTH = { initial: 380, min: 300, max: 640 };
const SHEET_HEIGHT = { min: 220 };

function readSize(key: string, fallback: number, min: number, max: number): number {
    try {
        const stored = Number(window.localStorage.getItem(key));
        return Number.isFinite(stored) && stored >= min && stored <= max ? stored : fallback;
    } catch {
        return fallback;
    }
}

function writeSize(key: string, size: number): void {
    try {
        window.localStorage.setItem(key, String(Math.round(size)));
    } catch {
        // No storage here: the size lasts as long as the page does.
    }
}

/**
 * The selected block's fields, beside the list it belongs to.
 *
 * On a wide screen a panel on the right whose edge can be dragged (its width is
 * kept in this browser under `sizeKey`); on a narrow one a drawer from the
 * bottom whose top edge can be dragged, and which closes like any dialog. The
 * list stays visible on a wide screen while a block is edited.
 */
export function BlockPanel({
    open,
    title,
    icon,
    menu,
    strings,
    sizeKey,
    onClose,
    children
}: {
    open: boolean;
    title: string;
    icon?: ReactNode;
    menu?: ReactNode;
    strings: BlockStrings;
    sizeKey: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const wide = useWide();
    const [width, setWidth] = useState(PANEL_WIDTH.initial);
    const [height, setHeight] = useState(0);
    useEffect(() => {
        setWidth(readSize(sizeKey, PANEL_WIDTH.initial, PANEL_WIDTH.min, PANEL_WIDTH.max));
    }, [sizeKey]);
    const titleId = useId();
    if (!open) return null;

    const heading = (
        <header className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
            {icon && (
                <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
                    {icon}
                </span>
            )}
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
                {title}
            </h2>
            {menu}
            <Button
                size="sm"
                variant="ghost"
                className="size-7 shrink-0 p-0"
                aria-label={strings.closePanel}
                title={strings.closePanel}
                onClick={onClose}
            >
                <X className="size-3.5" />
            </Button>
        </header>
    );

    if (wide)
        return (
            <aside
                aria-labelledby={titleId}
                className="relative flex max-h-[calc(100dvh-8rem-var(--notice-height))] min-w-0 shrink-0 flex-col self-start overflow-hidden rounded-lg border border-border bg-card lg:sticky lg:top-4"
                style={{ width }}
            >
                <ResizeHandle
                    axis="x"
                    side="end"
                    size={width}
                    min={PANEL_WIDTH.min}
                    max={PANEL_WIDTH.max}
                    label={strings.resizePanel}
                    onChange={(next) => {
                        setWidth(next);
                        writeSize(sizeKey, next);
                    }}
                    onReset={() => {
                        setWidth(PANEL_WIDTH.initial);
                        writeSize(sizeKey, PANEL_WIDTH.initial);
                    }}
                    className="absolute inset-y-0 left-0 z-10"
                />
                {heading}
                <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
            </aside>
        );

    const maxHeight = typeof window === "undefined" ? 600 : Math.round(window.innerHeight * 0.9);
    const sheetHeight = height || Math.round(maxHeight * 0.6);
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent
                showClose={false}
                aria-describedby={undefined}
                className="bottom-0 left-0 top-auto flex max-h-[90dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-b-none p-0"
                style={{ height: sheetHeight }}
            >
                <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
                <ResizeHandle
                    axis="y"
                    side="end"
                    size={sheetHeight}
                    min={SHEET_HEIGHT.min}
                    max={maxHeight}
                    label={strings.resizePanel}
                    onChange={setHeight}
                    onReset={() => setHeight(0)}
                    className="h-3 w-full shrink-0"
                />
                {heading}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
                    {children}
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** The dialog a block's name or its note is written in. An empty one takes the
 *  name or the note away. */
export function BlockTextDialog({
    open,
    title,
    label,
    value,
    maxLength,
    multiline,
    strings,
    onSave,
    onClose
}: {
    open: boolean;
    title: string;
    label: string;
    value: string;
    maxLength: number;
    multiline?: boolean;
    strings: BlockStrings;
    onSave: (value: string | undefined) => void;
    onClose: () => void;
}) {
    const [text, setText] = useState(value);
    const id = useId();
    useEffect(() => {
        if (open) setText(value);
    }, [open, value]);
    const submit = () => {
        const trimmed = text.trim();
        onSave(trimmed ? trimmed : undefined);
        onClose();
    };
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent aria-describedby={undefined}>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        submit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-1">
                        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
                            {label}
                        </label>
                        {multiline ? (
                            <Textarea
                                id={id}
                                value={text}
                                maxLength={maxLength}
                                rows={4}
                                autoFocus
                                onChange={(event) => setText(event.target.value)}
                            />
                        ) : (
                            <Input
                                id={id}
                                value={text}
                                maxLength={maxLength}
                                autoFocus
                                onChange={(event) => setText(event.target.value)}
                            />
                        )}
                        <p className="self-end text-[0.6875rem] tabular-nums text-muted-foreground">
                            {text.length}/{maxLength}
                        </p>
                    </div>
                    <DialogFooter>
                        {multiline && value && (
                            <Button
                                type="button"
                                variant="ghost"
                                className="sm:mr-auto"
                                onClick={() => {
                                    onSave(undefined);
                                    onClose();
                                }}
                            >
                                {strings.removeNote}
                            </Button>
                        )}
                        <Button type="button" variant="outline" onClick={onClose}>
                            {strings.cancel}
                        </Button>
                        <Button type="submit">{strings.save}</Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The words of the leave dialog. */
export interface LeaveStrings {
    readonly title: string;
    readonly body: string;
    readonly newTitle: string;
    readonly newBody: string;
    readonly save: string;
    readonly discard: string;
    /** For a new one: leave without keeping it. */
    readonly discardNew: string;
    readonly stay: string;
}

/**
 * "Save changes?" when somebody leaves an automation with edits not saved yet:
 * save and go, leave without them, or stay. For one never saved, the choice is
 * to save it or to leave it unmade.
 */
export function UnsavedChangesDialog({
    open,
    isNew,
    strings,
    saving,
    onSave,
    onDiscard,
    onStay
}: {
    open: boolean;
    isNew: boolean;
    strings: LeaveStrings;
    saving?: boolean;
    onSave: () => void;
    onDiscard: () => void;
    onStay: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(next) => !next && onStay()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{isNew ? strings.newTitle : strings.title}</DialogTitle>
                    <DialogDescription>{isNew ? strings.newBody : strings.body}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="ghost" className="sm:mr-auto" onClick={onStay}>
                        {strings.stay}
                    </Button>
                    <Button variant="outline" onClick={onDiscard}>
                        {isNew ? strings.discardNew : strings.discard}
                    </Button>
                    <Button disabled={saving} onClick={onSave}>
                        {strings.save}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Holds a link pressed while there are changes not saved, so the editor can ask
 * first: `pending` is where the reader was going, and `go` takes them there.
 * Closing or reloading the tab is asked by the browser itself (`beforeunload`).
 *
 * Only plain presses on links to this site are held - a new tab, a download, a
 * modified press or a link elsewhere goes as it would.
 */
export function useLeaveGuard(dirty: boolean, navigate: (href: string) => void) {
    const [pending, setPending] = useState<string | null>(null);
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const anchor = (event.target as Element | null)?.closest?.("a[href]");
            if (!(anchor instanceof HTMLAnchorElement)) return;
            if (anchor.target && anchor.target !== "_self") return;
            if (anchor.hasAttribute("download")) return;
            const url = new URL(anchor.href, window.location.href);
            if (url.origin !== window.location.origin) return;
            if (url.pathname === window.location.pathname && url.search === window.location.search)
                return;
            event.preventDefault();
            event.stopPropagation();
            setPending(`${url.pathname}${url.search}${url.hash}`);
        };
        document.addEventListener("click", onClick, true);
        return () => document.removeEventListener("click", onClick, true);
    }, []);

    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => event.preventDefault();
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);

    const go = useCallback(() => {
        const href = pending;
        setPending(null);
        if (href) navigate(href);
    }, [pending, navigate]);
    const stay = useCallback(() => setPending(null), []);
    return { pending, go, stay };
}

/** Whether a key press is being typed into something, where the editor's
 *  shortcuts must not take it. */
function typing(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export interface EditorKeys {
    readonly onSave?: () => void;
    readonly onUndo?: () => void;
    readonly onRedo?: () => void;
    readonly onCopy?: () => void;
    readonly onCut?: () => void;
    readonly onPaste?: () => void;
    readonly onRemove?: () => void;
}

/**
 * The editor's keyboard: Ctrl+S (Cmd on a Mac) saves anywhere on the page;
 * Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes, Ctrl+C / Ctrl+X / Ctrl+V copy,
 * cut and paste the selected block, Ctrl+Delete or Ctrl+Backspace removes it -
 * none of them while something is being typed into a field, where they keep
 * their usual meaning, nor while a dialog is open over the editor.
 */
export function useEditorKeys(keys: EditorKeys, active = true): void {
    const ref = useRef(keys);
    ref.current = keys;
    useEffect(() => {
        if (!active) return;
        const onKeyDown = (event: KeyboardEvent) => {
            const mod = applePlatform() ? event.metaKey : event.ctrlKey;
            if (!mod || event.altKey) return;
            const key = event.key.toLowerCase();
            const handlers = ref.current;
            const fire = (handler: (() => void) | undefined) => {
                if (!handler) return;
                event.preventDefault();
                handler();
            };
            if (key === "s") return fire(handlers.onSave);
            if (typing(event.target)) return;
            if (document.querySelector("[role='dialog'][data-state='open']")) return;
            const selection = window.getSelection?.();
            const textSelected =
                selection !== null && selection !== undefined && !selection.isCollapsed;
            if (key === "z" && !event.shiftKey) return fire(handlers.onUndo);
            if ((key === "z" && event.shiftKey) || key === "y") return fire(handlers.onRedo);
            if (textSelected) return;
            if (key === "c") return fire(handlers.onCopy);
            if (key === "x") return fire(handlers.onCut);
            if (key === "v") return fire(handlers.onPaste);
            if (key === "delete" || key === "backspace") return fire(handlers.onRemove);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [active]);
}
