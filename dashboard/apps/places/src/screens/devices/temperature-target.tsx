"use client";

/**
 * The temperature a unit is aiming for: lower, raise, or type it.
 *
 * The buttons are for "a bit warmer". Typing is for "27, please" - from 20 that
 * is seven presses on a phone, and on a unit that steps by half a degree it is
 * fourteen. So the number between the buttons is itself a field: tap it, type,
 * and Enter or leaving it applies; Escape puts it back.
 *
 * What is typed is held to the unit's own range and step, the same rule the
 * service checks before anything is sent, and a value off either is refused and
 * said rather than quietly moved to the nearest one that fits. Presses of the
 * buttons are gathered for a moment and sent as one change; a typed value is
 * one change already and goes at once. Either way the number shown is the one
 * being sent, and the screen above puts it back if the unit refuses.
 */

import { Button, cn } from "@polaris/ui";
import { Minus, Plus } from "lucide-react";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { useEffect, useId, useRef, useState } from "react";
import type { ClimateSettings } from "../../lib/device-kinds";

/** How long the stepper waits for another press before it sends the total. */
const STEP_SETTLE_MS = 700;

/** How long a refusal stays under the field once it has been left. Long enough
 *  to read, short enough not to sit there describing a value nobody kept. */
const ISSUE_LINGER_MS = 5_000;

