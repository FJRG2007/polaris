"use client";

/**
 * The fields inside the editor's node cards: which device, which of its states,
 * which days, how long. Each is the design system's own control, never a native
 * select, and each takes the complaint for its own value so the error sits under
 * the field it is about.
 */

import { weekdayNames } from "@polaris/core";
import { usePlacesT } from "../use-places-t";
import * as kinds from "../../lib/device-kinds";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { DeviceView } from "../../lib/device-kinds";
import { Button, Input, Select, cn, type SelectOption } from "@polaris/ui";
import { createContext, useContext, useId, useState, type ReactNode } from "react";

/** Where the complaints for the node being drawn are looked up. */
export interface IssueLookup {
    (path: readonly (string | number)[]): string | undefined;
}

const IssueContext = createContext<IssueLookup>(() => undefined);

export const IssueProvider = IssueContext.Provider;

export function useIssue(path: readonly (string | number)[]): string | undefined {
    return useContext(IssueContext)(path);
}

/** A label, the control, and the complaint about it. A `*` marks what has to be
 *  filled in, so an empty one reads as unfinished rather than wrong. */
export function Field({
    label,
    path,
    required,
    className,
    children
}: {
    label: string;
    path: readonly (string | number)[];
    required?: boolean;
    className?: string;
    children: (id: string, invalid: boolean) => ReactNode;
}) {
    const id = useId();
    const issue = useIssue(path);
    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <label htmlFor={id} className="text-[0.6875rem] font-medium text-muted-foreground">
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </label>
            {children(id, issue !== undefined)}
            {issue && (
                <p id={`${id}-issue`} className="text-[0.6875rem] text-danger">
                    {issue}
                </p>
            )}
        </div>
    );
}

/** One card in the flow: its kind, its fields, and the buttons that move it. */
export function NodeCard({
    number,
    kind,
    onRemove,
    onUp,
    onDown,
    removeLabel,
    upLabel,
    downLabel,
    disabled,
    children
}: {
    number?: number;
    kind: ReactNode;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
    removeLabel: string;
    upLabel: string;
    downLabel: string;
    disabled?: boolean;
    children?: ReactNode;
}) {
    return (
        <div className="relative flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
                {number !== undefined && (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
                        {number}
                    </span>
                )}
                <div className="min-w-0 flex-1">{kind}</div>
                {!disabled && (
                    <span className="flex shrink-0 items-center">
                        {onUp && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-7 p-0"
                                aria-label={upLabel}
                                title={upLabel}
                                onClick={onUp}
                            >
                                <ArrowUp className="size-3.5" />
                            </Button>
                        )}
                        {onDown && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-7 p-0"
                                aria-label={downLabel}
                                title={downLabel}
                                onClick={onDown}
                            >
                                <ArrowDown className="size-3.5" />
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            aria-label={removeLabel}
                            title={removeLabel}
                            onClick={onRemove}
                        >
                            <X className="size-3.5" />
                        </Button>
                    </span>
                )}
            </div>
            {children && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>}
        </div>
    );
}

/** Which device. A device that is no longer at this place stays named as gone
 *  rather than the picker going blank, so the reader sees what to replace. */
export function DevicePicker({
    devices,
    value,
    onChange,
    path,
    label,
    disabled,
    empty
}: {
    devices: readonly DeviceView[];
    value: string;
    onChange: (device: DeviceView) => void;
    path: readonly (string | number)[];
    label: string;
    disabled?: boolean;
    /** What to say when there is nothing to choose from. */
    empty: string;
}) {
    const t = usePlacesT();
    const options: SelectOption[] = devices.map((device) => ({
        value: device.id,
        label: device.zone ? `${device.name} - ${device.zone}` : device.name
    }));
    if (value && !devices.some((device) => device.id === value)) {
        options.unshift({ value, label: t("automations.missingDevice"), disabled: true });
    }
    return (
        <Field label={label} path={[...path, "deviceId"]} required>
            {(id, invalid) =>
                devices.length === 0 && !value ? (
                    <p id={id} className="text-xs text-muted-foreground">
                        {empty}
                    </p>
                ) : (
                    <Select
                        id={id}
                        value={value}
                        disabled={disabled}
                        placeholder={t("automations.fields.chooseDevice")}
                        options={options}
                        className={invalid ? "border-danger-edge" : undefined}
                        onValueChange={(next) => {
                            const device = devices.find((entry) => entry.id === next);
                            if (device) onChange(device);
                        }}
                    />
                )
            }
        </Field>
    );
}

