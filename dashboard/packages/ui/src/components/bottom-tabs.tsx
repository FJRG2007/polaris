"use client";

/**
 * The tab bar along the bottom of a phone screen, the way WhatsApp, Telegram
 * and every phone app since switch between the few places an app has.
 *
 * Phones only (`md:hidden`): on anything wider the same places are a rail or a
 * column, which has the room. At the bottom because that is where a thumb
 * already is; each tab is the full height of a finger, an icon over a short
 * name, the open one marked by the circle behind its icon. It clears the home
 * indicator on phones that draw one (`--safe-bottom`).
 *
 * A finger can slide along it, as on iOS: put it down on any tab, move it
 * sideways, and the tab under it lights up (with a tick where the phone has
 * one); lifting it opens that tab. Dragged well above the bar, the slide is
 * called off and nothing opens. A plain tap, a mouse and a keyboard work as
 * they always did, through the button's own click.
 *
 * An app passes its own tabs, so a third-party app gets the same bar as
 * Polaris's own.
 */

import { cn } from "../lib/cn";
import { useRef, useState, type PointerEvent, type ReactNode } from "react";

export interface BottomTab {
    readonly id: string;
    readonly label: string;
    readonly icon: ReactNode;
    readonly active: boolean;
    /** Something waiting there, counted. Zero or absent draws nothing. */
    readonly badge?: number;
    readonly onSelect: () => void;
}

/** How far above the bar a sliding finger may go before the slide is off. */
const CANCEL_ABOVE_PX = 64;
/** How far a finger has to move before a press counts as a slide, not a tap. */
const SLIDE_PX = 8;

/** A short tick, where the device has one. Silently nothing elsewhere - iOS
 *  Safari has no vibration at all. */
function tick(): void {
    try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(8);
    } catch {
        // A browser that refuses just stays quiet.
    }
}

export function BottomTabs({
    tabs,
    label,
    className
}: {
    tabs: readonly BottomTab[];
    /** What the bar is, for a screen reader: "Chat sections". */
    label: string;
    className?: string;
}) {
    const bar = useRef<HTMLElement>(null);
    /** The slide in progress: which pointer, where it started, whether it has
     *  moved far enough to be one. */
    const slide = useRef<{ pointer: number; x: number; moved: boolean } | null>(null);
    /** When a slide last opened a tab, so the click the browser may still send
     *  for that same lift is not taken as a second press. */
    const slidAt = useRef(0);
    /** The tab under a sliding finger, lit while it is there. */
    const [under, setUnder] = useState<number | null>(null);

    /** The tab under a point, or null when the point is off the bar. */
    function tabAt(x: number, y: number): number | null {
        const nav = bar.current;
        if (!nav) return null;
        const box = nav.getBoundingClientRect();
        if (y < box.top - CANCEL_ABOVE_PX || y > box.bottom + CANCEL_ABOVE_PX) return null;
        const buttons = Array.from(nav.querySelectorAll<HTMLElement>(":scope > button"));
        for (let index = 0; index < buttons.length; index++) {
            const rect = buttons[index]!.getBoundingClientRect();
            if (x >= rect.left && x < rect.right) return index;
        }
        // Past either end, the end tab: a thumb overshooting the last one still means it.
        if (buttons.length === 0) return null;
        return x < buttons[0]!.getBoundingClientRect().left ? 0 : buttons.length - 1;
    }

    function down(event: PointerEvent<HTMLElement>): void {
        // A mouse clicks; only a finger or a pen slides.
        if (event.pointerType === "mouse" || !event.isPrimary) return;
        slide.current = { pointer: event.pointerId, x: event.clientX, moved: false };
        setUnder(tabAt(event.clientX, event.clientY));
    }

    function move(event: PointerEvent<HTMLElement>): void {
        const current = slide.current;
        if (!current || current.pointer !== event.pointerId) return;
        if (!current.moved && Math.abs(event.clientX - current.x) < SLIDE_PX) return;
        if (!current.moved) {
            current.moved = true;
            // From here the bar follows the finger wherever it goes, even off a tab.
            try {
                event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
                // A pointer that already ended has nothing to capture.
            }
        }
        const next = tabAt(event.clientX, event.clientY);
        setUnder((was) => {
            if (next !== null && next !== was) tick();
            return next;
        });
    }

    function up(event: PointerEvent<HTMLElement>): void {
        const current = slide.current;
        if (!current || current.pointer !== event.pointerId) return;
        slide.current = null;
        setUnder(null);
        // A tap that never slid is the button's own click.
        if (!current.moved) return;
        const index = tabAt(event.clientX, event.clientY);
        if (index === null) return;
        slidAt.current = Date.now();
        tabs[index]?.onSelect();
    }

    function cancel(event: PointerEvent<HTMLElement>): void {
        if (slide.current?.pointer !== event.pointerId) return;
        slide.current = null;
        setUnder(null);
    }

    return (
        <nav
            ref={bar}
            aria-label={label}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={cancel}
            className={cn(
                // touch-action: a sideways slide along the bar is ours, never a
                // scroll or a browser's back gesture.
                "flex shrink-0 touch-none select-none border-t border-border bg-surface pb-[var(--safe-bottom)] md:hidden",
                className
            )}
        >
            {tabs.map((tab, index) => {
                const lit = under === index;
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                            if (Date.now() - slidAt.current < 500) return;
                            tab.onSelect();
                        }}
                        aria-current={tab.active ? "page" : undefined}
                        data-under={lit ? "" : undefined}
                        className={cn(
                            // The focus ring is drawn on the circle, not around the whole tab:
                            // a WebView keeps a tapped tab focused, which outlined it as a
                            // rectangle after every tap.
                            "group flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 py-1 text-[0.6875rem] font-medium outline-none transition-colors duration-fast [-webkit-tap-highlight-color:transparent] focus-visible:outline-none",
                            tab.active || lit ? "text-foreground" : "text-muted-foreground"
                        )}
                    >
                        <span
                            className={cn(
                                "relative flex size-9 items-center justify-center rounded-full transition-[background-color,transform] duration-fast group-active:bg-muted/70 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-ring [&_svg]:size-5 [&_svg]:shrink-0",
                                tab.active && "bg-muted",
                                lit && "scale-110 bg-muted/70"
                            )}
                        >
                            {tab.icon}
                            {tab.badge ? (
                                <span className="pointer-events-none absolute -top-0.5 -end-1 min-w-4 rounded-full bg-primary px-1 text-center text-[0.625rem] leading-4 text-primary-foreground">
                                    {tab.badge > 99 ? "99+" : tab.badge}
                                </span>
                            ) : null}
                        </span>
                        <span className="max-w-full truncate" title={tab.label}>
                            {tab.label}
                        </span>
                    </button>
                );
            })}
        </nav>
    );
}
