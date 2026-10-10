"use client";

/**
 * The motion panel: how the slide comes in, and how the things on it move.
 *
 * Google Slides' Motion panel and PowerPoint's Transitions and Animations
 * tabs agree on the shape of it, and so does this: the slide's transition and
 * its speed (and the same on every slide with one press), then the slide's
 * animations in the order they play - each with its effect, what starts it,
 * how long it takes and how long it waits - added for whatever is chosen on
 * the slide, reordered, taken out, and played through on the canvas.
 */

import * as deck from "@/lib/office/deck";
import * as motion from "@/lib/office/slide-motion";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    cn,
    Input,
    SegmentedControl,
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectRoot,
    SelectSeparator,
    SelectTrigger,
    SelectValue
} from "@polaris/ui";
import { useEffect, useId, useState } from "react";
import { ArrowDown, ArrowUp, Play, Plus, Square, Trash2, X } from "lucide-react";

const CLASS_EFFECTS: readonly [motion.EffectClass, readonly motion.EffectKind[]][] = [
    ["entrance", motion.ENTRANCES],
    ["emphasis", motion.EMPHASES],
    ["exit", motion.EXITS]
];

/** Each class's colour, as PowerPoint marks entrances green, emphasis gold and
 *  exits red - with its name beside it, never the colour alone. */
const CLASS_DOT: Readonly<Record<motion.EffectClass, string>> = {
    entrance: "bg-emerald-500",
    emphasis: "bg-amber-500",
    exit: "bg-rose-500"
};

