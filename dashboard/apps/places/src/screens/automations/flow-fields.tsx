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
import type { DeviceView } from "../../lib/device-kinds";
import { Field, useIssue } from "@polaris/ui/automation";
import { Button, Input, Select, cn, type SelectOption } from "@polaris/ui";
import { Plus, X } from "lucide-react";
import { createContext, useContext, useState } from "react";
import type { RoomView } from "../../lib/room-kinds";

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

/** The devices a set can add to `first`: the same kind of device, so every one
 *  of them answers what the block asks. */
export function setCandidates(
    devices: readonly DeviceView[],
    first: DeviceView | undefined
): DeviceView[] {
    if (!first) return [];
    const kind = kinds.deviceKind(first.kind);
    return devices.filter((device) => kinds.deviceKind(device.kind) === kind);
}

/**
 * The rest of a block's devices, after its first: one picker each with a button
 * to take it off, a button to add another of the same kind, and - once there
 * are two or more - how the set counts: each, the first or all of them for a
 * trigger, any or all of them for a condition.
 */
export function TargetSetField({
    ids,
    devices,
    first,
    role,
    count,
    onChange,
    path,
    disabled
}: {
    /** Every device of the block, its first included. */
    ids: readonly string[];
    devices: readonly DeviceView[];
    first: DeviceView | undefined;
    /** A step's set has no way to count: every device of it is told. */
    role: "trigger" | "condition" | "step";
    /** How the set counts, as stored; absent is each, or any. */
    count: auto.Behaviour | auto.Quantifier | undefined;
    onChange: (ids: string[], count: auto.Behaviour | auto.Quantifier | undefined) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const candidates = setCandidates(devices, first);
    if (!first || (candidates.length < 2 && ids.length < 2)) return null;
    const rest = ids.slice(1);
    const free = candidates.filter((device) => !ids.includes(device.id));
    const label = (device: DeviceView) =>
        device.zone ? `${device.name} - ${device.zone}` : device.name;
    return (
        <>
            {rest.map((id, index) => {
                const options: SelectOption[] = candidates
                    .filter((device) => device.id === id || !ids.includes(device.id))
                    .map((device) => ({ value: device.id, label: label(device) }));
                if (!candidates.some((device) => device.id === id)) {
                    options.unshift({
                        value: id,
                        label: t("automations.missingDevice"),
                        disabled: true
                    });
                }
                return (
                    <Field
                        key={id}
                        label={t("automations.fields.alsoDevice")}
                        path={[...path, "targets", index + 1, "id"]}
                    >
                        {(fieldId, invalid) => (
                            <div className="flex min-w-0 items-center gap-1">
                                <Select
                                    id={fieldId}
                                    value={id}
                                    disabled={disabled}
                                    options={options}
                                    className={cn(
                                        "min-w-0 flex-1",
                                        invalid && "border-danger-edge"
                                    )}
                                    onValueChange={(next) =>
                                        onChange(
                                            ids.map((entry) => (entry === id ? next : entry)),
                                            count
                                        )
                                    }
                                />
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    className="size-8 shrink-0 p-0"
                                    aria-label={t("automations.fields.removeDevice")}
                                    title={t("automations.fields.removeDevice")}
                                    disabled={disabled}
                                    onClick={() => {
                                        const next = ids.filter((entry) => entry !== id);
                                        onChange(next, next.length > 1 ? count : undefined);
                                    }}
                                >
                                    <X className="size-4" />
                                </Button>
                            </div>
                        )}
                    </Field>
                );
            })}
            {ids.length > 1 && role !== "step" && (
                <SetCountField
                    role={role}
                    count={count}
                    path={path}
                    disabled={disabled}
                    onChange={(next) => onChange([...ids], next)}
                />
            )}
            {free.length > 0 && ids.length < auto.LIMITS.targets && (
                <div className="flex items-end sm:col-span-2">
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => onChange([...ids, free[0]!.id], count)}
                    >
                        <Plus className="size-4" />
                        {t("automations.fields.addDevice")}
                    </Button>
                </div>
            )}
        </>
    );
}

/** How a set counts: each, the first or all of its devices for a trigger, any
 *  or all of them for a condition. */
