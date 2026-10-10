"use client";

/**
 * A slide as a show draws it: the transition into it, and its animations
 * playing a step at a time.
 *
 * Told only where the show is (`motion.ShowAt`), and works out from the move
 * between two places what to draw: a slide reached going forward comes in
 * with its transition (and its first step after, when that one plays by
 * itself), a step played runs its animations, and anything else - going back,
 * jumping to the first slide - is shown at once, as PowerPoint does. So the
 * presenter's own show and the audience window, told the same places, draw
 * the same thing.
 *
 * Somebody who asked their system for less motion gets every slide and step
 * at once.
 */

import type * as Y from "yjs";
import * as deck from "@/lib/office/deck";
import * as edits from "./deck-edits";
import { SlideDrawing } from "./slide-canvas";
import * as motion from "@/lib/office/slide-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    buildSteps,
    computeNodeStates,
    type AnimStep
} from "@polaris/genoffice-slides/animation-play";

/** Everything about one slide's motion. */
export interface SlideMotion {
    readonly transition: motion.SlideTransition;
    /** Only those with something left to move (`motion.liveAnimations`). */
    readonly animations: readonly motion.SlideAnimation[];
}

export const STILL: SlideMotion = { transition: motion.NO_TRANSITION, animations: [] };

/**
 * Each slide's motion as the deck holds it now. `version` is the document's
 * (`edits.useDocumentVersion`), so a transition somebody sets during a show
 * is the one the next slide comes in with.
 */
export function useDeckMotion(
    doc: Y.Doc,
    version: number,
    bySlide: ReadonlyMap<string, readonly deck.Box[]>
): (slideId: string) => SlideMotion {
    const motions = useMemo(() => {
        const transitions = edits.transitionsOf(doc);
        const animations = edits.animationsOf(doc);
        const out = new Map<string, SlideMotion>();
        for (const [slideId, boxes] of bySlide) {
            const transition = motion.readTransition(transitions.get(slideId));
            const live = motion.liveAnimations(
                motion.readAnimations(animations.get(slideId)),
                boxes
            );
            if (transition.kind !== "none" || live.length > 0) {
                out.set(slideId, { transition, animations: live });
            }
        }
        // A slide with nothing on it can still come in with a transition.
        for (const [slideId, raw] of transitions.entries()) {
            if (out.has(slideId)) continue;
            const transition = motion.readTransition(raw);
            if (transition.kind !== "none") out.set(slideId, { transition, animations: [] });
        }
        return out;
        // `version` is what says the maps changed.
    }, [doc, version, bySlide]);
    return useCallback((slideId: string) => motions.get(slideId) ?? STILL, [motions]);
}

/** A slide's animations as the steps a click advances. */
export function stepsOf(one: SlideMotion): AnimStep[] {
    return buildSteps(motion.playItems(one.animations));
}

/** What `motion.stepShow` needs to know about each slide of a deck. */
export function useShowPlan(
    slides: readonly deck.Slide[],
    motionOf: (slideId: string) => SlideMotion
): (slide: number) => motion.SlideSteps {
    const plan = useMemo(
        () =>
            slides.map((slide) => {
                const steps = stepsOf(motionOf(slide.id));
                return { count: steps.length, auto: steps[0]?.auto ?? false };
            }),
        [slides, motionOf]
    );
    return useCallback(
        (slide: number): motion.SlideSteps => plan[slide] ?? { count: 0, auto: false },
        [plan]
    );
}

/** Where every animated thing on a slide rests with `played` steps done. */
export function restingStates(
    one: SlideMotion,
    played: number
): ReadonlyMap<string, motion.MotionState> {
    const steps = stepsOf(one);
    return steps.length === 0 ? new Map() : computeNodeStates(steps, played, null, 100, 100);
}

function usePrefersLessMotion(): boolean {
    const [less, setLess] = useState(false);
    useEffect(() => {
        const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
        if (!query) return;
        setLess(query.matches);
        const changed = (): void => setLess(query.matches);
        query.addEventListener("change", changed);
        return () => query.removeEventListener("change", changed);
    }, []);
    return less;
}

/** What is being drawn between two places of a show. */
interface Running {
    readonly move: Exclude<motion.ShowMove, { kind: "jump" }>;
    readonly startedAt: number;
    /** How long the transition part takes; 0 for a step. */
    readonly turnMs: number;
    readonly kind: Exclude<motion.TransitionKind, "random">;
    readonly totalMs: number;
}