export function TemperatureTarget({
    name,
    settings,
    disabled,
    describedBy,
    onSet
}: {
    /** The device's name, for every label read aloud. */
    name: string;
    settings: Pick<ClimateSettings, "target" | "min" | "max" | "step" | "unit">;
    disabled: boolean;
    describedBy?: string;
    onSet: (target: number) => void;
}) {
    const t = usePlacesT();
    const issueId = useId();

    // The target as shown while a change is on its way; null whenever nothing
    // is waiting, so the device's own value is shown.
    const [draft, setDraft] = useState<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pending = useRef<number | null>(null);
    const send = useRef(onSet);
    send.current = onSet;

    /** What is in the field while it is being typed in, or null when it is the
     *  plain number between the buttons. */
    const [typing, setTyping] = useState<string | null>(null);
    /** Why the last value typed was not sent. */
    const [issue, setIssue] = useState<string | null>(null);
    const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
    const field = useRef<HTMLInputElement | null>(null);
    const number = useRef<HTMLButtonElement | null>(null);
    const refocus = useRef(false);

    const flush = () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        const target = pending.current;
        pending.current = null;
        setDraft(null);
        if (target !== null) send.current(target);
    };

    // Leaving with a change gathered sends it rather than dropping it: closing
    // the panel straight after pressing + is still pressing +.
    useEffect(
        () => () => {
            flush();
            if (linger.current) clearTimeout(linger.current);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- on the way out only.
        []
    );

    // Pressed back to where the device already is: nothing to send.
    const settled = settings.target;
    useEffect(() => {
        if (draft !== null && draft === settled && pending.current === settled) {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            pending.current = null;
            setDraft(null);
        }
    }, [draft, settled]);

    // Selected as it opens, so typing replaces the number rather than adding
    // to the end of it.
    useEffect(() => {
        if (typing !== null) field.current?.select();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only on opening.
    }, [typing !== null]);

    useEffect(() => {
        if (typing !== null || !refocus.current || disabled) return;
        refocus.current = false;
        const away = document.activeElement;
        if (!away || away === document.body) number.current?.focus();
    }, [typing, disabled]);

    const close = (keyboard: boolean) => {
        refocus.current = keyboard;
        setTyping(null);
    };

    const shown = draft ?? settings.target;
    const unit = `°${settings.unit}`;

    const say = (found: kinds.TypedTemperatureIssue): string => {
        if (found === "range")
            return t("devicePanel.climate.typedRange", {
                min: kinds.temperatureText(settings.min, settings.unit),
                max: kinds.temperatureText(settings.max, settings.unit)
            });
        if (found === "step")
            return t("devicePanel.climate.typedStep", {
                step: kinds.temperatureText(settings.step, settings.unit)
            });
        return t("devicePanel.climate.typedNumber");
    };

    const clearIssue = () => {
        if (linger.current) clearTimeout(linger.current);
        linger.current = null;
        setIssue(null);
    };

    const nudge = (direction: 1 | -1) => {
        clearIssue();
        const from = pending.current ?? settings.target ?? settings.min;
        const next =
            Math.round(
                Math.min(settings.max, Math.max(settings.min, from + direction * settings.step)) *
                    100
            ) / 100;
        if (next === (pending.current ?? settings.target)) return;
        pending.current = next;
        setDraft(next);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, STEP_SETTLE_MS);
    };

    const open = () => {
        if (disabled) return;
        clearIssue();
        setTyping(shown === null ? "" : String(shown));
    };

    /**
     * Apply what was typed. `leaving` is a blur: the field closes whatever was
     * in it, and a refusal stays underneath for a moment to say why nothing
     * changed. On Enter a refusal keeps the field open to be corrected.
     */
    const apply = (leaving: boolean) => {
        if (typing === null) return;
        const read = kinds.typedTemperature(typing, settings);
        if (read === null) {
            close(!leaving);
            return;
        }
        if ("issue" in read) {
            setIssue(say(read.issue));
            if (leaving) {
                close(false);
                linger.current = setTimeout(() => setIssue(null), ISSUE_LINGER_MS);
            }
            return;
        }
        close(!leaving);
        clearIssue();
        // Already what it is set to, or already on its way: nothing to send.
        if (read.target === (pending.current ?? settings.target)) return;
        pending.current = read.target;
        setDraft(read.target);
        flush();
    };

    const live = (text: string) => {
        setTyping(text);
        const read = kinds.typedTemperature(text, settings);
        // Said while typing, except for a number that is only too small because
        // it is not finished yet.
        setIssue(
            read !== null && "issue" in read && !kinds.mayStillGrow(text, settings)
                ? say(read.issue)
                : null
        );
    };

    const editLabel = t("devicePanel.climate.typeTarget", { name });
    const shownText = shown === null ? "-" : kinds.temperatureText(shown, settings.unit);
    // The number is the button's whole content, so its name has to carry it:
    // a name that only said "type the target" would hide the target itself
    // from anybody listening to the page.
    const buttonLabel = t("devicePanel.climate.typeTargetNow", { name, value: shownText });

    return (
        <div className="flex flex-col gap-1">
            <div
                role="group"
                aria-label={t("devicePanel.climate.targetName", { name })}
                aria-describedby={describedBy}
                className={cn(
                    "inline-flex h-8 items-center rounded-md border border-border",
                    issue && "border-danger-edge"
                )}
            >
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-full rounded-r-none px-2"
                    aria-label={t("devicePanel.climate.lower", { name })}
                    title={t("devicePanel.climate.lower", { name })}
                    disabled={disabled || (shown !== null && shown <= settings.min)}
                    onClick={() => nudge(-1)}
                >
                    <Minus className="size-4" aria-hidden="true" />
                </Button>
                {typing === null ? (
                    <button
                        ref={number}
                        type="button"
                        aria-label={buttonLabel}
                        title={editLabel}
                        disabled={disabled}
                        onClick={open}
                        className="h-full min-w-[4.5rem] cursor-text px-1 text-center text-sm font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    >
                        <span aria-live="polite">{shownText}</span>
                    </button>
                ) : (
                    <span className="flex h-full min-w-[4.5rem] items-center justify-center gap-0.5 px-1">
                        <input
                            ref={field}
                            autoFocus
                            type="text"
                            // A keypad with a decimal key on a phone. Not
                            // type="number": that one refuses "24,5" outright
                            // in a browser set to English and turns the wheel
                            // into a second stepper.
                            inputMode="decimal"
                            enterKeyHint="done"
                            autoComplete="off"
                            aria-label={editLabel}
                            aria-invalid={issue ? true : undefined}
                            aria-describedby={issue ? issueId : undefined}
                            value={typing}
                            onChange={(event) => live(event.target.value)}
                            onBlur={() => apply(true)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    apply(false);
                                } else if (event.key === "Escape") {
                                    // Kept from the dialog around it: Escape
                                    // here means "not that number", not
                                    // "close the panel".
                                    event.preventDefault();
                                    event.stopPropagation();
                                    clearIssue();
                                    close(true);
                                }
                            }}
                            // 16px on a phone, or the browser zooms the page
                            // in to show the field and leaves it zoomed.
                            className="w-12 bg-transparent text-center text-base font-medium tabular-nums outline-none sm:text-sm"
                        />
                        <span className="text-sm text-muted-foreground" aria-hidden="true">
                            {unit}
                        </span>
                    </span>
                )}
                <Button
                    size="sm"
                    variant="ghost"
                    className="h-full rounded-l-none px-2"
                    aria-label={t("devicePanel.climate.raise", { name })}
                    title={t("devicePanel.climate.raise", { name })}
                    disabled={disabled || (shown !== null && shown >= settings.max)}
                    onClick={() => nudge(1)}
                >
                    <Plus className="size-4" aria-hidden="true" />
                </Button>
            </div>
            {issue ? (
                <p id={issueId} aria-live="polite" className="text-xs text-danger">
                    {issue}
                </p>
            ) : null}
        </div>
    );
}
