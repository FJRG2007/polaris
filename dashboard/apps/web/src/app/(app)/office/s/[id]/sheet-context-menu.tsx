"use client";

/**
 * The spreadsheet's right-click menu, drawn by Polaris.
 *
 * The engine still decides what the menu holds - which items there are at a
 * cell, a header or a sheet tab, and which of them the selection and the
 * sheet's permissions hide or disable - and still runs whatever is chosen. What
 * changed is who draws it. The engine's own menu opened a submenu the instant
 * the pointer touched its row and closed it half a second after the pointer
 * left, so running a hand down the list stacked two submenus on top of each
 * other and each one appeared a frame after it was positioned; it also drew
 * icons and words of its own. This one is the dashboard's context menu - the
 * same hover, the same submenus, the same icons and both languages - fed from
 * the engine's menu tree through the engine's own context-menu service (see
 * `routeContextMenu` in the editor).
 *
 * The data side (title keys, icons, colours) is `lib/office/sheet-menu`.
 */

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuGroup,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    MenuShortcut,
    cn
} from "@polaris/ui";
import { Check } from "lucide-react";
import * as menu from "@/lib/office/sheet-menu";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    createContext,
    useContext,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type ReactNode
} from "react";

/** What the menu needs from the engine, and nothing else. */
export interface SheetMenuEngine {
    /** Become the engine's right-click menu until the returned function runs. */
    attach: (handler: SheetMenuHandler) => () => void;
    /** The items at one of the engine's menu positions. */
    menu: (position: string) => menu.MenuNode[];
    /** Run a command, exactly as the engine's own menu would have. */
    run: (commandId: string, params: unknown) => void;
    /** Hand the keyboard back to the grid. */
    focusGrid: () => void;
    /** The engine's own words, for an item Polaris has no words for yet. */
    engineWords: (key: string, ...args: string[]) => string;
    /** The active cell, zero-based, for the freeze items' labels. */
    activeCell: () => { row: number; column: number } | null;
    /** Draw a label component of the engine's own that this menu does not
     *  draw itself - an item a plugin added. */
    foreignLabel: (
        label: menu.LabelComponent,
        value: unknown,
        onChange: (value: unknown) => void
    ) => ReactNode;
}

/** How the engine opens and closes this menu. */
export interface SheetMenuHandler {
    open: (at: { x: number; y: number }, position: string, extra?: Record<string, unknown>) => void;
    close: () => void;
    isOpen: () => boolean;
}

interface Session {
    id: number;
    position: string;
    x: number;
    y: number;
    /** Merged into every command's parameters - a sheet tab's id. */
    extra: Record<string, unknown>;
    /**
     * A screen too narrow for a submenu beside the menu: neither side has room,
     * so a submenu would be squeezed to a sliver. Its options are listed in the
     * menu itself instead, under the submenu's name.
     */
    narrow: boolean;
}

/** The menu's own width, which a narrow screen has to find room for. */
const MENU_WIDTH = 224;
/** Space kept between the menu and the edge of the screen. */
const SCREEN_GUTTER = 8;
/** Below this width a submenu has no room on either side of the menu. */
const NARROW_SCREEN = "(max-width: 639px)";

