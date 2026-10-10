/**
 * How a deck moves: the transition into each slide, and the animations of the
 * things on it.
 *
 * The vocabulary is PowerPoint's, as `@polaris/pptx` writes it into a file -
 * the transitions `<p:transition>` holds and the preset effects of
 * `<p:timing>`, with the three triggers every editor offers (on click, with the
 * previous one, after the previous one) - so carrying motion through a pptx
 * export or import later is a mapping, not a translation. Neither carries it
 * yet: `export.ts` writes only the slides, their boxes and their notes.
 * Playback is GenOffice's (`@polaris/genoffice-slides/animation-play`): the
 * same grouping of animations into the steps a click advances, and the same
 * state of every box at any moment.
 *
 * Stored per slide, keyed by its id: a transition is one small record, and a
 * slide's animations are one ordered list written whole - the order is the
 * meaning, and two people reordering the same list at once is one of them
 * winning rather than a merge nobody asked for.
 *
 * Pure, so the arithmetic of a show - which click does what, where a box is a
 * third of the way through flying in - is tested without a screen.
 */

import { z } from "zod";
import type { Box } from "./deck";

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** The transitions on offer: PowerPoint's that a slide can be drawn doing,
 *  in the order its gallery lists them. `random` picks one of the others each
 *  time the slide is reached. */
export const TRANSITIONS = [
    "none",
    "fade",
    "push",
    "wipe",
    "split",
    "cover",
    "pull",
    "circle",
    "zoom",
    "random"
] as const;

export type TransitionKind = (typeof TRANSITIONS)[number];

/** PowerPoint's three speeds (`spd`), and how long each one takes. */
export const SPEEDS = ["fast", "med", "slow"] as const;

export type TransitionSpeed = (typeof SPEEDS)[number];

export const SPEED_MS: Readonly<Record<TransitionSpeed, number>> = {
    fast: 500,
    med: 750,
    slow: 1000
};

export interface SlideTransition {
    readonly kind: TransitionKind;
    readonly speed: TransitionSpeed;
}

export const NO_TRANSITION: SlideTransition = { kind: "none", speed: "med" };

/** The kinds `random` chooses from. */
const DRAWN: readonly Exclude<TransitionKind, "none" | "random">[] = TRANSITIONS.filter(
    (one): one is Exclude<TransitionKind, "none" | "random"> => one !== "none" && one !== "random"
);

const transitionSchema = z.object({
    kind: z.enum(TRANSITIONS),
    speed: z.enum(SPEEDS).catch("med")
});

/** A stored transition, or none for anything that is not one. */
export function readTransition(raw: unknown): SlideTransition {
    const read = transitionSchema.safeParse(raw);
    return read.success ? read.data : NO_TRANSITION;
}

/**
 * The transition actually drawn into a slide. `random` is settled by the
 * slide's id and how many times the show has turned, so the presenter's view
 * and the audience window - two pages working it out apart - draw the same
 * one, and the next time round it is likely another.
 */
