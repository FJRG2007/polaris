"use client";

/**
 * The temperature a unit is aiming for: drag it, or type it.
 *
 * In the panel it is a thermostat dial (`ThermostatDial`) with the target large
 * in the middle; in a row it is a slider beside the number. Dragging is for "a
 * bit warmer"; typing is for "27, please". So the number is itself a field: tap
 * it, type, and Enter or leaving it applies; Escape puts it back.
 *
 * What is typed is held to the unit's own range and step, the same rule the
 * service checks before anything is sent, and a value off either is refused and
 * said rather than quietly moved to the nearest one that fits. A drag sends the
 * value it is let go on, key presses are gathered for a moment and sent as one,
 * and a typed value goes at once. Either way the number shown is the one being
 * sent, and the screen above puts it back if the unit refuses.
 */

import { ControlSlider, cn } from "@polaris/ui";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import { useEffect, useId, useRef, useState } from "react";
import { ThermostatDial, type DialTone } from "./controls/thermostat-dial";
import type { ClimateSettings } from "../../lib/device-kinds";

/** How long a refusal stays under the field once it has been left. Long enough
 *  to read, short enough not to sit there describing a value nobody kept. */
const ISSUE_LINGER_MS = 5_000;

export function TemperatureTarget({
    name,
    settings,
    disabled,
    describedBy,
    onSet,
    variant = "row",
    tone = "idle",
    current = null
}: {
    /** The device's name, for every label read aloud. */
    name: string;
    settings: Pick<ClimateSettings, "target" | "min" | "max" | "step" | "unit">;
    disabled: boolean;
    describedBy?: string;
    onSet: (target: number) => void;
    /** `dial` is the panel's thermostat; `row` a slider that fits in a list. */
    variant?: "row" | "dial";
    /** What the unit is doing, which colours the dial. */
    tone?: DialTone;
    /** The room's temperature, shown under the target on the dial. */
    current?: number | null;
}) {
    const t = usePlacesT();
    const issueId = useId();

    // The target being dragged to, while it is held; null shows the unit's.
    const [live, setLive] = useState<number | null>(null);
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

    useEffect(
        () => () => {
            if (linger.current) clearTimeout(linger.current);
        },
        []
    );

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

    const shown = live ?? settings.target;
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
        // Already what it is set to: nothing to send.
        if (read.target === settings.target) return;
        send.current(read.target);
    };

    const typed = (text: string) => {
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

    const big = variant === "dial";
    const range = { min: settings.min, max: settings.max, step: settings.step };
    const valueText = (value: number) => kinds.temperatureText(value, settings.unit);
    const groupName = t("devicePanel.climate.targetName", { name });

    // The number beside the slider or in the dial's middle, or the field it
    // turns into.
    const numberField = (
        typing === null ? (
            <button
                ref={number}
                type="button"
                aria-label={buttonLabel}
                title={editLabel}
                disabled={disabled}
                onClick={open}
                className={cn(
                    "cursor-text rounded-md px-1 text-center font-medium tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
                    big ? "min-h-11 min-w-[6rem] text-4xl" : "h-11 min-w-[4.5rem] text-sm"
                )}
            >
                <span aria-live="polite">{shownText}</span>
            </button>
        ) : (
            <span
                className={cn(
                    "flex items-center justify-center gap-0.5 px-1",
                    big ? "min-h-11 min-w-[6rem]" : "h-11 min-w-[4.5rem]"
                )}
            >
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
                    onChange={(event) => typed(event.target.value)}
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
                    className={cn(
                        "bg-transparent text-center font-medium tabular-nums outline-none",
                        big ? "w-20 text-3xl" : "w-12 text-base sm:text-sm"
                    )}
                />
                <span className="text-sm text-muted-foreground" aria-hidden="true">
                    {unit}
                </span>
            </span>
        )
    );

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div
                role="group"
                aria-label={groupName}
                aria-describedby={describedBy}
                className={cn(
                    big ? "flex w-full justify-center" : "inline-flex min-w-0 items-center gap-2",
                    issue && !big && "rounded-md ring-1 ring-danger-edge"
                )}
            >
                {big ? (
                    <ThermostatDial
                        range={range}
                        value={settings.target}
                        tone={tone}
                        current={current}
                        label={groupName}
                        valueText={valueText}
                        disabled={disabled}
                        describedBy={describedBy}
                        onLive={setLive}
                        onCommit={(value) => send.current(value)}
                    >
                        <span className="text-xs text-muted-foreground">
                            {t("devicePanel.climate.target")}
                        </span>
                        {numberField}
                        {current !== null ? (
                            <span className="text-sm tabular-nums text-muted-foreground">
                                {t("devicePanel.climate.roomNow", {
                                    value: kinds.temperatureText(current, settings.unit)
                                })}
                            </span>
                        ) : null}
                    </ThermostatDial>
                ) : (
                    <>
                        <ControlSlider
                            {...range}
                            value={settings.target}
                            label={groupName}
                            valueText={valueText}
                            disabled={disabled}
                            describedBy={describedBy}
                            onLive={setLive}
                            onCommit={(value) => send.current(value)}
                            className="w-32 shrink-0"
                        />
                        {numberField}
                    </>
                )}
            </div>
            {issue ? (
                <p id={issueId} aria-live="polite" className="text-xs text-danger">
                    {issue}
                </p>
            ) : null}
        </div>
    );
}
