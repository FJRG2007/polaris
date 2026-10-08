"use client";

/**
 * The keyboard, shared by every screen in Polaris.
 *
 * Which key does what is the table in `@polaris/core/shortcuts`; this is the
 * part that listens. A screen names the actions it offers and what each does,
 * and never compares a key itself - so a key somebody moved in the settings is
 * moved on that screen, in its help sheet and in its menu hints at once.
 *
 * The bindings in force are held once per page: the account's, handed in by
 * the dashboard when it draws the frame, with this device's own changes laid
 * over them (`DEVICE_KEY`). A screen drawn outside the frame - a public link -
 * gets the defaults, which is what it always had.
 *
 * Also how a shortcut is drawn - one key cap per key, the way the diagram
 * editor's help draws them - and the help sheet every app opens with `?`.
 */

import { X } from "lucide-react";
import { cn } from "../lib/cn";
import * as core from "@polaris/core";
import { MenuShortcut } from "../components/context-menu";
import { useKeyNames } from "../lib/key-names";
import { applePlatform, formatShortcut } from "../lib/shortcut";
import { Fragment, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// The bindings in force
// ---------------------------------------------------------------------------

/** Where this device keeps the keys it moved for itself. */
export const DEVICE_SHORTCUTS_KEY = "polaris.shortcuts.device";

let account: core.ShortcutOverrides = core.NO_SHORTCUT_OVERRIDES;
let device: core.ShortcutOverrides = core.NO_SHORTCUT_OVERRIDES;
let resolved: ReadonlyMap<string, readonly string[]> = core.resolveShortcuts();
const listeners = new Set<() => void>();

function publish(): void {
    resolved = core.resolveShortcuts(account, device);
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The device's own changes, read defensively and over the account's: a
 *  private window or blocked storage is no changes, never a broken page. */
export function readDeviceShortcuts(): core.ShortcutOverrides {
    try {
        const raw = window.localStorage.getItem(DEVICE_SHORTCUTS_KEY);
        return raw
            ? core.cleanShortcutOverrides(JSON.parse(raw), account)
            : core.NO_SHORTCUT_OVERRIDES;
    } catch {
        return core.NO_SHORTCUT_OVERRIDES;
    }
}

/** Keep this device's changes, and use them at once. False when the browser
 *  refused to store them, so the screen can say so. */
export function writeDeviceShortcuts(next: core.ShortcutOverrides): boolean {
    device = next;
    publish();
    try {
        if (Object.keys(next).length === 0) window.localStorage.removeItem(DEVICE_SHORTCUTS_KEY);
        else window.localStorage.setItem(DEVICE_SHORTCUTS_KEY, JSON.stringify(next));
        return true;
    } catch {
        return false;
    }
}

/** Use the account's changes at once - after a save, before the server answers. */
export function setAccountShortcuts(next: core.ShortcutOverrides): void {
    account = next;
    publish();
}

/** The account's and the device's changes as they stand. */
export function currentShortcutOverrides(): {
    readonly account: core.ShortcutOverrides;
    readonly device: core.ShortcutOverrides;
} {
    return { account, device };
}

/** Every action's keys in force, for code that is not a component. */
export function shortcutBindings(): ReadonlyMap<string, readonly string[]> {
    return resolved;
}

/** Every action's keys in force; redraws when somebody moves one. */
export function useShortcutBindings(): ReadonlyMap<string, readonly string[]> {
    return useSyncExternalStore(subscribe, shortcutBindings, shortcutBindings);
}

/** Whether a press is one action, against the keys in force - for a row or a
 *  field's own `onKeyDown`, where a window listener would be the wrong place. */
export function shortcutPressed(
    event: Parameters<typeof core.bindingOfEvent>[0],
    id: string
): boolean {
    return core.shortcutMatching(resolved, event, [id]) === id;
}

/** Which of `ids` a press is, against the keys in force. */
export function matchShortcut(
    event: Parameters<typeof core.bindingOfEvent>[0],
    ids: readonly string[]
): string | null {
    return core.shortcutMatching(resolved, event, ids);
}

/**
 * Hands the account's changes to every screen. Mounted once, in the frame.
 * The device's changes are read after mount - the server has no idea what one
 * browser kept - and again when another tab changes them.
 */
export function ShortcutsProvider({
    overrides,
    children
}: {
    overrides: core.ShortcutOverrides;
    children: ReactNode;
}) {
    const key = JSON.stringify(overrides);
    // Never during render: this state is the module's, and a server render
    // writing it would hand one person's keys to the next request. Both the
    // server and the first client paint draw the defaults; the account's keys
    // arrive a frame later.
    useEffect(() => {
        account = JSON.parse(key) as core.ShortcutOverrides;
        device = readDeviceShortcuts();
        publish();
        const changed = (event: StorageEvent) => {
            if (event.key !== DEVICE_SHORTCUTS_KEY) return;
            device = readDeviceShortcuts();
            publish();
        };
        window.addEventListener("storage", changed);
        return () => window.removeEventListener("storage", changed);
    }, [key]);
    return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Listening
// ---------------------------------------------------------------------------

/** What an action does. Returning false means "not now" - the press is left to
 *  the browser and to whatever else is listening, as if it matched nothing. */
export type ShortcutHandler = (event: KeyboardEvent) => boolean | void;

export interface ShortcutOptions {
    /** Off while false: nothing is listened for. */
    readonly enabled?: boolean;
    /** Where to listen. The window by default. */
    readonly target?: "window" | "document";
    /** Listen in the capture phase, before the page's own handlers. */
    readonly capture?: boolean;
    /** Asked first: false leaves the press alone. Where a screen says "not while
     *  somebody is typing", "not while a dialog is open". */
    readonly when?: (event: KeyboardEvent) => boolean;
    /** A press already handled by somebody else is left alone. On by default. */
    readonly skipHandled?: boolean;
}

/**
 * Listen for a screen's actions while it is drawn.
 *
 * One listener per call, bound once: the handlers are read from a ref, so a
 * screen can close over fresh state without the listener being swapped on
 * every render. The first action whose keys match and whose handler does not
 * answer false takes the press, and its default is prevented.
 */
export function useShortcuts(
    handlers: Readonly<Record<string, ShortcutHandler | undefined>>,
    options: ShortcutOptions = {}
): void {
    const held = useRef(handlers);
    held.current = handlers;
    const when = useRef(options.when);
    when.current = options.when;
    const { enabled = true, target = "window", capture = false, skipHandled = true } = options;

    useEffect(() => {
        if (!enabled) return;
        const host: Window | Document = target === "document" ? document : window;
        const listener = (event: Event) => {
            const press = event as KeyboardEvent;
            if (skipHandled && press.defaultPrevented) return;
            const pressed = core.bindingOfEvent(press);
            if (!pressed) return;
            if (when.current && !when.current(press)) return;
            for (const [id, handler] of Object.entries(held.current)) {
                if (!handler || !core.keysOf(resolved, id).includes(pressed)) continue;
                if (handler(press) === false) continue;
                press.preventDefault();
                return;
            }
        };
        host.addEventListener("keydown", listener, capture);
        return () => host.removeEventListener("keydown", listener, capture);
    }, [enabled, target, capture, skipHandled]);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const APPLE_MODIFIERS: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" };
const PC_MODIFIERS: Record<string, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift" };

/** The caps of one binding, as this platform prints them. */
export function shortcutCaps(
    binding: string,
    apple: boolean,
    localNames?: Readonly<Record<string, string>>
): string[] {
    const modifiers = apple ? APPLE_MODIFIERS : PC_MODIFIERS;
    return core
        .bindingParts(binding)
        .map((part) => modifiers[part] ?? formatShortcut(part, apple, localNames));
}

/** One binding as plain text, for a menu hint or a title. */
export function shortcutText(
    binding: string,
    apple: boolean,
    localNames?: Readonly<Record<string, string>>
): string {
    return shortcutCaps(binding, apple, localNames).join(apple ? "" : "+");
}

/** Whether this is a machine with a command key, read after mount. */
function useApple(): boolean {
    return useSyncExternalStore(
        () => () => undefined,
        applePlatform,
        () => false
    );
}

/** One key cap, drawn the way the diagram editor's help draws one. */
export function KeyCap({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <kbd
            className={cn(
                "inline-flex min-w-6 items-center justify-center rounded-md bg-primary/15 px-2 py-1.5 font-sans text-[11px] font-medium leading-none text-foreground",
                className
            )}
        >
            {children}
        </kbd>
    );
}

/** A binding, as key caps. */
export function ShortcutKeys({ binding, className }: { binding: string; className?: string }) {
    const apple = useApple();
    const names = useKeyNames();
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
            {shortcutCaps(binding, apple, names).map((cap, at) => (
                <KeyCap key={at}>{cap}</KeyCap>
            ))}
        </span>
    );
}

/** The keys an action answers to now, for a menu's hint: the first one, or
 *  nothing when the action has none. */
export function useShortcutHint(id: string): string {
    const bindings = useShortcutBindings();
    const apple = useApple();
    const names = useKeyNames();
    const first = core.keysOf(bindings, id)[0];
    return first ? shortcutText(first, apple, names) : "";
}

/** A binding as this reader's keyboard prints it, for a title or a message. */
export function useShortcutText(): (binding: string) => string {
    const apple = useApple();
    const names = useKeyNames();
    return (binding) => shortcutText(binding, apple, names);
}

/** A menu item's hint for an action: its first key in force, or nothing. */
export function ShortcutHint({ id, className }: { id: string; className?: string }) {
    const first = core.keysOf(useShortcutBindings(), id)[0];
    return first ? <MenuShortcut keys={first} className={className} /> : null;
}

export interface ShortcutSheetRow {
    readonly id: string;
    readonly label: string;
    /** What it answers to, in the order they are listed. */
    readonly bindings: readonly string[];
    /** Keys it always answers to, drawn after the others and quieter. */
    readonly fixed?: readonly string[];
    /** Said on hover over a fixed key, as in "Always". */
    readonly fixedLabel?: string;
    /** A button drawn inside a key's cap - the settings' "remove this key". */
    readonly onRemove?: (
        binding: string
    ) => { readonly label: string; readonly run: () => void } | null;
    /** Drawn at the end of the row - the settings put their buttons here. */
    readonly end?: ReactNode;
    /** Drawn under the label - a conflict, a "this device" note. */
    readonly note?: ReactNode;
}

export interface ShortcutSheetGroup {
    readonly id: string;
    readonly title: string;
    readonly rows: readonly ShortcutSheetRow[];
}

/**
 * Shortcuts in boxes, a caption over each and one row per action - label on
 * the left, key caps on the right, "or" between alternatives - two columns
 * where there is room. The look of the diagram editor's help, made the one
 * every app's help and the settings screen share.
 */
export function ShortcutSheet({
    groups,
    or = "or",
    none = "None",
    className
}: {
    groups: readonly ShortcutSheetGroup[];
    /** Between two keys that do the same thing. */
    or?: string;
    /** Where an action has no key at all. */
    none?: string;
    className?: string;
}) {
    return (
        <div className={cn("grid gap-x-6 gap-y-6 lg:grid-cols-2", className)}>
            {groups.map((group) => (
                <section key={group.id} aria-label={group.title} className="min-w-0">
                    <h4 className="mb-2.5 text-[13px] font-semibold">{group.title}</h4>
                    <ul className="rounded-lg border border-border">
                        {group.rows.map((row) => (
                            <li
                                key={row.id}
                                data-shortcut={row.id}
                                className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-[13px] last:border-b-0"
                            >
                                <span className="min-w-0 flex-1 basis-40">
                                    <span className="block [overflow-wrap:anywhere]">
                                        {row.label}
                                    </span>
                                    {row.note}
                                </span>
                                <span className="flex flex-wrap items-center justify-end gap-1">
                                    {row.bindings.length === 0 && !row.fixed?.length ? (
                                        <span className="text-xs text-foreground-subtle">
                                            {none}
                                        </span>
                                    ) : (
                                        [
                                            ...row.bindings.map((binding) => ({
                                                binding,
                                                fixed: false
                                            })),
                                            ...(row.fixed ?? []).map((binding) => ({
                                                binding,
                                                fixed: true
                                            }))
                                        ].map(({ binding, fixed }, at) => {
                                            const remove = fixed
                                                ? null
                                                : (row.onRemove?.(binding) ?? null);
                                            return (
                                                <Fragment
                                                    key={`${fixed ? "fixed" : "own"}:${binding}`}
                                                >
                                                    {at > 0 ? (
                                                        <span className="px-0.5 text-xs text-muted-foreground">
                                                            {or}
                                                        </span>
                                                    ) : null}
                                                    <span
                                                        className={cn(
                                                            "inline-flex items-center gap-0.5",
                                                            fixed && "opacity-60"
                                                        )}
                                                        title={fixed ? row.fixedLabel : undefined}
                                                    >
                                                        <ShortcutKeys binding={binding} />
                                                        {remove ? (
                                                            <button
                                                                type="button"
                                                                aria-label={remove.label}
                                                                title={remove.label}
                                                                onClick={remove.run}
                                                                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                                                            >
                                                                <X
                                                                    className="size-3"
                                                                    aria-hidden="true"
                                                                />
                                                            </button>
                                                        ) : null}
                                                    </span>
                                                </Fragment>
                                            );
                                        })
                                    )}
                                    {row.end}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}
