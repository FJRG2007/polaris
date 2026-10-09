"use client";

/**
 * The column of slides beside the canvas - a strip under it on a phone.
 *
 * What every deck editor's slide list does, and nothing it does not: pick a
 * slide, drag it to a new place (an insertion line shows where it lands), and a
 * menu on each one - right-click, or the button on it for a finger - to add,
 * duplicate, move or delete. The keys are Google Slides' and PowerPoint's: the
 * arrows walk the list, Ctrl+Up/Down moves the slide, Delete removes it, and
 * every one of them is a step undo takes back, so nothing here asks first.
 */

import * as deck from "@/lib/office/deck";
import { SlideDrawing } from "./slide-canvas";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDown, ArrowUp, Copy, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import {
    useEffect,
    useRef,
    useState,
    type ComponentType,
    type KeyboardEvent,
    type PointerEvent,
    type ReactNode
} from "react";
import {
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    matchShortcut,
    ShortcutHint
} from "@polaris/ui";

const LIST_KEYS = [
    "office.slideList.previous",
    "office.slideList.next",
    "office.slideList.first",
    "office.slideList.last",
    "office.slideList.moveUp",
    "office.slideList.moveDown",
    "office.slideList.duplicate",
    "office.slideList.delete"
] as const;

/** How far a press may wander before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** How close to the list's edge a drag has to come before the list scrolls. */
const SCROLL_EDGE_PX = 32;

export interface SlideListActions {
    onGo: (index: number) => void;
    onAdd: (after: number) => void;
    onDuplicate: (index: number) => void;
    onDelete: (index: number) => void;
    onMove: (from: number, to: number) => void;
}

export function SlideList({
    slides,
    bySlide,
    at,
    editable,
    actions
}: {
    slides: readonly deck.Slide[];
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    at: number;
    editable: boolean;
    actions: SlideListActions;
}) {
    const t = useTranslations("office");
    const list = useRef<HTMLDivElement | null>(null);
    const thumbs = useRef<(HTMLButtonElement | null)[]>([]);
    /** Where a dragged slide would land: before the slide at this position. */
    const [dropAt, setDropAt] = useState<number | null>(null);
    const dragged = useRef(false);
    const keyboard = useRef(false);

    // The chosen slide stays in view, and keeps the focus when the keys moved it.
    useEffect(() => {
        const one = thumbs.current[at];
        one?.scrollIntoView({ block: "nearest", inline: "nearest" });
        if (keyboard.current) {
            keyboard.current = false;
            one?.focus();
        }
    }, [at, slides.length]);

    const beginDrag = (event: PointerEvent, from: number): void => {
        if (!editable || event.button !== 0 || event.pointerType === "touch") return;
        const fromX = event.clientX;
        const fromY = event.clientY;
        let moving = false;
        let landing: number | null = null;
        const across = (): boolean => window.matchMedia("(max-width: 639px)").matches;
        const move = (at: globalThis.PointerEvent): void => {
            if (!moving && Math.hypot(at.clientX - fromX, at.clientY - fromY) < DRAG_THRESHOLD_PX)
                return;
            moving = true;
            const horizontal = across();
            const pointer = horizontal ? at.clientX : at.clientY;
            let position = thumbs.current.length;
            for (const [index, one] of thumbs.current.entries()) {
                if (!one) continue;
                const box = one.getBoundingClientRect();
                const middle = horizontal ? box.left + box.width / 2 : box.top + box.height / 2;
                if (pointer < middle) {
                    position = index;
                    break;
                }
            }
            landing = position;
            setDropAt(position);
            // Near an edge, the list scrolls, so a slide can be carried past
            // what fits on screen.
            const host = list.current;
            if (host) {
                const box = host.getBoundingClientRect();
                const start = horizontal ? box.left : box.top;
                const end = horizontal ? box.right : box.bottom;
                const step =
                    pointer < start + SCROLL_EDGE_PX
                        ? -12
                        : pointer > end - SCROLL_EDGE_PX
                          ? 12
                          : 0;
                if (step) host.scrollBy(horizontal ? { left: step } : { top: step });
            }
        };
        const finish = (commit: boolean): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            setDropAt(null);
            if (!moving) return;
            // The click that ends a drag is not a click on the slide.
            dragged.current = true;
            if (!commit || landing === null) return;
            const to = landing > from ? landing - 1 : landing;
            if (to !== from) actions.onMove(from, to);
        };
        const up = (): void => finish(true);
        const cancel = (): void => finish(false);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
    };

    const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
        // A key pressed in a menu opened from this slide reaches it through the
        // portal; it is the menu's.
        if (!event.currentTarget.contains(event.target as Node)) return;
        const action = matchShortcut(event, LIST_KEYS);
        if (!action) return;
        const last = slides.length - 1;
        const go = (to: number): void => {
            keyboard.current = true;
            actions.onGo(Math.max(0, Math.min(last, to)));
        };
        switch (action) {
            case "office.slideList.previous":
                go(index - 1);
                break;
            case "office.slideList.next":
                go(index + 1);
                break;
            case "office.slideList.first":
                go(0);
                break;
            case "office.slideList.last":
                go(last);
                break;
            default:
                if (!editable) return;
                keyboard.current = true;
                if (action === "office.slideList.moveUp" && index > 0)
                    actions.onMove(index, index - 1);
                else if (action === "office.slideList.moveDown" && index < last)
                    actions.onMove(index, index + 1);
                else if (action === "office.slideList.duplicate") actions.onDuplicate(index);
                else if (action === "office.slideList.delete") actions.onDelete(index);
                else keyboard.current = false;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    const line = (
        <div
            className="pointer-events-none shrink-0 self-stretch rounded-full bg-primary max-sm:w-0.5 sm:h-0.5"
            aria-hidden
        />
    );

    return (
        <div
            ref={list}
            role="listbox"
            aria-label={t("slides.slideList")}
            className="flex shrink-0 gap-2 overscroll-contain p-2 max-sm:order-last max-sm:h-24 max-sm:overflow-x-auto max-sm:border-t max-sm:border-border sm:w-44 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-border"
        >
            {slides.map((one, index) => {
                const thumb = (
                    <button
                        ref={(node) => {
                            thumbs.current[index] = node;
                        }}
                        type="button"
                        role="option"
                        aria-selected={index === at}
                        aria-label={t("slides.slideNumber", { number: index + 1 })}
                        tabIndex={index === at ? 0 : -1}
                        onPointerDown={(event) => beginDrag(event, index)}
                        onClick={() => {
                            if (dragged.current) {
                                dragged.current = false;
                                return;
                            }
                            actions.onGo(index);
                        }}
                        onKeyDown={(event) => onKey(event, index)}
                        className={cn(
                            "relative aspect-video shrink-0 overflow-hidden rounded-md border bg-background text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring max-sm:h-full sm:w-full",
                            index === at
                                ? "border-primary ring-1 ring-primary"
                                : "border-border hover:border-border-strong"
                        )}
                    >
                        <SlideDrawing boxes={bySlide.get(one.id) ?? []} />
                        <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
                            {index + 1}
                        </span>
                    </button>
                );
                return (
                    <div key={one.id} className="contents">
                        {dropAt === index ? line : null}
                        {editable ? (
                            <div className="group relative shrink-0 max-sm:h-full">
                                <ContextMenu>
                                    <ContextMenuTrigger asChild>{thumb}</ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <SlideMenuItems
                                            Item={ContextMenuItem}
                                            Separator={ContextMenuSeparator}
                                            index={index}
                                            count={slides.length}
                                            actions={actions}
                                        />
                                    </ContextMenuContent>
                                </ContextMenu>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="secondary"
                                            size="icon"
                                            aria-label={t("slides.slideMenu")}
                                            title={t("slides.slideMenu")}
                                            className={cn(
                                                "absolute right-1 top-1 size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
                                                index === at && "opacity-100"
                                            )}
                                        >
                                            <MoreHorizontal
                                                className="size-3.5 shrink-0"
                                                aria-hidden
                                            />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start">
                                        <SlideMenuItems
                                            Item={DropdownMenuItem}
                                            Separator={DropdownMenuSeparator}
                                            index={index}
                                            count={slides.length}
                                            actions={actions}
                                        />
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        ) : (
                            thumb
                        )}
                    </div>
                );
            })}
            {dropAt === slides.length ? line : null}
            {editable ? (
                <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0 max-sm:h-full max-sm:aspect-video"
                    onClick={() => actions.onAdd(slides.length - 1)}
                    aria-label={t("slides.newSlide")}
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    <span className="max-sm:hidden">{t("slides.slide")}</span>
                </Button>
            ) : null}
        </div>
    );
}