export function MotionPanel({
    slideIds,
    slideId,
    transition,
    animations,
    boxes,
    chosen,
    nameOf,
    editable,
    playing,
    onTransition,
    onAnimations,
    onChoose,
    onPlay,
    onStop,
    onClose
}: {
    /** Every slide, for "apply to all". */
    slideIds: readonly string[];
    slideId: string;
    transition: motion.SlideTransition;
    /** The slide's animations still moving something. */
    animations: readonly motion.SlideAnimation[];
    boxes: readonly deck.Box[];
    chosen: readonly deck.Box[];
    nameOf: (box: deck.Box) => string;
    editable: boolean;
    /** Whether the slide is being played through on the canvas. */
    playing: boolean;
    onTransition: (slideIds: readonly string[], transition: motion.SlideTransition) => void;
    onAnimations: (list: readonly motion.SlideAnimation[]) => void;
    onChoose: (ids: string[]) => void;
    onPlay: () => void;
    onStop: () => void;
    onClose: () => void;
}) {
    const t = useTranslations("office");
    const titleId = useId();
    // What "Add" animates: each chosen thing once, a group as one.
    const targets = [...new Set(chosen.map(motion.targetOf))];
    const add = (): void => {
        const room = motion.ANIMATIONS_MAX - animations.length;
        if (room <= 0 || targets.length === 0) return;
        onAnimations([
            ...animations,
            ...targets.slice(0, room).map((target, at) =>
                at === 0
                    ? motion.newAnimation(crypto.randomUUID(), target)
                    : {
                          ...motion.newAnimation(crypto.randomUUID(), target),
                          trigger: "withPrev" as const
                      }
            )
        ]);
    };
    const patch = (id: string, change: Partial<motion.SlideAnimation>): void =>
        onAnimations(animations.map((one) => (one.id === id ? { ...one, ...change } : one)));
    const nameOfTarget = (target: string): string => {
        const members = motion.membersOf(target, boxes);
        if (members.length > 1) return t("slides.motion.group", { count: members.length });
        return members[0] ? nameOf(members[0]) : "";
    };
    // Which step each animation starts: a number on the ones a click starts.
    let clicks = 0;
    const steps = animations.map((one, at) => {
        if (one.trigger === "onClick") clicks += 1;
        return at === 0 && one.trigger !== "onClick" ? 0 : clicks;
    });

    return (
        <aside
            aria-labelledby={titleId}
            // A phone keeps the slide in sight above it, so Play is seen; a
            // tablet lays it over the right; a wide screen sets it beside.
            className="absolute inset-x-0 bottom-0 z-20 flex h-[55%] flex-col border-t border-border bg-card shadow-lg sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:h-auto sm:w-full sm:max-w-sm sm:border-l sm:border-t-0 lg:static lg:z-auto lg:w-80 lg:max-w-none lg:shadow-none"
        >
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <h2 id={titleId} className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {t("slides.motion.title")}
                </h2>
                {playing ? (
                    <Button variant="secondary" size="sm" onClick={onStop}>
                        <Square className="size-4 shrink-0" aria-hidden />
                        {t("slides.motion.stop")}
                    </Button>
                ) : (
                    <Button variant="secondary" size="sm" onClick={onPlay}>
                        <Play className="size-4 shrink-0" aria-hidden />
                        {t("slides.motion.play")}
                    </Button>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("slides.motion.close")}
                    title={t("slides.motion.close")}
                    onClick={onClose}
                >
                    <X className="size-4 shrink-0" aria-hidden />
                </Button>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-3">
                <section className="flex flex-col gap-2">
                    <h3 className="text-[12px] font-medium text-muted-foreground">
                        {t("slides.motion.transition")}
                    </h3>
                    <Select
                        aria-label={t("slides.motion.transition")}
                        value={transition.kind}
                        disabled={!editable}
                        onValueChange={(kind) =>
                            onTransition([slideId], {
                                ...transition,
                                kind: kind as motion.TransitionKind
                            })
                        }
                        options={motion.TRANSITIONS.map((one) => ({
                            value: one,
                            label: t(`slides.motion.transitions.${one}`)
                        }))}
                    />
                    <SegmentedControl
                        aria-label={t("slides.motion.speed")}
                        size="sm"
                        value={transition.speed}
                        onValueChange={(speed) => onTransition([slideId], { ...transition, speed })}
                        options={motion.SPEEDS.map((one) => ({
                            value: one,
                            label: t(`slides.motion.speeds.${one}`),
                            disabled: !editable || transition.kind === "none"
                        }))}
                    />
                    <Button
                        variant="ghost"
                        size="sm"
                        className="self-start"
                        disabled={!editable || slideIds.length < 2}
                        onClick={() => onTransition(slideIds, transition)}
                    >
                        {t("slides.motion.applyToAll")}
                    </Button>
                </section>

                <section className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <h3 className="min-w-0 flex-1 truncate text-[12px] font-medium text-muted-foreground">
                            {t("slides.motion.animations")}
                        </h3>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={
                                !editable ||
                                targets.length === 0 ||
                                animations.length >= motion.ANIMATIONS_MAX
                            }
                            title={
                                targets.length === 0 ? t("slides.motion.chooseFirst") : undefined
                            }
                            onClick={add}
                        >
                            <Plus className="size-4 shrink-0" aria-hidden />
                            {t("slides.motion.add")}
                        </Button>
                    </div>
                    {animations.length === 0 ? (
                        <p className="text-[13px] text-muted-foreground">
                            {targets.length === 0
                                ? t("slides.motion.emptyChoose")
                                : t("slides.motion.emptyAdd")}
                        </p>
                    ) : (
                        <ol className="flex flex-col gap-2">
                            {animations.map((one, at) => {
                                const members = motion.membersOf(one.target, boxes);
                                const picked =
                                    members.length > 0 &&
                                    members.every((box) => chosen.some((c) => c.id === box.id));
                                return (
                                    <li
                                        key={one.id}
                                        className={cn(
                                            "flex min-w-0 flex-col gap-2 rounded-md border border-border p-2",
                                            picked && "border-primary"
                                        )}
                                    >
                                        <div className="flex min-w-0 items-center gap-1">
                                            <span
                                                className="w-5 shrink-0 text-center text-[12px] tabular-nums text-muted-foreground"
                                                title={
                                                    one.trigger === "onClick" && steps[at]
                                                        ? t("slides.motion.step", {
                                                              number: steps[at]
                                                          })
                                                        : undefined
                                                }
                                            >
                                                {one.trigger === "onClick" ? steps[at] : ""}
                                            </span>
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    "size-2 shrink-0 rounded-full",
                                                    CLASS_DOT[motion.classOf(one.effect)]
                                                )}
                                            />
                                            <button
                                                type="button"
                                                className="min-w-0 flex-1 truncate rounded px-1 text-left text-[13px] hover:bg-muted"
                                                title={nameOfTarget(one.target)}
                                                onClick={() =>
                                                    onChoose(members.map((box) => box.id))
                                                }
                                            >
                                                {nameOfTarget(one.target)}
                                            </button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("slides.motion.earlier")}
                                                title={t("slides.motion.earlier")}
                                                disabled={!editable || at === 0}
                                                onClick={() =>
                                                    onAnimations(
                                                        motion.moveAnimation(animations, one.id, -1)
                                                    )
                                                }
                                            >
                                                <ArrowUp className="size-4 shrink-0" aria-hidden />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("slides.motion.later")}
                                                title={t("slides.motion.later")}
                                                disabled={!editable || at === animations.length - 1}
                                                onClick={() =>
                                                    onAnimations(
                                                        motion.moveAnimation(animations, one.id, 1)
                                                    )
                                                }
                                            >
                                                <ArrowDown
                                                    className="size-4 shrink-0"
                                                    aria-hidden
                                                />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label={t("slides.motion.remove")}
                                                title={t("slides.motion.remove")}
                                                disabled={!editable}
                                                onClick={() =>
                                                    onAnimations(
                                                        animations.filter(
                                                            (other) => other.id !== one.id
                                                        )
                                                    )
                                                }
                                            >
                                                <Trash2 className="size-4 shrink-0" aria-hidden />
                                            </Button>
                                        </div>
                                        <EffectSelect
                                            value={one.effect}
                                            disabled={!editable}
                                            onChange={(effect) => patch(one.id, { effect })}
                                        />
                                        <Select
                                            aria-label={t("slides.motion.trigger")}
                                            value={one.trigger}
                                            disabled={!editable}
                                            onValueChange={(trigger) =>
                                                patch(one.id, {
                                                    trigger: trigger as motion.Trigger
                                                })
                                            }
                                            options={motion.TRIGGERS.map((trigger) => ({
                                                value: trigger,
                                                label: t(`slides.motion.triggers.${trigger}`)
                                            }))}
                                        />
                                        <div className="grid grid-cols-2 gap-2">
                                            <SecondsField
                                                label={t("slides.motion.duration")}
                                                ms={one.durationMs}
                                                min={motion.DURATION_MIN}
                                                max={motion.DURATION_MAX}
                                                disabled={!editable}
                                                onChange={(durationMs) =>
                                                    patch(one.id, { durationMs })
                                                }
                                            />
                                            <SecondsField
                                                label={t("slides.motion.delay")}
                                                ms={one.delayMs}
                                                min={0}
                                                max={motion.DELAY_MAX}
                                                disabled={!editable}
                                                onChange={(delayMs) => patch(one.id, { delayMs })}
                                            />
                                        </div>
                                    </li>
                                );
                            })}
                        </ol>
                    )}
                </section>
            </div>
        </aside>
    );
}

