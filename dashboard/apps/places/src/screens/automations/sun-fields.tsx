"use client";

/**
 * The fields of the blocks that are about the automation as a whole rather than
 * a device: the sun (its event, an offset, today's time at the place) and
 * "Triggered by" (which of this automation's triggers started the run).
 *
 * Both need more than their own block - where the place is, its zone, the
 * automation's triggers - so the editor hands that down once through
 * `AutomationScopeProvider` instead of through every card.
 */

import { AlertTriangle } from "lucide-react";
import { createContext, useContext, useState } from "react";
import {
    SUN_EVENTS,
    blockTitle,
    durationOf,
    durationSeconds,
    sunEventOn,
    wallClock,
    type Coordinate,
    type Offset,
    type SunEvent
} from "@polaris/core";
import { usePlacesT } from "../use-places-t";
import { DurationField } from "./flow-fields";
import { Checkbox, Select } from "@polaris/ui";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import { UseLocationButton } from "../location-button";
import { Field, useIssue } from "@polaris/ui/automation";

export interface AutomationScope {
    readonly triggers: readonly auto.Trigger[];
    readonly lookup: words.DeviceLookup;
    /** Where the place is; null until somebody sets it. */
    readonly location: Coordinate | null;
    readonly timeZone: string;
    /** Sets the place's location from here, or absent where the reader may
     *  not. Returns a sentence when it could not. */
    readonly setLocation?: (location: Coordinate) => Promise<string | void>;
    /** The moment "today" is read at; the clock, outside a test. */
    readonly now?: () => Date;
}

const ScopeContext = createContext<AutomationScope>({
    triggers: [],
    lookup: () => undefined,
    location: null,
    timeZone: "UTC"
});

export const AutomationScopeProvider = ScopeContext.Provider;

function useScope(): AutomationScope {
    return useContext(ScopeContext);
}

/** Whether the automation's triggers are numbered: only while a "Triggered by"
 *  condition reads the numbers. */
export function numbersTriggers(definition: auto.AutomationDefinition): boolean {
    return definition.conditions.groups.some((group) =>
        group.items.some((item) => item.kind === "triggeredBy")
    );
}

// --- the sun --------------------------------------------------------------------

/** An event's time today at the place, as HH:MM in the automation's zone, moved
 *  by the offset; null when it does not happen today. */
export function todayAt(
    event: SunEvent,
    offset: Offset | undefined,
    location: Coordinate,
    timeZone: string,
    now: Date
): string | null {
    const today = wallClock(now, timeZone);
    const at = sunEventOn(event, today, location);
    if (!at) return null;
    const shift = offset
        ? durationSeconds(offset) * 1000 * (offset.direction === "before" ? -1 : 1)
        : 0;
    const clock = wallClock(new Date(at.getTime() + shift), timeZone);
    return `${String(clock.hours).padStart(2, "0")}:${String(clock.minutes).padStart(2, "0")}`;
}

/** What is missing for the sun to be timed and the button that sets it, right
 *  there - once per block, however many events the block names. Nothing once
 *  the place has a location. */
function SunLocationNotice() {
    const t = usePlacesT();
    const scope = useScope();
    if (scope.location) return null;
    return (
        <div className="flex min-w-0 flex-col gap-2 rounded-md bg-muted px-3 py-2 sm:col-span-2">
            <p className="text-xs text-muted-foreground">
                {t(
                    scope.setLocation
                        ? "automations.fields.noLocation"
                        : "automations.fields.noLocationAsk"
                )}
            </p>
            {scope.setLocation ? <UseLocationButton onLocated={scope.setLocation} /> : null}
        </div>
    );
}

/** "Today: 08:21" or "Not today" for one event; nothing without a location,
 *  which `SunLocationNotice` asks for once for the whole block. */
function SunToday({ event, offset }: { event: SunEvent; offset?: Offset }) {
    const t = usePlacesT();
    const scope = useScope();
    if (!scope.location) return null;
    const time = todayAt(
        event,
        offset,
        scope.location,
        scope.timeZone,
        (scope.now ?? (() => new Date()))()
    );
    return (
        <p className="text-xs text-muted-foreground sm:col-span-2">
            {time === null
                ? t("automations.fields.sunNotToday")
                : t("automations.fields.sunToday", { time })}
        </p>
    );
}