interface MenuContextValue {
    engine: SheetMenuEngine;
    session: Session;
    choose: (commandId: string, params: unknown, value: unknown) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

/** Whether the submenu an item is listed under on a narrow screen is disabled. */
const InheritedDisabled = createContext(false);

function useMenu(): MenuContextValue {
    const value = useContext(MenuContext);
    if (!value) throw new Error("outside the sheet menu");
    return value;
}

export function SheetContextMenu({ engine }: { engine: SheetMenuEngine }) {
    const [session, setSession] = useState<Session | null>(null);
    const [open, setOpen] = useState(false);
    const openRef = useRef(false);
    openRef.current = open;
    const trigger = useRef<HTMLSpanElement | null>(null);
    const latest = useRef(0);
    latest.current = session?.id ?? 0;

    useEffect(
        () =>
            engine.attach({
                // A fresh menu every time, keyed by the session: a right-click
                // somewhere else while one is open is a new menu at the new
                // point, not the old one moved.
                open: (at, position, extra = {}) => {
                    setOpen(false);
                    setSession((last) => ({
                        id: (last?.id ?? 0) + 1,
                        position,
                        x: at.x,
                        y: at.y,
                        extra,
                        narrow: window.matchMedia?.(NARROW_SCREEN).matches ?? false
                    }));
                },
                // The menu opens and closes itself on its trigger's gestures and
                // has no switch of its own, so the engine closes it by taking
                // it away.
                close: () => {
                    setOpen(false);
                    setSession(null);
                },
                isOpen: () => openRef.current
            }),
        [engine]
    );

    // The menu opens where a right-click would have opened it: the dashboard's
    // context menu is anchored to the point of a contextmenu event on its
    // trigger, so that is what it is given, at the point the engine reported.
    //
    // A passive effect on purpose: the menu this one replaces stops listening
    // for right-clicks elsewhere in its own passive cleanup, which runs before
    // this and after any layout effect - dispatched any earlier, the old menu
    // would take this event for a right-click outside itself and cancel it.
    useEffect(() => {
        if (!session || !trigger.current) return;
        trigger.current.dispatchEvent(
            new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                // Moved in from the right edge when the menu would not fit
                // beside the pointer: it opens on the pointer's right and has
                // nowhere to go on a phone held upright. There it starts at the
                // left edge, so the whole width of the screen is the menu's.
                clientX: session.narrow
                    ? SCREEN_GUTTER
                    : Math.max(
                          SCREEN_GUTTER,
                          Math.min(session.x, window.innerWidth - MENU_WIDTH - SCREEN_GUTTER)
                      ),
                clientY: session.y,
                button: 2
            })
        );
    }, [session]);

    if (!session) return null;

    const choose = (commandId: string, params: unknown, value: unknown): void => {
        // The engine's own menu sends `{ value }` when an item has no parameters
        // of its own; on a sheet tab it always names the tab as well.
        const sent =
            session.position === menu.MENU_AT.sheetTab
                ? { value, ...session.extra }
                : (params ?? { value });
        setOpen(false);
        engine.run(commandId, sent);
        engine.focusGrid();
    };

    return (
        <ContextMenu key={session.id} modal={false} onOpenChange={setOpen}>
            <ContextMenuTrigger asChild>
                <span
                    ref={trigger}
                    aria-hidden
                    className="pointer-events-none fixed left-0 top-0 size-0"
                />
            </ContextMenuTrigger>
            <MenuContext.Provider value={{ engine, session, choose }}>
                <ContextMenuContent
                    data-sheet-menu
                    className="min-w-[min(14rem,calc(100vw-1rem))]"
                    // The grid keeps the keyboard when the menu closes, as it
                    // does after the engine's own menu - unless a right-click
                    // elsewhere closed it, when the menu that replaced it has
                    // the keyboard and would close if it lost it.
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        if (latest.current === session.id) engine.focusGrid();
                    }}
                >
                    <Groups nodes={engine.menu(session.position)} />
                </ContextMenuContent>
            </MenuContext.Provider>
        </ContextMenu>
    );
}

/** A list of groups and items, with a rule between groups that have anything
 *  left to show. */
function Groups({ nodes }: { nodes: readonly menu.MenuNode[] }) {
    return (
        <>
            {nodes
                .filter(menu.renderable)
                .map((node) =>
                    node.item ? (
                        <Item key={node.key} node={node} />
                    ) : (
                        <Group key={node.key} node={node} />
                    )
                )}
        </>
    );
}

function Group({ node }: { node: menu.MenuNode }) {
    const t = useTranslations("office");
    const { engine } = useMenu();
    const children = (node.children ?? []).filter((child) => child.item);
    const allHidden = useAll(children.map((child) => child.item?.hidden$));
    if (allHidden) return null;
    return (
        // The rule sits on top of every group but the first one drawn, so a
        // group with nothing left to show never leaves two rules together.
        <ContextMenuGroup className="[&:first-of-type>[data-group-rule]]:hidden">
            <div data-group-rule>
                <ContextMenuSeparator />
            </div>
            {node.title ? (
                <ContextMenuLabel>{words(t, engine, node.title)}</ContextMenuLabel>
            ) : null}
            {children.map((child) => (
                <Item key={child.key} node={child} />
            ))}
        </ContextMenuGroup>
    );
}

