"use client";

/**
 * The presenter view: what the person giving the talk sees while the room sees
 * the slide.
 *
 * What PowerPoint's presenter view, Google Slides' speaker notes window and
 * reveal.js' speaker view agree on: the slide being shown, the next one, the
 * notes in type the presenter can read from a step back (larger or smaller with
 * a press), the time since the talk began - paused and started again with a
 * press - and the slide counter. The slide itself goes to an audience window
 * opened from here and dragged onto the projector (`show-channel.ts`); both
 * turn together whichever is pressed.
 */

import * as core from "@polaris/core";
import * as deck from "@/lib/office/deck";
import type { ShowStep } from "./present";
import { SlideDrawing } from "./slide-canvas";
import { Button, cn, matchShortcut } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    audiencePath,
    canOpenAudienceWindow,
    openShowChannel,
    type ShowChannel
} from "./show-channel";
import {
    AArrowDown,
    AArrowUp,
    ChevronLeft,
    ChevronRight,
    MonitorUp,
    Pause,
    Play,
    RotateCcw,
    X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const KEYS = [
    "viewer.nextSlide",
    "viewer.previousSlide",
    "viewer.firstSlide",
    "viewer.lastSlide"
] as const;

/** The notes' type sizes on offer, in pixels. */
const NOTE_SIZES = [14, 16, 18, 20, 24, 28, 32, 40] as const;

const NOTE_SIZE_KEY = "polaris.office.slides.presenterNoteSize";

function readNoteSize(): number {
    try {
        const kept = Number(localStorage.getItem(NOTE_SIZE_KEY));
        return NOTE_SIZES.includes(kept as (typeof NOTE_SIZES)[number]) ? kept : 18;
    } catch {
        return 18;
    }
}

/** A running time as the clock on a presenter view shows it. */
export function clockOf(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    const two = (value: number): string => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}

/** A stopwatch that pauses: how long it has run, and whether it is running. */
function useElapsed(): {
    elapsed: number;
    running: boolean;
    toggle: () => void;
    reset: () => void;
} {
    const [running, setRunning] = useState(true);
    // Time run before the last start, and when that start was.
    const banked = useRef(0);
    const since = useRef(Date.now());
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!running) return;
        const tick = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(tick);
    }, [running]);
    const elapsed = banked.current + (running ? now - since.current : 0);
    return {
        elapsed,
        running,
        toggle: () => {
            const at = Date.now();
            if (running) banked.current += at - since.current;
            else since.current = at;
            setNow(at);
            setRunning(!running);
        },
        reset: () => {
            banked.current = 0;
            since.current = Date.now();
            setNow(since.current);
        }
    };
}