export function ShowStage({
    slides,
    bySlide,
    motionOf,
    at,
    onSettled
}: {
    slides: readonly deck.Slide[];
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    motionOf: (slideId: string) => SlideMotion;
    /** Where the show is; a slide that exists. */
    at: motion.ShowAt;
    /** Told whenever nothing is moving any more - the preview's cue to play
     *  the next step. */
    onSettled?: () => void;
}) {
    const less = usePrefersLessMotion();
    const plan = useShowPlan(slides, motionOf);
    const before = useRef(at);
    const turns = useRef(0);
    const [running, setRunning] = useState<Running | null>(null);
    const [now, setNow] = useState(0);
    const settled = useRef(onSettled);
    settled.current = onSettled;

    // Decided before the paint, so the arriving slide is never seen at rest
    // for a frame before its transition starts.
    useLayoutEffect(() => {
        const was = before.current;
        before.current = at;
        if (was.slide === at.slide && was.played === at.played) return;
        const move = motion.moveBetween(was, at, plan);
        const slide = slides[at.slide];
        if (move.kind === "jump" || less || !slide) {
            setRunning(null);
            settled.current?.();
            return;
        }
        const steps = stepsOf(motionOf(slide.id));
        const stepMs = (index: number): number => steps[index]?.totalMs ?? 0;
        let turnMs = 0;
        let kind: Running["kind"] = "none";
        if (move.kind === "turn") {
            turns.current += 1;
            const transition = motionOf(slide.id).transition;
            kind = motion.drawnTransition(transition, slide.id, turns.current);
            turnMs = kind === "none" ? 0 : motion.SPEED_MS[transition.speed];
        }
        const totalMs =
            move.kind === "step" ? stepMs(move.step) : turnMs + (move.autoStep ? stepMs(0) : 0);
        if (totalMs <= 0) {
            setRunning(null);
            settled.current?.();
            return;
        }
        const startedAt = performance.now();
        setNow(startedAt);
        setRunning({ move, startedAt, turnMs, kind, totalMs });
    }, [at.slide, at.played, plan, slides, motionOf, less]);

    useEffect(() => {
        if (!running) return;
        let frame = 0;
        const tick = (time: number): void => {
            if (time - running.startedAt >= running.totalMs) {
                setRunning(null);
                settled.current?.();
                return;
            }
            setNow(time);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [running]);

    const slide = slides[at.slide];
    if (!slide) return null;
    const here = motionOf(slide.id);
    const boxes = bySlide.get(slide.id) ?? [];
    const elapsed = running ? Math.max(0, now - running.startedAt) : 0;

    if (!running) {
        return (
            <SlideDrawing
                boxes={boxes}
                slideId={slide.id}
                states={restingStates(here, at.played)}
            />
        );
    }

    if (running.move.kind === "step") {
        const states = computeNodeStates(stepsOf(here), running.move.step, elapsed, 100, 100);
        return <SlideDrawing boxes={boxes} slideId={slide.id} states={states} />;
    }

    // A turn: the transition, then the step that plays by itself.
    const arriving =
        elapsed < running.turnMs
            ? restingStates(here, 0)
            : computeNodeStates(stepsOf(here), 0, elapsed - running.turnMs, 100, 100);
    if (elapsed >= running.turnMs || running.kind === "none") {
        return <SlideDrawing boxes={boxes} slideId={slide.id} states={arriving} />;
    }
    const left = slides[running.move.from];
    const frame = motion.transitionFrame(running.kind, elapsed / running.turnMs);
    const leaving = left ? (
        <div key="from" className="absolute inset-0" style={frame.from}>
            <SlideDrawing
                boxes={bySlide.get(left.id) ?? []}
                slideId={left.id}
                states={restingStates(motionOf(left.id), Number.MAX_SAFE_INTEGER)}
            />
        </div>
    ) : null;
    const coming = (
        <div key="to" className="absolute inset-0" style={frame.to}>
            <SlideDrawing boxes={boxes} slideId={slide.id} states={arriving} />
        </div>
    );
    return frame.fromOnTop ? (
        <>
            {coming}
            {leaving}
        </>
    ) : (
        <>
            {leaving}
            {coming}
        </>
    );
}

/** What a slide is previewed coming in from when it is the first. */
const BLANK: deck.Slide = { id: "polaris.preview.blank", notes: "" };

/** A pause between steps of a preview, so each one reads as its own. */
const PREVIEW_PAUSE_MS = 400;

/**
 * One slide played through where it is edited: its transition in from the
 * slide before (or from an empty one), then every step of its animations one
 * after another, as Google Slides' Play in the motion panel does. `onDone`
 * when it has finished.
 */
export function PreviewShow({
    slides,
    index,
    bySlide,
    motionOf,
    onDone
}: {
    slides: readonly deck.Slide[];
    index: number;
    bySlide: ReadonlyMap<string, readonly deck.Box[]>;
    motionOf: (slideId: string) => SlideMotion;
    onDone: () => void;
}) {
    const current = slides[index];
    const pair = useMemo(
        () => (current ? [slides[index - 1] ?? BLANK, current] : []),
        [slides, index, current]
    );
    const count = current ? stepsOf(motionOf(current.id)).length : 0;
    const [place, setPlace] = useState<motion.ShowAt>({
        slide: 0,
        played: Number.MAX_SAFE_INTEGER
    });
    const done = useRef(onDone);
    done.current = onDone;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const plan = (slide: number): motion.SlideSteps => {
            const one = pair[slide];
            const steps = one ? stepsOf(motionOf(one.id)) : [];
            return { count: steps.length, auto: steps[0]?.auto ?? false };
        };
        setPlace(motion.showAt(1, plan));
        return () => {
            if (timer.current) clearTimeout(timer.current);
        };
        // Started once; the preview plays the slide as it was when Play was pressed.
    }, []);

    if (!current) return null;
    return (
        <ShowStage
            slides={pair}
            bySlide={bySlide}
            motionOf={motionOf}
            at={place}
            onSettled={() => {
                if (timer.current) clearTimeout(timer.current);
                timer.current = setTimeout(() => {
                    if (place.slide === 1 && place.played < count) {
                        setPlace({ slide: 1, played: place.played + 1 });
                    } else done.current();
                }, PREVIEW_PAUSE_MS);
            }}
        />
    );
}