/** Which part of a device - its own state, its door, its reading - when it has
 *  more than one. Nothing is drawn for a device with one. */
export function AttributePicker({
    kind,
    value,
    onChange,
    path,
    disabled
}: {
    kind: string;
    value: auto.AutomationAttribute;
    onChange: (attribute: auto.AutomationAttribute) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const offered = auto.attributesFor(kind);
    if (offered.length < 2) return null;
    return (
        <Field label={t("automations.fields.watch")} path={[...path, "attribute"]}>
            {(id) => (
                <Select
                    id={id}
                    value={value}
                    disabled={disabled}
                    options={offered.map((attribute) => ({ value: attribute, label: words.attributeText(attribute, t) }))}
                    onValueChange={(next) => onChange(next as auto.AutomationAttribute)}
                />
            )}
        </Field>
    );
}

/** Radix will not take an empty value, so "any" travels as this and is stored
 *  as the empty string the schema reads as "any". */
const ANY = "__any";

/**
 * A value of one attribute of one device: a state from the ones that kind has,
 * a door word, or a sensor's reading - offered as the words it sends where it is
 * one of the known pairs, and typed where it is a number or a word of its own.
 */
export function ValuePicker({
    device,
    attribute,
    value,
    onChange,
    path,
    field,
    label,
    allowAny,
    disabled
}: {
    device: DeviceView | undefined;
    attribute: auto.AutomationAttribute;
    value: string;
    onChange: (value: string) => void;
    path: readonly (string | number)[];
    field: string;
    label: string;
    allowAny?: boolean;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const kind = device?.kind ?? "";
    const reading = device?.reading?.value ?? "";
    const offered: string[] =
        attribute === "state"
            ? [...auto.watchedStates(kind)]
            : attribute === "door"
              ? [...auto.DOOR_WORDS]
              : [...auto.readingWordsFor(reading)];
    if (value && !offered.includes(value) && attribute === "reading" && offered.length > 0) offered.push(value);

    if (attribute === "reading" && offered.length === 0) {
        return (
            <Field label={label} path={[...path, field]} required={!allowAny}>
                {(id, invalid) => (
                    <Input
                        id={id}
                        value={value}
                        disabled={disabled}
                        maxLength={auto.LIMITS.word}
                        placeholder={allowAny ? t("automations.anyValue") : reading || t("automations.fields.typeValue")}
                        aria-invalid={invalid || undefined}
                        onChange={(event) => onChange(event.target.value)}
                    />
                )}
            </Field>
        );
    }

    const options: SelectOption[] = offered.map((word) => ({
        value: word,
        label: words.valueText(attribute, kind, word, t)
    }));
    if (allowAny) options.unshift({ value: ANY, label: t("automations.anyValue") });
    return (
        <Field label={label} path={[...path, field]} required={!allowAny}>
            {(id, invalid) => (
                <Select
                    id={id}
                    value={value || (allowAny ? ANY : "")}
                    disabled={disabled || !device}
                    placeholder={t("automations.fields.chooseValue")}
                    options={options}
                    className={invalid ? "border-danger-edge" : undefined}
                    onValueChange={(next) => onChange(next === ANY ? "" : next)}
                />
            )}
        </Field>
    );
}

/** The days a thing applies on, Monday first, as a row of toggles. */
export function DaysPicker({
    days,
    onChange,
    path,
    disabled
}: {
    days: readonly number[];
    onChange: (days: number[]) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const names = weekdayNames(t.locale, "short");
    const long = weekdayNames(t.locale, "long");
    const order = [1, 2, 3, 4, 5, 6, 0];
    const issue = useIssue([...path, "days"]);
    return (
        <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("automations.fields.days")}
                <span aria-hidden="true"> *</span>
            </span>
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("automations.fields.days")}>
                {order.map((day) => {
                    const on = days.includes(day);
                    return (
                        <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            aria-label={long[day]}
                            title={long[day]}
                            disabled={disabled}
                            onClick={() => onChange(on ? days.filter((entry) => entry !== day) : [...days, day])}
                            className={cn(
                                "h-7 min-w-9 rounded-md border px-2 text-xs transition-colors duration-fast disabled:opacity-50",
                                on
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border bg-field text-muted-foreground hover:border-border-strong"
                            )}
                        >
                            {names[day]}
                        </button>
                    );
                })}
            </div>
            {issue && <p className="text-[0.6875rem] text-danger">{issue}</p>}
        </div>
    );
}

/** A number typed into a field, where an empty field is a missing number rather
 *  than zero. */
export function NumberField({
    label,
    path,
    field,
    value,
    onChange,
    suffix,
    min,
    step,
    disabled
}: {
    label: string;
    path: readonly (string | number)[];
    field: string;
    value: number;
    onChange: (value: number) => void;
    suffix?: string;
    min?: number;
    step?: number | "any";
    disabled?: boolean;
}) {
    return (
        <Field label={label} path={[...path, field]} required>
            {(id, invalid) => (
                <div className="flex items-center gap-2">
                    <Input
                        id={id}
                        type="number"
                        inputMode="decimal"
                        min={min}
                        step={step}
                        disabled={disabled}
                        value={Number.isFinite(value) ? String(value) : ""}
                        aria-invalid={invalid || undefined}
                        onChange={(event) =>
                            onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))
                        }
                    />
                    {suffix && <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>}
                </div>
            )}
        </Field>
    );
}

