"use client";

/**
 * The units-and-formats form, shared by the account page and the platform
 * defaults page. Both edit the same six choices; the account version can also
 * leave a field on "Platform default", which is what keeps a user following the
 * operator's house style when it changes.
 *
 * The sample line under the form is formatted with exactly what is selected, so
 * the effect of a choice is visible before it is saved.
 */

import { useMemo, useState, type FormEvent } from "react";
import { Button, Card, CardBody, Select, type SelectOption } from "@polaris/ui";
import {
    CURRENCIES,
    THEMES,
    weekdayOrder,
    createDisplayFormat,
    AUTOMATIC_TIME_ZONE,
    WEEKDAY_SHORT_NAMES,
    resolveDisplayPreferences,
    type WeekStart,
    type DisplayPreferences,
    type UserDisplayPreferences
} from "@polaris/core";

/** The "leave it to the layer below" choice. Radix forbids an empty value. */
const INHERIT = "inherit";

/** A sample instant for the previews - a day past the 12th, so day-first and
 *  month-first read differently, and an afternoon hour so 12h and 24h do too. */
const SAMPLE = new Date(2026, 6, 31, 14, 5, 9);

/**
 * Every zone this runtime knows, or the handful worth offering when it will not
 * say.
 *
 * `supportedValuesOf` is the browser's own list and is therefore never out of
 * date; the fallback is for a runtime old enough not to have it, where a short
 * list of zones is still better than a field that cannot be used. Automatic sits
 * at the top and is what almost everybody keeps.
 */
function timeZoneOptions(): FieldOption[] {
    // Reached this way rather than called directly: it is a recent addition to
    // Intl, and a runtime without it must fall back rather than fail to render
    // the whole form.
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    let zones: string[] = [];
    try {
        zones = supported ? supported("timeZone") : [];
    } catch {
        zones = [];
    }
    if (zones.length === 0) {
        zones = ["UTC", "Europe/London", "Europe/Madrid", "Europe/Berlin", "America/New_York", "America/Los_Angeles"];
    }
    return [
        { value: AUTOMATIC_TIME_ZONE, label: "Automatic", short: "Automatic" },
        ...zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " "), short: zone }))
    ];
}

/** `short` names the choice where the example would not fit, as in the
 *  "Platform default (...)" entry. */
interface FieldOption {
    value: string;
    label: string;
    short: string;
}

interface FieldSpec {
    key: keyof UserDisplayPreferences;
    label: string;
    hint?: string;
    options: FieldOption[];
    /** Only English exists so far; the control still records the choice. */
    disabled?: boolean;
}

const FIELDS: FieldSpec[] = [
    {
        key: "theme",
        label: "Theme",
        hint: "Applied the moment it is saved, on every screen.",
        options: THEMES.map((theme) => ({
            value: theme.id,
            label: `${theme.label} - ${theme.description}`,
            short: theme.label
        }))
    },
    {
        key: "dateOrder",
        label: "Date order",
        options: [
            { value: "dmy", label: "Day first (31/07/2026)", short: "Day first" },
            { value: "mdy", label: "Month first (07/31/2026)", short: "Month first" }
        ]
    },
    {
        key: "yearFormat",
        label: "Year",
        options: [
            { value: "yyyy", label: "Four digits (2026)", short: "Four digits" },
            { value: "yy", label: "Two digits (26)", short: "Two digits" }
        ]
    },
    {
        key: "clock",
        label: "Clock",
        options: [
            { value: "24h", label: "24-hour (14:05)", short: "24-hour" },
            { value: "12h", label: "12-hour (2:05 PM)", short: "12-hour" }
        ]
    },
    {
        key: "weekStart",
        label: "Week starts on",
        hint: "Where every calendar and week view begins.",
        options: [
            { value: "sun", label: "Sunday", short: "Sunday" },
            { value: "mon", label: "Monday", short: "Monday" },
            { value: "sat", label: "Saturday", short: "Saturday" }
        ]
    },
    {
        key: "timeZone",
        label: "Time zone",
        hint: "Every time on screen is written in it. Automatic follows the device you are on.",
        options: timeZoneOptions()
    },
    {
        key: "temperature",
        label: "Temperature",
        options: [
            { value: "c", label: "Celsius (C)", short: "Celsius" },
            { value: "f", label: "Fahrenheit (F)", short: "Fahrenheit" }
        ]
    },
    {
        key: "currency",
        label: "Currency",
        options: CURRENCIES.map((entry) => ({
            value: entry.code,
            label: `${entry.label} (${entry.code})`,
            short: entry.code
        }))
    },
    {
        key: "language",
        label: "Language",
        hint: "English is the only language available so far.",
        options: [{ value: "en", label: "English", short: "English" }],
        disabled: true
    }
];