/** An offset before or after an event: the way, then how long. None is the
 *  moment itself. */
function OffsetField({
    path,
    field,
    value,
    disabled,
    onChange
}: {
    path: readonly (string | number)[];
    field: string;
    value: Offset | undefined;
    disabled?: boolean;
    onChange: (offset: Offset | undefined) => void;
}) {
    const t = usePlacesT();
    // The way is the field's own until there is an amount to keep it on, so
    // choosing "after" first and typing the minutes second keeps "after".
    const [way, setWay] = useState<Offset["direction"]>(value?.direction ?? "before");
    const direction = value?.direction ?? way;
    const seconds = value ? durationSeconds(value) : 0;
    const emit = (span: number, way: Offset["direction"]) =>
        onChange(
            Number.isFinite(span) && span > 0 ? { ...durationOf(span), direction: way } : undefined
        );
    return (
        <>
            <Field label={t("automations.fields.offsetWay")} path={[...path, field, "direction"]}>
                {(id) => (
                    <Select
                        id={id}
                        value={direction}
                        disabled={disabled}
                        onValueChange={(next) => {
                            setWay(next as Offset["direction"]);
                            emit(seconds, next as Offset["direction"]);
                        }}
                        options={(["before", "after"] as const).map((way) => ({
                            value: way,
                            label: t(`automations.fields.offsetWays.${way}`)
                        }))}
                    />
                )}
            </Field>
            <DurationField
                label={t("automations.fields.offset")}
                path={path}
                field={field}
                value={seconds}
                required={false}
                disabled={disabled}
                onChange={(span) => emit(span, direction)}
            />
        </>
    );
}

function EventField<E extends string>({
    label,
    path,
    field,
    value,
    events,
    disabled,
    onChange
}: {
    label: string;
    path: readonly (string | number)[];
    field: string;
    value: E;
    events: readonly E[];
    disabled?: boolean;
    onChange: (event: E) => void;
}) {
    const t = usePlacesT();
    return (
        <Field label={label} path={[...path, field]} required>
            {(id) => (
                <Select
                    id={id}
                    value={value}
                    disabled={disabled}
                    onValueChange={(next) => onChange(next as E)}
                    options={events.map((event) => ({
                        value: event,
                        label: t(`automations.fields.sunEvents.${event as SunEvent}`)
                    }))}
                />
            )}
        </Field>
    );
}

export function SunTriggerFields({
    trigger,
    path,
    disabled,
    onChange
}: {
    trigger: Extract<auto.Trigger, { kind: "sun" }>;
    path: readonly (string | number)[];
    disabled?: boolean;
    onChange: (trigger: auto.Trigger) => void;
}) {
    const t = usePlacesT();
    return (
        <>
            <EventField
                label={t("automations.fields.sunEvent")}
                path={path}
                field="event"
                value={trigger.event}
                events={SUN_EVENTS}
                disabled={disabled}
                onChange={(event) => onChange({ ...trigger, event })}
            />
            <div className="hidden sm:block" />
            <OffsetField
                path={path}
                field="offset"
                value={trigger.offset}
                disabled={disabled}
                onChange={(offset) => {
                    const { offset: _gone, ...rest } = trigger;
                    onChange(offset ? { ...rest, offset } : rest);
                }}
            />
            <SunToday event={trigger.event} offset={trigger.offset} />
            <SunLocationNotice />
        </>
    );
}

type SunMode = "after" | "before" | "between";