type ItemProps = {
    onSelect?: () => void;
    disabled?: boolean;
    variant?: "default" | "danger";
    children?: ReactNode;
};

/** One slide's options, drawn by whichever menu opened them - the right-click
 *  one or the button's - so the two can never offer different things. */
function SlideMenuItems({
    Item,
    Separator,
    index,
    count,
    actions
}: {
    Item: ComponentType<ItemProps>;
    Separator: ComponentType<{ className?: string }>;
    index: number;
    count: number;
    actions: SlideListActions;
}) {
    const t = useTranslations("office");
    return (
        <>
            <Item onSelect={() => actions.onAdd(index)}>
                <Plus className="size-4 shrink-0" aria-hidden />
                {t("slides.newSlide")}
                <ShortcutHint id="office.slides.newSlide" />
            </Item>
            <Item onSelect={() => actions.onDuplicate(index)}>
                <Copy className="size-4 shrink-0" aria-hidden />
                {t("slides.duplicateSlide")}
                <ShortcutHint id="office.slideList.duplicate" />
            </Item>
            <Item disabled={index === 0} onSelect={() => actions.onMove(index, index - 1)}>
                <ArrowUp className="size-4 shrink-0" aria-hidden />
                {t("slides.moveUp")}
                <ShortcutHint id="office.slideList.moveUp" />
            </Item>
            <Item disabled={index >= count - 1} onSelect={() => actions.onMove(index, index + 1)}>
                <ArrowDown className="size-4 shrink-0" aria-hidden />
                {t("slides.moveDown")}
                <ShortcutHint id="office.slideList.moveDown" />
            </Item>
            <Separator />
            <Item variant="danger" onSelect={() => actions.onDelete(index)}>
                <Trash2 className="size-4 shrink-0" aria-hidden />
                {t("slides.deleteSlide")}
                <ShortcutHint id="office.slideList.delete" />
            </Item>
        </>
    );
}