export function PresenterView({
    documentId,
    slides,
    bySlide,
    notesOf,
    from,
    audienceWindow,
    onClose
}: {
    documentId: string;
    slides: readonly deck.Slide[];
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    notesOf: (slide: deck.Slide) => string;
    from: number;
    audienceWindow: boolean;
    onClose: () => void;
}) {
    const t = useTranslations("office");
    const surface = useRef<HTMLDivElement | null>(null);
    // One past the last slide is the end of the show.
    const [at, setAt] = useState(Math.max(0, Math.min(from, slides.length - 1)));
    const clock = useElapsed();
    const [noteSize, setNoteSize] = useState(18);
    const [canAudience, setCanAudience] = useState(false);
    const [audienceOpen, setAudienceOpen] = useState(false);
    const channel = useRef<ShowChannel | null>(null);
    const audience = useRef<Window | null>(null);
    const close = useRef(onClose);
    close.current = onClose;
    const atNow = useRef(at);
    atNow.current = at;

    const total = slides.length;
    const ended = at >= total;
    const slide = slides[at];
    const following = slides[at + 1];

    const go = useCallback(
        (step: ShowStep): void => {
            if (step === "next" && atNow.current >= total) {
                close.current();
                return;
            }
            setAt((one) =>
                step === "first"
                    ? 0
                    : step === "last"
                      ? total - 1
                      : step === "previous"
                        ? Math.max(0, one - 1)
                        : Math.min(total, one + 1)
            );
        },
        [total]
    );

    const goNow = useRef(go);
    goNow.current = go;

    // One channel for the whole show: a slide somebody adds meanwhile must not
    // close the audience window and open it again.
    useEffect(() => {
        surface.current?.focus();
        setNoteSize(readNoteSize());
        setCanAudience(audienceWindow && canOpenAudienceWindow());
        const opened = openShowChannel(documentId, (one) => {
            if (one.kind === "hello") {
                setAudienceOpen(true);
                channel.current?.send({ kind: "at", at: atNow.current });
            } else if (one.kind === "go") goNow.current(one.to);
        });
        channel.current = opened;
        return () => {
            opened?.send({ kind: "end" });
            opened?.close();
            channel.current = null;
        };
    }, [documentId, audienceWindow]);

    // Wherever the slide changes from, the audience window follows.
    useEffect(() => {
        channel.current?.send({ kind: "at", at });
    }, [at]);

    const openAudience = (): void => {
        const opened = window.open(
            audiencePath(documentId),
            `polaris-show-${documentId}`,
            "popup,width=1280,height=720"
        );
        audience.current = opened;
        if (opened) opened.focus();
    };

    const sizeBy = (by: number): void => {
        const index = NOTE_SIZES.indexOf(noteSize as (typeof NOTE_SIZES)[number]);
        const next = NOTE_SIZES[Math.min(NOTE_SIZES.length - 1, Math.max(0, index + by))] ?? 18;
        setNoteSize(next);
        try {
            localStorage.setItem(NOTE_SIZE_KEY, String(next));
        } catch {
            // Kept for this show only.
        }
    };

    const notes = slide ? notesOf(slide) : "";

    return (
        <div
            ref={surface}
            role="dialog"
            aria-modal="true"
            aria-label={t("slides.presenter.title")}
            tabIndex={-1}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                    event.preventDefault();
                    onClose();
                    return;
                }
                if (!core.bindingOfEvent(event)) return;
                // A press inside a button is that button's.
                if (event.target instanceof HTMLButtonElement && event.key === " ") return;
                const action = matchShortcut(event, KEYS);
                switch (action) {
                    case "viewer.nextSlide":
                        go("next");
                        break;
                    case "viewer.previousSlide":
                        go("previous");
                        break;
                    case "viewer.firstSlide":
                        go("first");
                        break;
                    case "viewer.lastSlide":
                        go("last");
                        break;
                    default:
                        return;
                }
                event.preventDefault();
            }}
            className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
        >
            <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
                <div className="flex items-center gap-1">
                    <span
                        className="min-w-16 text-[15px] font-medium tabular-nums"
                        role="timer"
                        aria-label={t("slides.presenter.elapsed")}
                    >
                        {clockOf(clock.elapsed)}
                    </span>
                    <IconButton
                        label={
                            clock.running
                                ? t("slides.presenter.pause")
                                : t("slides.presenter.resume")
                        }
                        onClick={clock.toggle}
                    >
                        {clock.running ? (
                            <Pause className="size-4 shrink-0" aria-hidden />
                        ) : (
                            <Play className="size-4 shrink-0" aria-hidden />
                        )}
                    </IconButton>
                    <IconButton label={t("slides.presenter.reset")} onClick={clock.reset}>
                        <RotateCcw className="size-4 shrink-0" aria-hidden />
                    </IconButton>
                </div>
                <span className="text-[13px] tabular-nums text-muted-foreground" aria-live="polite">
                    {t("slides.counter", { at: Math.min(at + 1, total), total })}
                </span>
                <div className="ml-auto flex items-center gap-1">
                    {canAudience ? (
                        <Button variant="secondary" size="sm" onClick={openAudience}>
                            <MonitorUp className="size-4 shrink-0" aria-hidden />
                            <span className="max-sm:sr-only">
                                {audienceOpen
                                    ? t("slides.presenter.showAudience")
                                    : t("slides.presenter.openAudience")}
                            </span>
                        </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        <X className="size-4 shrink-0" aria-hidden />
                        <span className="max-sm:sr-only">{t("slides.stopPresenting")}</span>
                    </Button>
                </div>
            </header>

            <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 sm:content-stretch sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] sm:overflow-hidden">
                <section className="flex min-h-0 min-w-0 flex-col gap-2">
                    <h2 className="text-[12px] font-medium text-muted-foreground">
                        {t("slides.presenter.current")}
                    </h2>
                    <div className="min-h-0 flex-1 [container-type:size] max-sm:aspect-video max-sm:flex-none">
                        <div className="flex h-full w-full items-center justify-center">
                            <button
                                type="button"
                                onClick={() => go("next")}
                                aria-label={t("slides.next")}
                                className="relative aspect-video overflow-hidden rounded-lg border border-border bg-background shadow-sm"
                                style={{ width: "min(100cqw, calc(100cqh * 16 / 9))" }}
                            >
                                {ended || !slide ? (
                                    <span className="absolute inset-0 flex items-center justify-center bg-black text-[13px] text-white">
                                        {t("slides.endOfShow")}
                                    </span>
                                ) : (
                                    <SlideDrawing boxes={bySlide.get(slide.id) ?? []} />
                                )}
                            </button>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center justify-center gap-2">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={at === 0}
                            onClick={() => go("previous")}
                        >
                            <ChevronLeft className="size-4 shrink-0" aria-hidden />
                            {t("slides.previous")}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => go("next")}>
                            {t("slides.next")}
                            <ChevronRight className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </div>
                </section>

                <section className="flex min-h-0 min-w-0 flex-col gap-3">
                    <div className="flex shrink-0 flex-col gap-2">
                        <h2 className="text-[12px] font-medium text-muted-foreground">
                            {t("slides.presenter.nextUp")}
                        </h2>
                        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-background max-sm:w-1/2">
                            {following ? (
                                <SlideDrawing boxes={bySlide.get(following.id) ?? []} />
                            ) : (
                                <span className="absolute inset-0 flex items-center justify-center bg-black px-2 text-center text-[12px] text-white">
                                    {t("slides.endOfShow")}
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-1">
                        <div className="flex shrink-0 items-center gap-1">
                            <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
                                {t("slides.notes.title")}
                            </h2>
                            <IconButton
                                label={t("slides.presenter.smallerNotes")}
                                disabled={noteSize <= NOTE_SIZES[0]}
                                onClick={() => sizeBy(-1)}
                            >
                                <AArrowDown className="size-4 shrink-0" aria-hidden />
                            </IconButton>
                            <IconButton
                                label={t("slides.presenter.largerNotes")}
                                disabled={noteSize >= NOTE_SIZES[NOTE_SIZES.length - 1]!}
                                onClick={() => sizeBy(1)}
                            >
                                <AArrowUp className="size-4 shrink-0" aria-hidden />
                            </IconButton>
                        </div>
                        <div
                            className={cn(
                                "min-h-24 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 leading-relaxed",
                                !notes.trim() && "text-muted-foreground"
                            )}
                            style={{ fontSize: noteSize }}
                        >
                            {notes.trim() ? notes : t("slides.presenter.noNotes")}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

function IconButton({
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
        >
            {children}
        </Button>
    );
}