export function SunConditionFields({
    condition,
    path,
    disabled,
    onChange
}: {
    condition: Extract<auto.Condition, { kind: "sun" }>;
    path: readonly (string | number)[];
    disabled?: boolean;
    onChange: (condition: auto.Condition) => void;
}) {
    const t = usePlacesT();
    const mode: SunMode =
        condition.after && condition.before ? "between" : condition.before ? "before" : "after";
    const base = { id: condition.id, kind: condition.kind, ...ownText(condition) };
    const choose = (next: SunMode) => {
        const after = condition.after ?? { event: "sunset" as const };
        const before = condition.before ?? { event: "sunrise" as const };
        onChange(
            next === "between"
                ? { ...base, after, before }
                : next === "after"
                  ? { ...base, after }
                  : { ...base, before }
        );
    };
    const side = (which: "after" | "before") => {
        const value = condition[which];
        if (!value) return null;
        return (
            <>
                <EventField
                    label={t(
                        which === "after"
                            ? "automations.fields.sunAfter"
                            : "automations.fields.sunBefore"
                    )}
                    path={[...path, which]}
                    field="event"
                    value={value.event}
                    events={auto.SUN_EDGES}
                    disabled={disabled}
                    onChange={(event) => onChange({ ...condition, [which]: { ...value, event } })}
                />
                <div className="hidden sm:block" />
                <OffsetField
                    path={[...path, which]}
                    field="offset"
                    value={value.offset}
                    disabled={disabled}
                    onChange={(offset) =>
                        onChange({
                            ...condition,
                            [which]: offset ? { ...value, offset } : { event: value.event }
                        })
                    }
                />
                <SunToday event={value.event} offset={value.offset} />
            </>
        );
    };
    return (
        <>
            <Field label={t("automations.fields.sunPasses")} path={[...path, "after"]} required>
                {(id) => (
                    <Select
                        id={id}
                        value={mode}
                        disabled={disabled}
                        onValueChange={(next) => choose(next as SunMode)}
                        options={(["after", "before", "between"] as const).map((each) => ({
                            value: each,
                            label: t(`automations.fields.sunModes.${each}`)
                        }))}
                    />
                )}
            </Field>
            <div className="hidden sm:block" />
            {side("after")}
            {side("before")}
            <SunLocationNotice />
        </>
    );
}

function ownText(block: { alias?: string; note?: string }) {
    return {
        ...(block.alias !== undefined ? { alias: block.alias } : {}),
        ...(block.note !== undefined ? { note: block.note } : {})
    };
}

// --- triggered by -----------------------------------------------------------------

/** The automation's triggers as checkboxes, each with its number, plus any id
 *  the condition still names that no trigger has any more, offered to uncheck. */
export function TriggeredByFields({
    condition,
    path,
    disabled,
    onChange
}: {
    condition: Extract<auto.Condition, { kind: "triggeredBy" }>;
    path: readonly (string | number)[];
    disabled?: boolean;
    onChange: (condition: auto.Condition) => void;
}) {
    const t = usePlacesT();
    const scope = useScope();
    const issue = useIssue([...path, "triggerIds"]);
    const picked = new Set(condition.triggerIds);
    const missing = condition.triggerIds.filter(
        (id) => !scope.triggers.some((trigger) => trigger.id === id)
    );
    const toggle = (id: string, on: boolean) =>
        onChange({
            ...condition,
            triggerIds: on
                ? scope.triggers
                      .map((each) => each.id)
                      .filter((each) => each === id || picked.has(each))
                : condition.triggerIds.filter((each) => each !== id)
        });
    return (
        <fieldset className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <legend className="mb-1.5 text-[0.75rem] font-medium text-muted-foreground">
                {t("automations.fields.triggeredBy")}
            </legend>
            {scope.triggers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    {t("automations.fields.noTriggers")}
                </p>
            ) : (
                scope.triggers.map((trigger, index) => (
                    <label key={trigger.id} className="flex min-w-0 items-center gap-2 text-sm">
                        <Checkbox
                            checked={picked.has(trigger.id)}
                            disabled={disabled}
                            onChange={(event) => toggle(trigger.id, event.target.checked)}
                        />
                        <span
                            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium tabular-nums text-muted-foreground"
                            aria-label={t("automations.fields.triggerNumber", {
                                number: index + 1
                            })}
                        >
                            {index + 1}
                        </span>
                        <span
                            className="min-w-0 truncate"
                            title={words.describeTrigger(trigger, scope.lookup, t)}
                        >
                            {blockTitle(trigger, words.describeTrigger(trigger, scope.lookup, t))}
                        </span>
                    </label>
                ))
            )}
            {missing.map((id) => (
                <label key={id} className="flex min-w-0 items-center gap-2 text-sm text-danger-ink">
                    <Checkbox checked disabled={disabled} onChange={() => toggle(id, false)} />
                    <AlertTriangle className="size-4 shrink-0" />
                    <span className="min-w-0">{t("automations.fields.triggerMissing")}</span>
                </label>
            ))}
            {issue ? <p className="text-[0.75rem] text-danger">{issue}</p> : null}
        </fieldset>
    );
}