export function drawnTransition(
    transition: SlideTransition,
    slideId: string,
    turn: number
): Exclude<TransitionKind, "random"> {
    if (transition.kind !== "random") return transition.kind;
    let hash = turn;
    for (const char of slideId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return DRAWN[hash % DRAWN.length] ?? "fade";
}

/** How the two slides look `progress` (0 to 1) of the way through a
 *  transition: CSS for the slide being left and the one arriving, and which
 *  of the two is drawn on top. */
export interface TransitionFrame {
    readonly from: Readonly<Record<string, string | number>>;
    readonly to: Readonly<Record<string, string | number>>;
    readonly fromOnTop: boolean;
}

function easeInOut(t: number): number {
    const p = Math.min(1, Math.max(0, t));
    return p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
}

/**
 * Each transition as `@polaris/pptx` writes it: `push` up from the bottom,
 * `wipe`, `cover` and `pull` towards the left, `split` out from the middle
 * across, `zoom` in.
 */
export function transitionFrame(
    kind: Exclude<TransitionKind, "random">,
    progress: number
): TransitionFrame {
    const p = easeInOut(progress);
    const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;
    switch (kind) {
        case "fade":
            return { from: {}, to: { opacity: p }, fromOnTop: false };
        case "push":
            return {
                from: { transform: `translateY(${pct(-p)})` },
                to: { transform: `translateY(${pct(1 - p)})` },
                fromOnTop: false
            };
        case "wipe":
            return { from: {}, to: { clipPath: `inset(0 0 0 ${pct(1 - p)})` }, fromOnTop: false };
        case "split":
            return {
                from: {},
                to: { clipPath: `inset(${pct((1 - p) / 2)} 0 ${pct((1 - p) / 2)} 0)` },
                fromOnTop: false
            };
        case "cover":
            return { from: {}, to: { transform: `translateX(${pct(1 - p)})` }, fromOnTop: false };
        case "pull":
            return { from: { transform: `translateX(${pct(-p)})` }, to: {}, fromOnTop: true };
        case "circle":
            // 71% of the reference radius reaches the corners of any box.
            return {
                from: {},
                to: { clipPath: `circle(${pct(0.71 * p)} at 50% 50%)` },
                fromOnTop: false
            };
        case "zoom":
            return {
                from: { opacity: 1 - p },
                to: { transform: `scale(${(0.3 + 0.7 * p).toFixed(4)})`, opacity: p },
                fromOnTop: false
            };
        case "none":
            return { from: {}, to: {}, fromOnTop: false };
    }
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

/** Effects a box comes on with, is drawn attention to with, and leaves with -
 *  PowerPoint's presets that `@polaris/pptx` writes. */
export const ENTRANCES = [
    "appear",
    "fade",
    "flyIn",
    "wipe",
    "wipeDown",
    "splitIn",
    "bounce",
    "flipIn",
    "zoom"
] as const;
export const EMPHASES = ["pulse", "spin", "grow", "teeter"] as const;
export const EXITS = ["disappear", "fadeOut", "flyOut", "wipeOut", "shrink", "zoomOut"] as const;

export const EFFECTS = [...ENTRANCES, ...EMPHASES, ...EXITS] as const;

export type EffectKind = (typeof EFFECTS)[number];

export type EffectClass = "entrance" | "emphasis" | "exit";

export function classOf(effect: EffectKind): EffectClass {
    if ((ENTRANCES as readonly string[]).includes(effect)) return "entrance";
    if ((EMPHASES as readonly string[]).includes(effect)) return "emphasis";
    return "exit";
}

export const TRIGGERS = ["onClick", "withPrev", "afterPrev"] as const;

export type Trigger = (typeof TRIGGERS)[number];

/** Durations and delays, in milliseconds: PowerPoint's own range is 0.01 s
 *  to 59 s; a tenth of a second is the shortest anybody sees. */
export const DURATION_MIN = 100;
export const DURATION_MAX = 59_000;
export const DELAY_MAX = 59_000;
export const DURATION_DEFAULT = 500;

/** More animations than this on one slide is a deck nobody can sit through. */
export const ANIMATIONS_MAX = 100;

/** What an animation moves: a box by its id, or a whole group as one. */
export type Target = string;

const GROUP_PREFIX = "group:";

export interface SlideAnimation {
    readonly id: string;
    readonly target: Target;
    readonly effect: EffectKind;
    readonly trigger: Trigger;
    readonly durationMs: number;
    readonly delayMs: number;
}

const animationSchema = z.object({
    id: z.string().min(1).max(64),
    target: z.string().min(1).max(200),
    effect: z.enum(EFFECTS),
    trigger: z.enum(TRIGGERS).catch("onClick"),
    durationMs: z
        .number()
        .finite()
        .catch(DURATION_DEFAULT)
        .transform((value) => Math.round(Math.min(DURATION_MAX, Math.max(DURATION_MIN, value)))),
    delayMs: z
        .number()
        .finite()
        .catch(0)
        .transform((value) => Math.round(Math.min(DELAY_MAX, Math.max(0, value))))
});

/** A slide's stored animations, in order. Anything that is not one is left
 *  out rather than refusing the rest. */
export function readAnimations(raw: unknown): SlideAnimation[] {
    if (!Array.isArray(raw)) return [];
    const out: SlideAnimation[] = [];
    for (const one of raw.slice(0, ANIMATIONS_MAX)) {
        const read = animationSchema.safeParse(one);
        if (read.success) out.push(read.data);
    }
    return out;
}

/** What an animation of `box` moves: its group when it is in one - a group
 *  is one thing on a slide, as everywhere else - and the box otherwise. */
export function targetOf(box: Pick<Box, "id" | "group">): Target {
    return box.group ? `${GROUP_PREFIX}${box.group}` : box.id;
}

/** The boxes an animation moves. None when they have all gone. */
export function membersOf<T extends Pick<Box, "id" | "group">>(
    target: Target,
    boxes: readonly T[]
): T[] {
    if (target.startsWith(GROUP_PREFIX)) {
        const group = target.slice(GROUP_PREFIX.length);
        return boxes.filter((box) => box.group === group);
    }
    return boxes.filter((box) => box.id === target);
}

/** The animations that still have something to move. A box deleted, or a
 *  group taken apart, takes its animations with it. */
export function liveAnimations<T extends Pick<Box, "id" | "group">>(
    list: readonly SlideAnimation[],
    boxes: readonly T[]
): SlideAnimation[] {
    return list.filter((one) => membersOf(one.target, boxes).length > 0);
}

/** A new animation of `target`: on entering by fading, on a click - what
 *  Google Slides adds first. */
export function newAnimation(id: string, target: Target): SlideAnimation {
    return {
        id,
        target,
        effect: "fade",
        trigger: "onClick",
        durationMs: DURATION_DEFAULT,
        delayMs: 0
    };
}

/** A list with one animation moved by `by` places. */
export function moveAnimation(
    list: readonly SlideAnimation[],
    id: string,
    by: number
): SlideAnimation[] {
    const from = list.findIndex((one) => one.id === id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= list.length) return [...list];
    const next = [...list];
    const [one] = next.splice(from, 1);
    if (one) next.splice(to, 0, one);
    return next;
}

/** A slide's animations, with the boxes copied onto another slide under new
 *  ids - what duplicating a slide does to them. */
export function remapAnimations(
    list: readonly SlideAnimation[],
    ids: ReadonlyMap<string, string>,
    newId: () => string
): SlideAnimation[] {
    return list.map((one) => ({
        ...one,
        id: newId(),
        target: one.target.startsWith(GROUP_PREFIX)
            ? one.target
            : (ids.get(one.target) ?? one.target)
    }));
}

/** A group taken apart: its animations become the same animation of each box
 *  that was in it, played together. */
export function ungroupAnimations(
    list: readonly SlideAnimation[],
    group: string,
    members: readonly string[],
    newId: () => string
): SlideAnimation[] {
    const target = `${GROUP_PREFIX}${group}`;
    return list.flatMap((one) =>
        one.target !== target
            ? [one]
            : members.map((member, at) => ({
                  ...one,
                  id: at === 0 ? one.id : newId(),
                  target: member,
                  trigger: at === 0 ? one.trigger : ("withPrev" as const),
                  delayMs: at === 0 ? one.delayMs : 0
              }))
    );
}

// ---------------------------------------------------------------------------
// The show
// ---------------------------------------------------------------------------

/** What the playback engine reads: GenOffice's `AnimationItem`. */
export interface PlayItem {
    readonly sourceId: string;
    readonly targetName: string;
    readonly effect: EffectKind;
    readonly trigger: Trigger;
    readonly durationMs: number;
    readonly delayMs: number;
}

export function playItems(list: readonly SlideAnimation[]): PlayItem[] {
    return list.map((one) => ({
        sourceId: one.target,
        targetName: "",
        effect: one.effect,
        trigger: one.trigger,
        durationMs: one.durationMs,
        delayMs: one.delayMs
    }));
}

/** Where a show is: the slide (one past the last is the end screen), and how
 *  many of its steps have played. */
export interface ShowAt {
    readonly slide: number;
    readonly played: number;
}

/** What one slide brings to a show: how many steps its animations make, and
 *  whether the first plays by itself on arrival (its first animation is not
 *  on a click). */
export interface SlideSteps {
    readonly count: number;
    readonly auto: boolean;
}

/** How many steps have played when a slide has just been reached. */
export function arrived(steps: SlideSteps): number {
    return steps.auto && steps.count > 0 ? 1 : 0;
}

/** Where the show starts on slide `slide`. */
export function showAt(slide: number, stepsOf: (slide: number) => SlideSteps): ShowAt {
    return { slide, played: arrived(stepsOf(slide)) };
}

/**
 * Where a press takes the show, as PowerPoint plays one: forward plays the
 * slide's next step while it has one, and turns the slide when it has none;
 * back takes the last step back, and on a slide with none played goes to the
 * slide before as it was left - everything on it played. `first` and `last`
 * go to those slides as they are on arrival.
 */
export function stepShow(
    at: ShowAt,
    to: "next" | "previous" | "first" | "last",
    total: number,
    stepsOf: (slide: number) => SlideSteps
): ShowAt {
    if (total <= 0) return { slide: 0, played: 0 };
    if (to === "first") return showAt(0, stepsOf);
    if (to === "last") return showAt(total - 1, stepsOf);
    if (to === "next") {
        if (at.slide >= total) return at;
        if (at.played < stepsOf(at.slide).count) return { slide: at.slide, played: at.played + 1 };
        const next = at.slide + 1;
        return next >= total ? { slide: total, played: 0 } : showAt(next, stepsOf);
    }
    if (at.slide >= total) {
        const last = total - 1;
        return { slide: last, played: stepsOf(last).count };
    }
    if (at.played > arrived(stepsOf(at.slide))) return { slide: at.slide, played: at.played - 1 };
    if (at.slide === 0) return at;
    const before = at.slide - 1;
    return { slide: before, played: stepsOf(before).count };
}

/** What a change of place in a show is drawn as: the transition into a
 *  slide reached going forward (and its first step after, when that one
 *  plays itself), one step played, or nothing - a jump is shown at once. */
export type ShowMove =
    | { readonly kind: "turn"; readonly from: number; readonly autoStep: boolean }
    | { readonly kind: "step"; readonly step: number }
    | { readonly kind: "jump" };

export function moveBetween(
    before: ShowAt,
    after: ShowAt,
    stepsOf: (slide: number) => SlideSteps
): ShowMove {
    if (after.slide === before.slide && after.played === before.played + 1) {
        return { kind: "step", step: before.played };
    }
    if (after.slide === before.slide + 1 && after.played === arrived(stepsOf(after.slide))) {
        return { kind: "turn", from: before.slide, autoStep: after.played === 1 };
    }
    return { kind: "jump" };
}

// ---------------------------------------------------------------------------
// Drawing a box mid-animation
// ---------------------------------------------------------------------------

/** A box's state at one moment of a show, as the playback engine gives it
 *  (`NodeAnimState`), with offsets in hundredths of the slide. */
export interface MotionState {
    readonly hidden: boolean;
    readonly opacity: number;
    readonly scale: number;
    readonly scaleX: number;
    readonly rotationDeg: number;
    readonly dx: number;
    readonly dy: number;
    readonly clip: { readonly t: number; readonly mode: "btm" | "top" | "mid" } | null;
}

/**
 * The CSS for a layer the size of the slide that holds the boxes `frame`
 * covers, in the state `state`: turned and scaled about the middle of the
 * boxes, moved by fractions of the slide, and cut to the part a wipe has
 * shown so far.
 */
export function motionStyle(
    state: MotionState,
    frame: { x: number; y: number; w: number; h: number }
): Record<string, string | number> {
    const style: Record<string, string | number> = {};
    if (state.hidden) style.visibility = "hidden";
    if (state.opacity !== 1) style.opacity = Math.max(0, Math.min(1, state.opacity));
    const parts: string[] = [];
    if (state.dx !== 0 || state.dy !== 0)
        parts.push(`translate(${state.dx.toFixed(3)}%, ${state.dy.toFixed(3)}%)`);
    if (state.rotationDeg !== 0) parts.push(`rotate(${state.rotationDeg.toFixed(3)}deg)`);
    if (state.scale !== 1 || state.scaleX !== 1)
        parts.push(`scale(${(state.scale * state.scaleX).toFixed(4)}, ${state.scale.toFixed(4)})`);
    if (parts.length > 0) {
        style.transform = parts.join(" ");
        style.transformOrigin = `${((frame.x + frame.w / 2) * 100).toFixed(3)}% ${((frame.y + frame.h / 2) * 100).toFixed(3)}%`;
    }
    if (state.clip) {
        const pct = (value: number): string => `${(Math.max(0, value) * 100).toFixed(3)}%`;
        const hidden = frame.h * (1 - Math.min(1, Math.max(0, state.clip.t)));
        const top = frame.y;
        const bottom = 1 - (frame.y + frame.h);
        const left = frame.x;
        const right = 1 - (frame.x + frame.w);
        const [cutTop, cutBottom] =
            state.clip.mode === "btm"
                ? [top + hidden, bottom]
                : state.clip.mode === "top"
                  ? [top, bottom + hidden]
                  : [top + hidden / 2, bottom + hidden / 2];
        style.clipPath = `inset(${pct(cutTop)} ${pct(right)} ${pct(cutBottom)} ${pct(left)})`;
    }
    return style;
}