function toSelectOptions(options: FieldOption[]): SelectOption[] {
    return options.map((option) => ({ value: option.value, label: option.label }));
}

/** Same keys, same values - a save is only offered when something differs. */
function same(left: UserDisplayPreferences, right: UserDisplayPreferences): boolean {
    return FIELDS.every((field) => (left[field.key] ?? null) === (right[field.key] ?? null));
}

export function DisplayPreferencesForm({
    initial,
    fallback,
    allowInherit,
    allowTheme = true,
    save
}: {
    /** What is stored today. Partial when a user may inherit. */
    initial: UserDisplayPreferences;
    /** What an unset field resolves to: the platform's choices, or the built-in ones. */
    fallback: DisplayPreferences;
    allowInherit: boolean;
    /** False on an account whose instance keeps one theme for everybody. The
     *  field is left out rather than shown disabled: a control that cannot be
     *  used is a question nobody answered. */
    allowTheme?: boolean;
    save: (values: UserDisplayPreferences) => Promise<{ error?: string }>;
}) {
    const [values, setValues] = useState<UserDisplayPreferences>(initial);
    const [saved, setSaved] = useState<UserDisplayPreferences>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const fields = useMemo(
        () => (allowTheme ? FIELDS : FIELDS.filter((field) => field.key !== "theme")),
        [allowTheme]
    );
    const effective = useMemo(() => resolveDisplayPreferences(fallback, values), [fallback, values]);
    const format = useMemo(() => createDisplayFormat(effective), [effective]);
    const changed = !same(values, saved);

    function pick(key: keyof UserDisplayPreferences, value: string) {
        setDone(false);
        setValues((previous) => {
            const next: UserDisplayPreferences = { ...previous };
            // The value comes from the field's own option list, and the server
            // re-validates it against the schema before it is stored.
            if (value === INHERIT) delete next[key];
            else (next as Record<string, string>)[key] = value;
            return next;
        });
    }

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setDone(false);
        const result = await save(values);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setSaved(values);
        setDone(true);
    }

    return (
        <Card>
            <CardBody>
                <form onSubmit={onSubmit} className="flex flex-col gap-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                        {fields.map((field) => {
                            const inherited = values[field.key] === undefined;
                            const options = allowInherit
                                ? [
                                      {
                                          value: INHERIT,
                                          label: `Platform default (${shortFor(field, fallback[field.key])})`
                                      },
                                      ...toSelectOptions(field.options)
                                  ]
                                : toSelectOptions(field.options);
                            return (
                                <label key={field.key} className="flex flex-col gap-1 text-sm">
                                    {field.label}
                                    <Select
                                        value={inherited ? INHERIT : String(values[field.key])}
                                        onValueChange={(value) => pick(field.key, value)}
                                        options={options}
                                        disabled={field.disabled}
                                        aria-label={field.label}
                                    />
                                    {field.hint ? (
                                        <span className="text-xs text-muted-foreground">{field.hint}</span>
                                    ) : null}
                                </label>
                            );
                        })}
                    </div>

                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm sm:grid-cols-4">
                        <Sample label="Date" value={format.date(SAMPLE)} />
                        <Sample label="Time" value={format.time(SAMPLE)} />
                        <Sample label="Week" value={weekSample(effective.weekStart)} />
                        <Sample
                            label="Time zone"
                            value={
                                effective.timeZone === AUTOMATIC_TIME_ZONE
                                    ? "This device"
                                    : effective.timeZone.replace(/_/g, " ")
                            }
                        />
                        <Sample label="Temperature" value={format.temperature(21.4)} />
                        <Sample label="Amount" value={format.currency(1234.5)} />
                    </dl>

                    <div className="flex items-center justify-between gap-2">
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {done && !error ? <p className="text-sm text-success">Preferences saved.</p> : null}
                        <Button type="submit" disabled={busy || !changed} className="ml-auto">
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

/** The week as the chosen start draws it: the first day, then the last. */
function weekSample(weekStart: WeekStart): string {
    const order = weekdayOrder(weekStart);
    return `${WEEKDAY_SHORT_NAMES[order[0] as number]} to ${WEEKDAY_SHORT_NAMES[order[6] as number]}`;
}

/** The short name of a value, so "Platform default" can say what it resolves to. */
function shortFor(field: FieldSpec, value: string): string {
    return field.options.find((entry) => entry.value === value)?.short ?? value;
}

function Sample({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
        </div>
    );
}