function Item({ node }: { node: menu.MenuNode }) {
    const item = node.item!;
    const { engine, session } = useMenu();
    const hidden = useWatch(item.hidden$, false);
    const inherited = useContext(InheritedDisabled);
    const disabled = useWatch(item.disabled$, false) || inherited;
    const value = useWatch(item.value$, undefined as unknown);
    const watched = useWatch(
        Array.isArray(item.selections) ? undefined : item.selections,
        undefined as menu.MenuOption[] | undefined
    );
    if (hidden) return null;

    const options = menu.staticSelections(item) ?? watched ?? [];
    const children =
        item.type === menu.MENU_ITEM.subitems ? engine.menu(item.id).filter(menu.renderable) : [];

    if (children.length > 0 && session.narrow) {
        return (
            <ContextMenuGroup>
                <ContextMenuLabel
                    className={cn("flex items-center gap-2", disabled && "opacity-50")}
                >
                    <ItemFace item={item} value={value} />
                </ContextMenuLabel>
                <div className="pl-3">
                    <InheritedDisabled.Provider value={disabled}>
                        <Groups nodes={children} />
                    </InheritedDisabled.Provider>
                </div>
            </ContextMenuGroup>
        );
    }
    if (children.length > 0) {
        return (
            <ContextMenuSub>
                <ContextMenuSubTrigger disabled={disabled}>
                    <ItemFace item={item} value={value} />
                </ContextMenuSubTrigger>
                <ContextMenuSubContent className="min-w-52">
                    <Groups nodes={children} />
                </ContextMenuSubContent>
            </ContextMenuSub>
        );
    }
    if (options.length > 0)
        return <Choices item={item} options={options} value={value} disabled={disabled} />;
    if (item.type === menu.MENU_ITEM.subitems) return null;
    if (typeof item.label === "object" && menu.INPUT_LABEL.test(item.label.name)) {
        return <CountItem item={item} value={value} disabled={disabled} />;
    }
    return <Action item={item} value={value} disabled={disabled} />;
}

/** An item that does one thing. */
function Action({
    item,
    value,
    disabled
}: {
    item: menu.MenuItem;
    value: unknown;
    disabled: boolean;
}) {
    const { choose } = useMenu();
    const shortcut = item.title ? menu.MENU_SHORTCUTS[item.title] : undefined;
    return (
        <ContextMenuItem
            disabled={disabled}
            variant={menu.isDestructive(item.title) ? "danger" : "default"}
            onSelect={() => choose(item.commandId ?? item.id, item.params, value)}
        >
            <ItemFace item={item} value={value} />
            {shortcut ? <MenuShortcut keys={shortcut} /> : null}
        </ContextMenuItem>
    );
}

/** An item with a submenu of choices - the colour of a tab, a hidden sheet to
 *  show again. */