export function SetCountField({
    role,
    count,
    onChange,
    path,
    disabled
}: {
    role: "trigger" | "condition";
    count: auto.Behaviour | auto.Quantifier | undefined;
    onChange: (count: auto.Behaviour | auto.Quantifier) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const counts: SelectOption[] =
        role === "trigger"
            ? (["each", "first", "all"] as const).map((value) => ({
                  value,
                  label: t(`automations.fields.behaviours.${value}`)
              }))
            : (["any", "all"] as const).map((value) => ({
                  value,
                  label: t(`automations.fields.quantifiers.${value}`)
              }));
    return (
        <Field
            label={t(
                role === "trigger"
                    ? "automations.fields.behaviour"
                    : "automations.fields.quantifier"
            )}
            path={[...path, role === "trigger" ? "behaviour" : "quantifier"]}
        >
            {(fieldId) => (
                <Select
                    id={fieldId}
                    value={count ?? (role === "trigger" ? "each" : "any")}
                    disabled={disabled}
                    options={counts}
                    onValueChange={(next) => onChange(next as auto.Behaviour | auto.Quantifier)}
                />
            )}
        </Field>
    );
}

const RoomsContext = createContext<readonly RoomView[]>([]);

/** The place's rooms, for every picker that can name one. */
export const RoomsProvider = RoomsContext.Provider;

export function useRooms(): readonly RoomView[] {
    return useContext(RoomsContext);
}

/** A room's name as a picker shows it: on its floor, where it has one. */
export function roomLabel(room: RoomView, t: ReturnType<typeof usePlacesT>): string {
    return room.floor
        ? t("automations.add.roomOnFloor", { floor: room.floor, room: room.name })
        : room.name;
}

/** The floors the rooms are on, each once, by name. */
export function floorsOf(rooms: readonly RoomView[]): { id: string; name: string }[] {
    const found = new Map<string, string>();
    for (const room of rooms) if (room.floorId && room.floor) found.set(room.floorId, room.floor);
    return [...found.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The picker value of a block's room or floor: "room:<id>", "floor:<id>", or
 *  empty for the devices it names. */
export function placeValue(block: {
    readonly targets?: readonly { readonly kind: string; readonly id: string }[];
}): string {
    const [first] = auto.placeTargets(block);
    return first ? `${first.kind}:${first.id}` : "";
}

/**
 * Which devices a block is about: the ones picked, or every device in a room or
 * on a floor that answers it - read again each time, so a lamp moved into the
 * kitchen counts for the kitchen from then on. Drawn only where the place has
 * rooms. Picking a room keeps the device as the one its choices are drawn from,
 * and how the set counts.
 */
export function PlaceTargetField<
    T extends {
        readonly deviceId: string;
        readonly targets?: readonly { readonly kind: string; readonly id: string }[];
        readonly behaviour?: auto.Behaviour;
        readonly quantifier?: auto.Quantifier;
    }
>({
    block,
    role,
    onChange,
    path,
    disabled
}: {
    block: T;
    /** Absent for a step, which has no way to count. */
    role?: "trigger" | "condition";
    onChange: (block: T) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const rooms = useRooms();
    if (rooms.length === 0) return null;
    const value = placeValue(block);
    const options: SelectOption[] = [
        { value: "", label: t("automations.fields.whereChosen") },
        ...floorsOf(rooms).map((floor) => ({
            value: `floor:${floor.id}`,
            label: t("automations.fields.wholeFloor", { floor: floor.name })
        })),
        ...rooms.map((room) => ({
            value: `room:${room.id}`,
            label: t("automations.fields.wholeRoom", { room: roomLabel(room, t) })
        }))
    ];
    if (value && !options.some((option) => option.value === value)) {
        options.push({ value, label: t("automations.fields.placeGone"), disabled: true });
    }
    const field = role === "trigger" ? "behaviour" : "quantifier";
    const pick = (next: string) => {
        const { targets: _was, behaviour: _b, quantifier: _q, ...rest } = block;
        if (!next) {
            onChange(rest as unknown as T);
            return;
        }
        const [kind, id] = next.split(":") as ["room" | "floor", string];
        const counted = role === "trigger" ? block.behaviour : block.quantifier;
        onChange({
            ...rest,
            targets: [{ kind, id }],
            ...(counted && role ? { [field]: counted } : {})
        } as unknown as T);
    };
    return (
        <>
            <Field label={t("automations.fields.where")} path={[...path, "targets", 0, "id"]}>
                {(fieldId, invalid) => (
                    <Select
                        id={fieldId}
                        value={value}
                        disabled={disabled}
                        options={options}
                        className={invalid ? "border-danger-edge" : undefined}
                        onValueChange={pick}
                    />
                )}
            </Field>
            {value && role && (
                <SetCountField
                    role={role}
                    count={role === "trigger" ? block.behaviour : block.quantifier}
                    path={path}
                    disabled={disabled}
                    onChange={(count) => onChange({ ...block, [field]: count } as T)}
                />
            )}
        </>
    );
}

/** Which part of a device - its own state, its door, its reading - when it has
 *  more than one. Nothing is drawn for a device with one. */
export function AttributePicker({
    kind,
    device,
    value,
    onChange,
    path,
    disabled
}: {
    kind: string;
    /** Whether it has a battery, so the battery is offered only where it does. */
    device?: auto.BatteryReport;
    value: auto.AutomationAttribute;
    onChange: (attribute: auto.AutomationAttribute) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const offered = withSaved(auto.attributesFor(kind, device), value);
    if (offered.length < 2) return null;
    return (
        <Field label={t("automations.fields.watch")} path={[...path, "attribute"]}>
            {(id) => (
                <Select
                    id={id}
                    value={value}
                    disabled={disabled}
                    options={offered.map((attribute) => ({
                        value: attribute,
                        label: words.attributeText(attribute, t)
                    }))}
                    onValueChange={(next) => onChange(next as auto.AutomationAttribute)}
                />
            )}
        </Field>
    );
}

/** What a block looks at on a device: one of its attributes, compared as a
 *  word, or one of its figures, compared as a number. */
export type WatchChoice =
    | { readonly attribute: auto.AutomationAttribute }
    | { readonly figure: auto.ReadingMeasure | undefined };

/** A figure travels through the picker as this and the measure, or nothing for
 *  the device's one reading. */
const FIGURE = "figure:";

/**
 * The Watch picker for every block that reads a device: its attributes and its
 * figures in one list, so the temperature is beside the mode rather than behind
 * another kind of block. A figure is compared as a number and an attribute as a
 * word, so the editor turns a block into the other kind when the choice crosses
 * over; this only reports which was picked.
 */
export function WatchPicker({
    device,
    value,
    onChange,
    path,
    disabled
}: {
    device: DeviceView;
    value: WatchChoice;
    onChange: (choice: WatchChoice) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const attributes = withSaved(
        auto.attributesFor(device.kind, device),
        "attribute" in value ? value.attribute : undefined
    );
    const figures = [...auto.figuresFor(device.kind, device.reading?.value)];
    // A block saved on a figure the device no longer offers (a sensor now
    // reading a word) keeps it in the list rather than showing a blank.
    if ("figure" in value && !figures.includes(value.figure)) figures.push(value.figure);
    const options: SelectOption[] = [
        ...attributes.map((attribute) => ({
            value: attribute,
            label: words.attributeText(attribute, t)
        })),
        ...figures.map((measure) => ({
            value: `${FIGURE}${measure ?? ""}`,
            label: words.figureOptionText(device.kind, measure, t)
        }))
    ];
    if (options.length < 2) return null;
    const figure = "figure" in value;
    return (
        <Field
            label={t("automations.fields.watch")}
            path={[...path, figure ? "measure" : "attribute"]}
            required={figure}
        >
            {(id, invalid) => (
                <Select
                    id={id}
                    value={figure ? `${FIGURE}${value.figure ?? ""}` : value.attribute}
                    disabled={disabled}
                    className={invalid ? "border-danger-edge" : undefined}
                    options={options}
                    onValueChange={(next) => {
                        if (next.startsWith(FIGURE)) {
                            const name = next.slice(FIGURE.length);
                            const index = figures.findIndex((entry) => (entry ?? "") === name);
                            if (index >= 0) onChange({ figure: figures[index] });
                            return;
                        }
                        const attribute = attributes.find((entry) => entry === next);
                        if (attribute) onChange({ attribute });
                    }}
                />
            )}
        </Field>
    );
}

/** The attributes offered, with one a block was saved on kept in the list - a
 *  battery the device stopped reporting - rather than showing a blank. */
function withSaved(
    offered: readonly auto.AutomationAttribute[],
    saved: auto.AutomationAttribute | undefined
): readonly auto.AutomationAttribute[] {
    return saved && !offered.includes(saved) ? [...offered, saved] : offered;
}

/** What a device's attribute is right now, where the editor can tell: a state,
 *  a door, a mode or a reading's word. Empty where it cannot. */
export function currentValue(device: DeviceView, attribute: auto.AutomationAttribute): string {
    if (attribute === "online") return device.online ? "online" : "offline";
    if (attribute === "battery") return auto.batteryWord(device);
    if (attribute === "state") return device.state;
    if (attribute === "door") return device.doorState;
    if (attribute === "mode") return device.climate?.mode ?? device.air?.mode ?? "";
    if (attribute === "reading") return device.reading?.value ?? "";
    return "";
}

/** What a figure is counted in, for the field beside it. */
export function measureSuffix(
    measure: auto.ReadingMeasure | undefined,
    fallback: string | undefined
): string | undefined {
    if (!measure) return fallback || undefined;
    if (measure === "filter") return "%";
    if (measure === "quality") return undefined;
    return kinds.MEASURE_UNITS[measure] || undefined;
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
              : attribute === "mode"
                ? kinds.deviceKind(kind) === "air"
                    ? [...(device?.air?.modes ?? kinds.AIR_MODES)]
                    : [...(device?.climate?.modes ?? kinds.CLIMATE_MODES)]
                : attribute === "filter"
                  ? [...kinds.FILTER_STATES]
                  : attribute === "online"
                    ? [...auto.AVAILABILITY_WORDS]
                    : attribute === "battery"
                      ? [...auto.BATTERY_WORDS]
                      : [...auto.readingWordsFor(reading)];
    if (value && !offered.includes(value) && attribute === "reading" && offered.length > 0)
        offered.push(value);

    if (attribute === "reading" && offered.length === 0) {
        return (
            <Field label={label} path={[...path, field]} required={!allowAny}>
                {(id, invalid) => (
                    <Input
                        id={id}
                        value={value}
                        disabled={disabled}
                        maxLength={auto.LIMITS.word}
                        placeholder={
                            allowAny
                                ? t("automations.anyValue")
                                : reading || t("automations.fields.typeValue")
                        }
                        aria-invalid={invalid || undefined}
                        onChange={(event) => onChange(event.target.value)}
                    />
                )}
            </Field>
        );
    }

    const options: SelectOption[] = offered.map((word) => ({
        value: word,
        label:
            attribute === "battery"
                ? words.batteryValueText(word, device, t)
                : words.valueText(attribute, kind, word, t)
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
            <div
                className="flex flex-wrap gap-1"
                role="group"
                aria-label={t("automations.fields.days")}
            >
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
                            onClick={() =>
                                onChange(
                                    on ? days.filter((entry) => entry !== day) : [...days, day]
                                )
                            }
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

/** A typed number never narrows below about five digits: the row it sits in
 *  wraps its unit or suffix onto the next line before it squeezes the value. */
const NUMBER_INPUT = "min-w-[5rem] flex-[1_1_5rem]";

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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <Input
                        id={id}
                        type="number"
                        inputMode="decimal"
                        className={NUMBER_INPUT}
                        min={min}
                        step={step}
                        disabled={disabled}
                        value={Number.isFinite(value) ? String(value) : ""}
                        aria-invalid={invalid || undefined}
                        onChange={(event) =>
                            onChange(
                                event.target.value === "" ? Number.NaN : Number(event.target.value)
                            )
                        }
                    />
                    {suffix && (
                        <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span>
                    )}
                </div>
            )}
        </Field>
    );
}

/**
 * The value a figure is compared with: a number, or - for air quality - one of
 * its levels, kept as the rank the engine compares.
 */
export function FigureField({
    measure,
    label,
    path,
    field = "value",
    value,
    onChange,
    suffix,
    disabled
}: {
    measure: auto.ReadingMeasure | undefined;
    label: string;
    path: readonly (string | number)[];
    /** The block's own field this figure is, for its error and its label. */
    field?: string;
    value: number;
    onChange: (value: number) => void;
    suffix?: string;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    if (measure !== "quality") {
        return (
            <NumberField
                label={label}
                path={path}
                field={field}
                value={value}
                step="any"
                suffix={suffix}
                disabled={disabled}
                onChange={onChange}
            />
        );
    }
    const level = kinds.airQualityAt(value);
    return (
        <Field label={label} path={[...path, field]} required>
            {(id, invalid) => (
                <Select
                    id={id}
                    value={level ? String(value) : ""}
                    disabled={disabled}
                    placeholder={t("automations.fields.chooseValue")}
                    className={invalid ? "border-danger-edge" : undefined}
                    options={kinds.AIR_QUALITY_LEVELS.map((entry) => ({
                        value: String(kinds.airQualityRank(entry)),
                        label: kinds.airQualityText(entry, t)
                    }))}
                    onValueChange={(next) => onChange(Number(next))}
                />
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

type Unit = "seconds" | "minutes" | "hours" | "days";
const UNIT_SECONDS: Readonly<Record<Unit, number>> = {
    seconds: 1,
    minutes: 60,
    hours: 3600,
    days: 86400
};

/** The units a span is offered in, by what it is stored as: a span kept in
 *  whole minutes has no seconds to offer. */
const UNITS: Readonly<Record<"seconds" | "minutes", readonly Unit[]>> = {
    seconds: ["seconds", "minutes", "hours"],
    minutes: ["minutes", "hours", "days"]
};

function unitOf(seconds: number, offered: readonly Unit[]): Unit {
    const fits = [...offered]
        .reverse()
        .find(
            (unit) => Number.isFinite(seconds) && seconds > 0 && seconds % UNIT_SECONDS[unit] === 0
        );
    return fits ?? offered[0]!;
}

/**
 * A span of time as an amount and a unit - every "for", "every", "wait" and
 * "give up after" in the editor is this one field. `stored` is what the block
 * keeps it as (seconds for a delay, whole minutes for the rest), and `value` and
 * `onChange` speak that unit. The unit picked is the field's own: switching it
 * keeps the amount and changes what it means, which is what somebody switching
 * "5 minutes" to "hours" wants. An optional span emptied is no span (NaN out),
 * never zero.
 */
export function DurationField({
    label,
    path,
    field,
    value,
    onChange,
    stored = "seconds",
    required = true,
    disabled
}: {
    label: string;
    path: readonly (string | number)[];
    field: string;
    value: number;
    onChange: (value: number) => void;
    stored?: "seconds" | "minutes";
    required?: boolean;
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const offered = UNITS[stored];
    const scale = UNIT_SECONDS[stored];
    const seconds = value * scale;
    const [unit, setUnit] = useState<Unit>(() => unitOf(seconds, offered));
    const amount = Number.isFinite(seconds) ? seconds / UNIT_SECONDS[unit] : Number.NaN;
    const emit = (next: number, chosen: Unit) =>
        onChange(
            Number.isFinite(next) ? Math.round((next * UNIT_SECONDS[chosen]) / scale) : Number.NaN
        );
    return (
        <Field label={label} path={[...path, field]} required={required}>
            {(id, invalid) => (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                    <Input
                        id={id}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        disabled={disabled}
                        className={NUMBER_INPUT}
                        value={Number.isFinite(amount) ? String(amount) : ""}
                        aria-invalid={invalid || undefined}
                        onChange={(event) =>
                            emit(
                                event.target.value === "" ? Number.NaN : Number(event.target.value),
                                unit
                            )
                        }
                    />
                    <Select
                        value={unit}
                        disabled={disabled}
                        className="min-w-[7rem] flex-1 basis-28"
                        aria-label={t("automations.fields.unit")}
                        options={offered.map((entry) => ({
                            value: entry,
                            label: t(`automations.fields.units.${entry}`)
                        }))}
                        onValueChange={(next) => {
                            const chosen = next as Unit;
                            setUnit(chosen);
                            if (Number.isFinite(amount)) emit(amount, chosen);
                        }}
                    />
                </div>
            )}
        </Field>
    );
}

/**
 * What a step that sets something sets it to, offered from what the unit has:
 * its own modes and fan speeds, a temperature in its own range and step, the
 * extras it was built with. A unit that has not said yet is offered everything,
 * and the save checks it once it has.
 */
export function SettingFields({
    device,
    setting,
    onChange,
    path,
    disabled
}: {
    device: DeviceView | undefined;
    setting: auto.StepSetting;
    onChange: (setting: auto.StepSetting) => void;
    path: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const climate = device?.climate ?? null;
    const at = [...path, "setting"];
    if (device && kinds.deviceKind(device.kind) === "air") {
        return (
            <AirSettingFields
                device={device}
                setting={setting}
                onChange={onChange}
                at={at}
                disabled={disabled}
            />
        );
    }
    if ("speed" in setting || setting.action === "set-humidity") return null;
    switch (setting.action) {
        case "set-mode":
            return (
                <Field label={t("automations.fields.mode")} path={[...at, "mode"]} required>
                    {(id, invalid) => (
                        <Select
                            id={id}
                            value={setting.mode}
                            disabled={disabled}
                            className={invalid ? "border-danger-edge" : undefined}
                            options={(climate?.modes ?? kinds.CLIMATE_MODES).map((mode) => ({
                                value: mode,
                                label: kinds.climateModeText(mode, t)
                            }))}
                            onValueChange={(next) => {
                                const mode = kinds.CLIMATE_MODES.find((entry) => entry === next);
                                if (mode) onChange({ ...setting, mode });
                            }}
                        />
                    )}
                </Field>
            );
        case "set-temperature":
            return (
                <NumberField
                    label={t("automations.fields.target")}
                    path={at}
                    field="target"
                    value={setting.target}
                    min={climate?.min}
                    step={climate?.step ?? "any"}
                    suffix={climate ? `\u00b0${climate.unit}` : "\u00b0"}
                    disabled={disabled}
                    onChange={(target) => onChange({ ...setting, target })}
                />
            );
        case "set-fan":
            return (
                <Field label={t("automations.fields.fan")} path={[...at, "fan"]} required>
                    {(id, invalid) => (
                        <Select
                            id={id}
                            value={"fan" in setting ? setting.fan : ""}
                            disabled={disabled}
                            className={invalid ? "border-danger-edge" : undefined}
                            options={(climate?.fans ?? kinds.CLIMATE_FANS).map((fan) => ({
                                value: fan,
                                label: kinds.climateFanText(fan, t)
                            }))}
                            onValueChange={(next) => {
                                const fan = kinds.CLIMATE_FANS.find((entry) => entry === next);
                                if (fan) onChange({ ...setting, fan });
                            }}
                        />
                    )}
                </Field>
            );
        case "set-option": {
            const offered = climate
                ? kinds.CLIMATE_OPTIONS.filter((option) => climate.options[option] !== undefined)
                : kinds.CLIMATE_OPTIONS;
            return (
                <>
                    <Field label={t("automations.fields.option")} path={[...at, "option"]} required>
                        {(id, invalid) => (
                            <Select
                                id={id}
                                value={setting.option}
                                disabled={disabled}
                                className={invalid ? "border-danger-edge" : undefined}
                                options={offered.map((option) => ({
                                    value: option,
                                    label: kinds.climateOptionText(option, t)
                                }))}
                                onValueChange={(next) => {
                                    const option = kinds.CLIMATE_OPTIONS.find(
                                        (entry) => entry === next
                                    );
                                    if (option)
                                        onChange({ action: "set-option", option, on: setting.on });
                                }}
                            />
                        )}
                    </Field>
                    <Field label={t("automations.fields.optionTo")} path={[...at, "on"]}>
                        {(id) => (
                            <Select
                                id={id}
                                value={setting.on ? "on" : "off"}
                                disabled={disabled}
                                options={[
                                    { value: "on", label: kinds.stateLabel("switch", "on", t) },
                                    { value: "off", label: kinds.stateLabel("switch", "off", t) }
                                ]}
                                onValueChange={(next) =>
                                    onChange({ ...setting, on: next === "on" })
                                }
                            />
                        )}
                    </Field>
                </>
            );
        }
    }
}

/** What a step sets a purifier to, offered from what it has: its presets and
 *  speeds, a humidity in its own range and step, the switches it was built
 *  with. */
function AirSettingFields({
    device,
    setting,
    onChange,
    at,
    disabled
}: {
    device: DeviceView;
    setting: auto.StepSetting;
    onChange: (setting: auto.StepSetting) => void;
    at: readonly (string | number)[];
    disabled?: boolean;
}) {
    const t = usePlacesT();
    const air = device.air ?? null;
    if (setting.action === "set-mode") {
        return (
            <Field label={t("automations.fields.mode")} path={[...at, "mode"]} required>
                {(id, invalid) => (
                    <Select
                        id={id}
                        value={setting.mode}
                        disabled={disabled}
                        className={invalid ? "border-danger-edge" : undefined}
                        options={(air?.modes ?? kinds.AIR_MODES).map((mode) => ({
                            value: mode,
                            label: kinds.airModeText(mode, t)
                        }))}
                        onValueChange={(next) => {
                            const mode = kinds.AIR_MODES.find((entry) => entry === next);
                            if (mode) onChange({ action: "set-mode", mode });
                        }}
                    />
                )}
            </Field>
        );
    }
    if (setting.action === "set-fan") {
        return (
            <Field label={t("automations.fields.speed")} path={[...at, "speed"]} required>
                {(id, invalid) => (
                    <Select
                        id={id}
                        value={"speed" in setting ? setting.speed : ""}
                        disabled={disabled}
                        className={invalid ? "border-danger-edge" : undefined}
                        options={(air?.speeds ?? kinds.AIR_SPEEDS).map((speed) => ({
                            value: speed,
                            label: kinds.airSpeedText(speed, t)
                        }))}
                        onValueChange={(next) => {
                            const speed = kinds.AIR_SPEEDS.find((entry) => entry === next);
                            if (speed) onChange({ action: "set-fan", speed });
                        }}
                    />
                )}
            </Field>
        );
    }
    if (setting.action === "set-humidity") {
        return (
            <NumberField
                label={t("automations.fields.humidity")}
                path={at}
                field="target"
                value={setting.target}
                min={air?.humidity?.min}
                step={air?.humidity?.step ?? "any"}
                suffix="%"
                disabled={disabled}
                onChange={(target) => onChange({ action: "set-humidity", target })}
            />
        );
    }
    if (setting.action !== "set-option") return null;
    const offered = air
        ? kinds.AIR_OPTIONS.filter((option) => air.options[option] !== undefined)
        : kinds.AIR_OPTIONS;
    const current = kinds.AIR_OPTIONS.find((entry) => entry === setting.option) ?? "";
    return (
        <>
            <Field label={t("automations.fields.option")} path={[...at, "option"]} required>
                {(id, invalid) => (
                    <Select
                        id={id}
                        value={current}
                        disabled={disabled}
                        placeholder={t("automations.fields.chooseValue")}
                        className={invalid ? "border-danger-edge" : undefined}
                        options={offered.map((option) => ({
                            value: option,
                            label: kinds.airOptionText(option, t)
                        }))}
                        onValueChange={(next) => {
                            const option = kinds.AIR_OPTIONS.find((entry) => entry === next);
                            if (option) onChange({ action: "set-option", option, on: setting.on });
                        }}
                    />
                )}
            </Field>
            <Field label={t("automations.fields.optionTo")} path={[...at, "on"]}>
                {(id) => (
                    <Select
                        id={id}
                        value={setting.on ? "on" : "off"}
                        disabled={disabled}
                        options={[
                            { value: "on", label: kinds.stateLabel("switch", "on", t) },
                            { value: "off", label: kinds.stateLabel("switch", "off", t) }
                        ]}
                        onValueChange={(next) => onChange({ ...setting, on: next === "on" })}
                    />
                )}
            </Field>
        </>
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