function EffectSelect({
    value,
    disabled,
    onChange
}: {
    value: motion.EffectKind;
    disabled: boolean;
    onChange: (effect: motion.EffectKind) => void;
}) {
    const t = useTranslations("office");
    return (
        <SelectRoot
            value={value}
            onValueChange={(next) => onChange(next as motion.EffectKind)}
            disabled={disabled}
        >
            <SelectTrigger aria-label={t("slides.motion.effect")}>
                <SelectValue>
                    <span className="truncate">{t(`slides.motion.effects.${value}`)}</span>
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {CLASS_EFFECTS.map(([kind, effects], at) => (
                    <SelectGroup key={kind}>
                        {at > 0 ? <SelectSeparator /> : null}
                        <SelectLabel className="flex items-center gap-2">
                            <span
                                aria-hidden
                                className={cn("size-2 shrink-0 rounded-full", CLASS_DOT[kind])}
                            />
                            {t(`slides.motion.classes.${kind}`)}
                        </SelectLabel>
                        {effects.map((effect) => (
                            <SelectItem key={effect} value={effect}>
                                {t(`slides.motion.effects.${effect}`)}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                ))}
            </SelectContent>
        </SelectRoot>
    );
}

/**
 * A time in seconds, typed. Stored in milliseconds; a value that is not a
 * number in range is marked as it is typed and never stored, and leaving the
 * field puts back the time that is.
 */
function SecondsField({
    label,
    ms,
    min,
    max,
    disabled,
    onChange
}: {
    label: string;
    ms: number;
    min: number;
    max: number;
    disabled: boolean;
    onChange: (ms: number) => void;
}) {
    const t = useTranslations("office");
    const shown = (value: number): string => String(Math.round(value / 10) / 100);
    const [typed, setTyped] = useState(shown(ms));
    const [focused, setFocused] = useState(false);
    useEffect(() => {
        if (!focused) setTyped(shown(ms));
    }, [ms, focused]);
    const read = (text: string): number | null => {
        const clean = text.trim().replace(",", ".");
        if (!/^\d+(\.\d+)?$/.test(clean)) return null;
        const value = Math.round(Number(clean) * 1000);
        return value >= min && value <= max ? value : null;
    };
    const wrong = read(typed) === null;
    const id = useId();
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="truncate text-[12px] text-muted-foreground">
                {label}
            </label>
            <Input
                id={id}
                value={typed}
                inputMode="decimal"
                disabled={disabled}
                aria-invalid={wrong}
                title={
                    wrong
                        ? t("slides.motion.secondsRange", {
                              min: shown(min),
                              max: shown(max)
                          })
                        : undefined
                }
                className={cn("tabular-nums", wrong && "border-danger")}
                onFocus={() => setFocused(true)}
                onBlur={() => {
                    setFocused(false);
                    setTyped(shown(ms));
                }}
                onChange={(event) => {
                    setTyped(event.target.value);
                    const value = read(event.target.value);
                    if (value !== null && value !== ms) onChange(value);
                }}
            />
        </div>
    );
}