export function ClockField({
    label,
    path,
    field,
    value,
    onChange,
    disabled
}: {
    label: string;
    path: readonly (string | number)[];
    field: string;
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
}) {
    return (
        <Field label={label} path={[...path, field]} required>
            {(id, invalid) => (
                <Input
                    id={id}
                    type="time"
                    step={60}
                    disabled={disabled}
                    value={value}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => onChange(event.target.value)}
                />
            )}
        </Field>
    );
}

type Unit = "seconds" | "minutes" | "hours";
const UNIT_SECONDS: Readonly<Record<Unit, number>> = { seconds: 1, minutes: 60, hours: 3600 };

function unitOf(seconds: number): Unit {
    if (Number.isFinite(seconds) && seconds > 0 && seconds % 3600 === 0) return "hours";
    if (Number.isFinite(seconds) && seconds > 0 && seconds % 60 === 0) return "minutes";
    return Number.isFinite(seconds) ? "seconds" : "minutes";
}

/** A span of time as an amount and a unit, stored as seconds. The unit is the
 *  field's own: switching it keeps the amount and changes what it means, which
 *  is what somebody switching "5 minutes" to "hours" wants. */
export function DurationField({
    label,
    path,
    field,
    seconds,
    onChange,
    disabled
}: {
    label: string;
    path: readonly (string | number)[];
    field: string;
    seconds: number;
    onChange: (seconds: number) => void;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const [unit, setUnit] = useState<Unit>(() => unitOf(seconds));
    const amount = Number.isFinite(seconds) ? seconds / UNIT_SECONDS[unit] : Number.NaN;
    return (
        <Field label={label} path={[...path, field]} required>
            {(id, invalid) => (
                <div className="flex items-center gap-2">
                    <Input
                        id={id}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        disabled={disabled}
                        className="min-w-0 flex-1"
                        value={Number.isFinite(amount) ? String(amount) : ""}
                        aria-invalid={invalid || undefined}
                        onChange={(event) =>
                            onChange(
                                event.target.value === ""
                                    ? Number.NaN
                                    : Math.round(Number(event.target.value) * UNIT_SECONDS[unit])
                            )
                        }
                    />
                    <Select
                        value={unit}
                        disabled={disabled}
                        className="w-28 shrink-0"
                        aria-label={t("automations.fields.unit")}
                        options={(["seconds", "minutes", "hours"] as const).map((entry) => ({
                            value: entry,
                            label: t(`automations.fields.units.${entry}`)
                        }))}
                        onValueChange={(next) => {
                            const chosen = next as Unit;
                            setUnit(chosen);
                            if (Number.isFinite(amount)) onChange(Math.round(amount * UNIT_SECONDS[chosen]));
                        }}
                    />
                </div>
            )}
        </Field>
    );
}

/** Whether a device can be told to do anything a step could ask. */
export function operable(device: DeviceView): boolean {
    return device.controllable && auto.stepActionsFor(device.kind).length > 0;
}

/** Whether a device has anything a trigger, a condition or a wait can watch. */
export function watchable(device: DeviceView): boolean {
    return kinds.deviceKind(device.kind) === "sensor" || auto.watchedStates(device.kind).length > 0;
}
