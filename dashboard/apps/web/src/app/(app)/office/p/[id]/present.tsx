"use client";

/**
 * The deck, presented.
 *
 * Shaped after what reveal.js, Google Slides and PowerPoint's slide show agree
 * on: the whole screen (the Fullscreen API, and leaving it ends the show), a
 * click or the arrows to go on, Home and End, a swipe on a phone, the pointer
 * and the controls out of the way until the mouse moves, and a black "end of
 * the presentation" after the last slide rather than the show stopping dead.
 */

import * as core from "@polaris/core";
import * as deck from "@/lib/office/deck";
import { SlideDrawing } from "./slide-canvas";
import { Button, cn, matchShortcut } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronLeft, ChevronRight, Maximize, Minimize, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

const KEYS = [
    "viewer.nextSlide",
    "viewer.previousSlide",
    "viewer.firstSlide",
    "viewer.lastSlide"
] as const;

/** How long the controls and the pointer stay after the mouse stops. */
const CONTROLS_FOR_MS = 2500;

/** How far a finger has to travel sideways for a swipe to turn the slide. */
const SWIPE_PX = 50;

export function Present({
    slides,
    bySlide,
    from,
    onClose
}: {
    slides: readonly deck.Slide[];
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    from: number;
    onClose: () => void;
}) {
    const t = useTranslations("office");
    const surface = useRef<HTMLDivElement | null>(null);
    // One past the last slide is the end screen.
    const [at, setAt] = useState(Math.max(0, Math.min(from, slides.length - 1)));
    const [controls, setControls] = useState(true);
    const [full, setFull] = useState(false);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const close = useRef(onClose);
    close.current = onClose;
    const windowed = useRef(false);

    const ended = at >= slides.length;
    const slide = slides[at];

    const next = useCallback(() => {
        if (at >= slides.length) close.current();
        else setAt(at + 1);
    }, [at, slides.length]);
    const previous = useCallback(() => setAt((one) => Math.max(0, one - 1)), []);

    const wake = useCallback(() => {
        setControls(true);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setControls(false), CONTROLS_FOR_MS);
    }, []);

    // The whole screen when the browser allows it. A refusal (an iframe, an
    // old browser) leaves the show filling the window, which still works.
    useEffect(() => {
        const one = surface.current;
        if (!one) return;
        one.focus();
        let entered = false;
        const changed = (): void => {
            const now = document.fullscreenElement === one;
            setFull(now);
            if (now) entered = true;
            // Leaving full screen - Escape, which the browser keeps for itself
            // while it is full screen - is leaving the show.
            else if (entered && !windowed.current) close.current();
            if (!now) windowed.current = false;
        };
        document.addEventListener("fullscreenchange", changed);
        one.requestFullscreen?.().catch(() => undefined);
        wake();
        return () => {
            document.removeEventListener("fullscreenchange", changed);
            if (hideTimer.current) clearTimeout(hideTimer.current);
            if (document.fullscreenElement === one)
                void document.exitFullscreen().catch(() => undefined);
        };
    }, [wake]);

    const swipe = useRef<{ x: number; y: number } | null>(null);
    const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
        if (event.pointerType === "touch") swipe.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
        const start = swipe.current;
        swipe.current = null;
        if (!start) return;
        const dx = event.clientX - start.x;
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - start.y)) {
            if (dx < 0) next();
            else previous();
        }
    };

    const toggleFull = (): void => {
        const one = surface.current;
        if (!one) return;
        if (document.fullscreenElement) {
            windowed.current = true;
            void document.exitFullscreen().catch(() => {
                windowed.current = false;
            });
        } else void one.requestFullscreen?.().catch(() => undefined);
    };

    return (
        <div
            ref={surface}
            role="dialog"
            aria-modal="true"
            aria-label={t("slides.presenting")}
            tabIndex={-1}
            onKeyDown={(event) => {
                // Its own keys, never the editor's underneath.
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    onClose();
                    return;
                }
                // A modifier going down is not a key pressed yet.
                if (!core.bindingOfEvent(event)) return;
                const action = matchShortcut(event, KEYS);
                // On the end screen any key but a way back leaves, as in
                // PowerPoint.
                if (ended && (action === null || action === "viewer.nextSlide")) {
                    event.preventDefault();
                    onClose();
                    return;
                }
                switch (action) {
                    case "viewer.nextSlide":
                        next();
                        break;
                    case "viewer.previousSlide":
                        previous();
                        break;
                    case "viewer.firstSlide":
                        setAt(0);
                        break;
                    case "viewer.lastSlide":
                        setAt(slides.length - 1);
                        break;
                    default:
                        return;
                }
                event.preventDefault();
            }}
            onPointerMove={wake}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onClick={(event) => {
                if (event.button === 0) next();
            }}
            className={cn(
                "fixed inset-0 z-50 flex touch-none select-none flex-col bg-black text-white outline-none",
                !controls && "cursor-none"
            )}
        >
            <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
                {ended ? (
                    <div className="flex flex-col items-center gap-2 text-center">
                        <p className="text-[15px] font-medium">{t("slides.endOfShow")}</p>
                        <p className="text-[13px] text-white/60">{t("slides.endHint")}</p>
                    </div>
                ) : (
                    <div
                        className="relative aspect-video overflow-hidden bg-background text-foreground"
                        style={{ width: "min(100cqw, calc(100cqh * 16 / 9))" }}
                    >
                        {slide ? <SlideDrawing boxes={bySlide.get(slide.id) ?? []} /> : null}
                    </div>
                )}
            </div>

            <div
                // The controls fade with the pointer; a press on them is never
                // a press on the slide.
                onClick={(event) => event.stopPropagation()}
                className={cn(
                    "absolute bottom-3 left-3 flex items-center gap-1 rounded-lg bg-black/70 p-1 transition-opacity",
                    controls ? "opacity-100" : "pointer-events-none opacity-0"
                )}
            >
                <PresentButton label={t("slides.previous")} disabled={at === 0} onClick={previous}>
                    <ChevronLeft className="size-4 shrink-0" aria-hidden />
                </PresentButton>
                <span
                    className="min-w-14 px-1 text-center text-[12px] tabular-nums text-white/80"
                    aria-live="polite"
                >
                    {t("slides.counter", {
                        at: Math.min(at + 1, slides.length),
                        total: slides.length
                    })}
                </span>
                <PresentButton label={t("slides.next")} onClick={next}>
                    <ChevronRight className="size-4 shrink-0" aria-hidden />
                </PresentButton>
                <PresentButton
                    label={full ? t("slides.exitFullScreen") : t("slides.fullScreen")}
                    onClick={toggleFull}
                >
                    {full ? (
                        <Minimize className="size-4 shrink-0" aria-hidden />
                    ) : (
                        <Maximize className="size-4 shrink-0" aria-hidden />
                    )}
                </PresentButton>
                <PresentButton label={t("slides.stopPresenting")} onClick={onClose}>
                    <X className="size-4 shrink-0" aria-hidden />
                </PresentButton>
            </div>
        </div>
    );
}

function PresentButton({
    label,
    disabled,
    onClick,
    children
}: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="size-8 text-white hover:bg-white/15 hover:text-white"
        >
            {children}
        </Button>
    );
}