function Choices({
    item,
    options,
    value,
    disabled
}: {
    item: menu.MenuItem;
    options: readonly menu.MenuOption[];
    value: unknown;
    disabled: boolean;
}) {
    const t = useTranslations("office");
    const { engine, session, choose } = useMenu();
    const colour = options.some(
        (option) => typeof option.label === "object" && menu.COLOR_LABEL.test(option.label.name)
    );
    const body = colour ? (
        <>
            <div className="grid grid-cols-5 gap-1 p-1">
                {menu.TAB_COLORS.map((swatch) => (
                    <ContextMenuItem
                        key={swatch.hex}
                        aria-label={t(`sheetMenu.colors.${swatch.word}`)}
                        title={t(`sheetMenu.colors.${swatch.word}`)}
                        className="size-7 justify-center p-0"
                        disabled={disabled}
                        onSelect={() =>
                            choose(item.selectionsCommandId ?? item.id, undefined, swatch.hex)
                        }
                    >
                        <span
                            aria-hidden
                            className="size-5 rounded border border-border-strong"
                            style={{ background: swatch.hex }}
                        />
                    </ContextMenuItem>
                ))}
            </div>
            <ContextMenuSeparator />
            <ContextMenuItem
                disabled={disabled}
                onSelect={() => choose(item.selectionsCommandId ?? item.id, undefined, "")}
            >
                <span
                    aria-hidden
                    className="size-4 rounded border border-dashed border-border-strong"
                />
                {t("sheetMenu.noColor")}
            </ContextMenuItem>
        </>
    ) : (
        options.map((option, index) => {
            const label =
                typeof option.label === "string"
                    ? words(t, engine, option.label)
                    : option.label
                      ? engine.foreignLabel(option.label, option.value, (next) =>
                            choose(menu.optionCommand(item, option), undefined, next)
                        )
                      : String(option.value ?? "");
            const chosen = value !== undefined && String(value) === String(option.value);
            return (
                <ContextMenuItem
                    key={`${String(option.value)}-${index}`}
                    disabled={disabled || option.disabled}
                    onSelect={() =>
                        choose(menu.optionCommand(item, option), undefined, option.value)
                    }
                >
                    <Check
                        className={cn("size-4", chosen ? "opacity-100" : "opacity-0")}
                        aria-hidden
                    />
                    <span
                        className="min-w-0 truncate"
                        title={typeof label === "string" ? label : undefined}
                    >
                        {label}
                    </span>
                </ContextMenuItem>
            );
        })
    );
    if (session.narrow) {
        return (
            <ContextMenuGroup>
                <ContextMenuLabel
                    className={cn("flex items-center gap-2", disabled && "opacity-50")}
                >
                    <ItemFace item={item} value={value} />
                </ContextMenuLabel>
                <div className="pl-3">{body}</div>
            </ContextMenuGroup>
        );
    }
    return (
        <ContextMenuSub>
            <ContextMenuSubTrigger disabled={disabled}>
                <ItemFace item={item} value={value} />
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className={colour ? "min-w-0" : "min-w-44"}>
                {body}
            </ContextMenuSubContent>
        </ContextMenuSub>
    );
}

/**
 * An item with a number in it: "Insert [3] rows above", "Column width [120]".
 *
 * The number is a field inside the option, so it must not behave like the
 * option: pressing it does not choose the item, typing in it does not jump the
 * menu to an item starting with that letter, and moving the pointer over the
 * row does not take the caret out of it. Enter in the field, or choosing the
 * words beside it, runs the command with the number in the field.
 */
function CountItem({
    item,
    value,
    disabled
}: {
    item: menu.MenuItem;
    value: unknown;
    disabled: boolean;
}) {
    const t = useTranslations("office");
    const { engine, choose } = useMenu();
    const props = (typeof item.label === "object" ? item.label.props : undefined) ?? {};
    const min = typeof props.min === "number" ? props.min : 1;
    const max = typeof props.max === "number" ? props.max : 1000;
    const prefixKey = typeof props.prefix === "string" ? props.prefix : "";
    const suffixKey = typeof props.suffix === "string" ? props.suffix : "";
    const words$ = menu.COUNT_WORDS[prefixKey];
    const prefix = words$ ? t(`sheetMenu.count.${words$}.before`) : engine.engineWords(prefixKey);
    const suffix = words$
        ? t(`sheetMenu.count.${words$}.after`)
        : suffixKey
          ? engine.engineWords(suffixKey)
          : "";

    const initial = clamp(Number(value ?? min), min, max);
    const [count, setCount] = useState(String(initial));
    const field = useRef<HTMLInputElement | null>(null);
    useEffect(() => setCount(String(clamp(Number(value ?? min), min, max))), [value, min, max]);

    const run = (): void =>
        choose(item.commandId ?? item.id, item.params, clamp(Number(count), min, max));
    const Icon = menu.menuIcon(item);
    const stop = (event: { stopPropagation: () => void }): void => event.stopPropagation();

    return (
        <ContextMenuItem
            disabled={disabled}
            onSelect={run}
            onPointerMove={(event) => {
                // A row that takes focus on hover would take it off the field.
                if (document.activeElement === field.current) event.preventDefault();
            }}
        >
            {Icon ? (
                <Icon className="size-4" aria-hidden />
            ) : (
                <span aria-hidden className="size-4" />
            )}
            <span className="whitespace-nowrap">{prefix}</span>
            <input
                ref={field}
                type="number"
                inputMode="numeric"
                min={min}
                max={max}
                value={count}
                aria-label={`${prefix} ${suffix}`.trim()}
                disabled={disabled}
                onChange={(event) => setCount(event.target.value.replace(/[^\d]/g, ""))}
                onBlur={() => setCount(String(clamp(Number(count), min, max)))}
                onPointerDown={stop}
                onPointerUp={stop}
                onClick={stop}
                onKeyDown={(event) => {
                    if (event.key === "Escape") return;
                    event.stopPropagation();
                    if (event.key === "Enter") {
                        event.preventDefault();
                        run();
                    }
                }}
                className="h-6 w-14 rounded border border-border bg-field px-1.5 text-center text-[0.8125rem] tabular-nums text-foreground hover:border-border-strong [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            {suffix ? <span className="whitespace-nowrap">{suffix}</span> : null}
        </ContextMenuItem>
    );
}

/** The icon and the words of an item. */
function ItemFace({ item, value }: { item: menu.MenuItem; value: unknown }) {
    const t = useTranslations("office");
    const { engine, choose } = useMenu();
    const Icon = menu.menuIcon(item);
    let label: ReactNode;
    if (typeof item.label === "object" && menu.FROZEN_LABEL.test(item.label.name)) {
        const at = menu.freezePoint(engine.activeCell());
        const kind = item.label.props?.type;
        label =
            kind === "row"
                ? t("sheetMenu.freezeToRow", { row: at.row })
                : kind === "col"
                  ? t("sheetMenu.freezeToColumn", { column: at.column })
                  : t("sheetMenu.freezeToCell", { cell: `${at.column}${at.row}` });
    } else if (typeof item.label === "object") {
        label = engine.foreignLabel(item.label, value, (next) =>
            choose(item.commandId ?? item.id, item.params, next)
        );
    } else {
        label = words(
            t,
            engine,
            item.title ?? (typeof item.label === "string" ? item.label : item.id)
        );
    }
    return (
        <>
            {/* Every row keeps the icon's column, so the words line up whether
                or not a row has one. */}
            {Icon ? (
                <Icon className="size-4" aria-hidden />
            ) : (
                <span aria-hidden className="size-4 shrink-0" />
            )}
            <span
                className="min-w-0 truncate"
                title={typeof label === "string" ? label : undefined}
            >
                {label}
            </span>
        </>
    );
}

/** Polaris' words for an engine key, or the engine's own when there are none. */
function words(
    t: ReturnType<typeof useTranslations>,
    engine: SheetMenuEngine,
    key: string
): string {
    const ours = menu.MENU_WORDS[key];
    return ours ? t(`sheetMenu.items.${ours}`) : engine.engineWords(key);
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * The current value of one of the engine's streams.
 *
 * Read synchronously the first time - its streams hand over their current value
 * on subscription - and kept in step before paint after that, so a menu never
 * draws an item for one frame that the next frame hides. That frame is exactly
 * the jump this menu replaces.
 */
function useWatch<T>(source: menu.Watchable<T> | undefined, fallback: T): T {
    const [value, setValue] = useState<T>(() => readNow(source, fallback));
    useLayoutEffect(() => {
        if (!source) return;
        const subscription = source.subscribe((next) => setValue(next));
        return () => subscription.unsubscribe();
    }, [source]);
    return value;
}

/** Whether every one of several boolean streams is true right now. */
function useAll(sources: readonly (menu.Watchable<boolean> | undefined)[]): boolean {
    const [values, setValues] = useState<boolean[]>(() =>
        sources.map((one) => readNow(one, false))
    );
    // The group's items do not change while one menu is open, so the streams
    // are subscribed once per count of them rather than once per render.
    const current = useRef(sources);
    current.current = sources;
    const key = sources.length;
    useLayoutEffect(() => {
        const subscriptions = current.current.map((source, index) =>
            source?.subscribe((next) =>
                setValues((last) => {
                    if (last[index] === next) return last;
                    const copy = [...last];
                    copy[index] = next;
                    return copy;
                })
            )
        );
        return () => subscriptions.forEach((one) => one?.unsubscribe());
    }, [key]);
    return values.length > 0 && values.every(Boolean);
}

function readNow<T>(source: menu.Watchable<T> | undefined, fallback: T): T {
    if (!source) return fallback;
    let value = fallback;
    source.subscribe((next) => (value = next)).unsubscribe();
    return value;
}
