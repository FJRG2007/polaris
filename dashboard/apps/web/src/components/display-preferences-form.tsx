"use client";

/**
 * The units-and-formats form, shared by the account page and the platform
 * defaults page. Both edit the same six choices; the account version can also
 * leave a field on "Platform default", which is what keeps a user following the
 * operator's house style when it changes.
 *
 * The sample line under the form is formatted with exactly what is selected, so
 * the effect of a choice is visible before it is saved.
 *
 * The language is not here: it has its own card and is saved on its own, since
 * changing it redraws the whole page (see `LanguageCard`). Its words come from
 * the `account` namespace, which both pages hand down with `<Messages>`.
 */

import { useMemo, useState, type FormEvent } from "react";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { Button, Card, CardBody, Select, type SelectOption } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    CURRENCIES,
    THEMES,
    weekdayOrder,
    weekdayNames,
    createDisplayFormat,
    AUTOMATIC_TIME_ZONE,
    resolveDisplayPreferences,
    type Locale,
    type WeekStart,
    type DisplayPreferences,
    type UserDisplayPreferences
} from "@polaris/core";

type Translate = NamespaceTranslator<"account">;

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
function timeZoneOptions(automatic: string): FieldOption[] {
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
        { value: AUTOMATIC_TIME_ZONE, label: automatic, short: automatic },
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
}

/** The keys this form owns, in the order it draws them. What decides whether a
 *  save is offered, so it is fixed rather than read off the translated fields. */
const FIELD_KEYS = [
    "theme",
    "dateOrder",
    "yearFormat",
    "clock",
    "weekStart",
    "timeZone",
    "temperature",
    "currency"
] as const satisfies readonly (keyof UserDisplayPreferences)[];

/** An option whose label shows an example, and whose short name is the label
 *  without it - "Day first (31/07/2026)" and "Day first". */
function sampled(value: string, short: string, sample: string, t: Translate): FieldOption {
    return { value, label: t("display.withSample", { label: short, sample }), short };
}

/**
 * The fields, in the reader's language. Built per render rather than once for the
 * module, because the words depend on the locale the page is drawn in - a
 * module-level list would be frozen in whichever language loaded it first.
 */
function buildFields(t: Translate, locale: Locale): FieldSpec[] {
    const days = weekdayNames(locale, "long");
    return [
        {
            key: "theme",
            label: t("display.theme.label"),
            hint: t("display.theme.hint"),
            options: THEMES.map((theme) => {
                const label = t(`display.theme.names.${theme.id}`);
                return {
                    value: theme.id,
                    label: t("display.theme.option", {
                        label,
                        description: t(`display.theme.descriptions.${theme.id}`)
                    }),
                    short: label
                };
            })
        },
        {
            key: "dateOrder",
            label: t("display.dateOrder.label"),
            options: [
                sampled("dmy", t("display.dateOrder.dmy"), "31/07/2026", t),
                sampled("mdy", t("display.dateOrder.mdy"), "07/31/2026", t)
            ]
        },
        {
            key: "yearFormat",
            label: t("display.yearFormat.label"),
            options: [
                sampled("yyyy", t("display.yearFormat.yyyy"), "2026", t),
                sampled("yy", t("display.yearFormat.yy"), "26", t)
            ]
        },
        {
            key: "clock",
            label: t("display.clock.label"),
            options: [
                sampled("24h", t("display.clock.24h"), "14:05", t),
                sampled("12h", t("display.clock.12h"), "2:05 PM", t)
            ]
        },
        {
            key: "weekStart",
            label: t("display.weekStart.label"),
            hint: t("display.weekStart.hint"),
            options: (["sun", "mon", "sat"] as const).map((day) => {
                // Standing alone in a list, so capitalised as a label is.
                const first = days[weekdayOrder(day)[0] as number] as string;
                const name = first.charAt(0).toLocaleUpperCase(locale) + first.slice(1);
                return { value: day, label: name, short: name };
            })
        },
        {
            key: "timeZone",
            label: t("display.timeZone.label"),
            hint: t("display.timeZone.hint"),
            options: timeZoneOptions(t("display.timeZone.automatic"))
        },
        {
            key: "temperature",
            label: t("display.temperature.label"),
            options: [
                sampled("c", t("display.temperature.c"), "C", t),
                sampled("f", t("display.temperature.f"), "F", t)
            ]
        },
        {
            key: "currency",
            label: t("display.currency.label"),
            options: CURRENCIES.map((entry) => ({
                value: entry.code,
                label: t("display.withSample", {
                    label: t(`display.currency.names.${entry.code}`),
                    sample: entry.code
                }),
                short: entry.code
            }))
        }
    ];
}

function toSelectOptions(options: FieldOption[]): SelectOption[] {
    return options.map((option) => ({ value: option.value, label: option.label }));
}

/** Same keys, same values - a save is only offered when something differs. */
function same(left: UserDisplayPreferences, right: UserDisplayPreferences): boolean {
    return FIELD_KEYS.every((key) => (left[key] ?? null) === (right[key] ?? null));
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
    const t = useTranslations("account");
    const tc = useTranslations("common");
    const locale = useLocale();
    const [values, setValues] = useState<UserDisplayPreferences>(initial);
    const [saved, setSaved] = useState<UserDisplayPreferences>(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    const fields = useMemo(() => {
        const all = buildFields(t, locale);
        return allowTheme ? all : all.filter((field) => field.key !== "theme");
    }, [t, locale, allowTheme]);
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
                                          label: t("display.platformDefault", {
                                              value: shortFor(field, fallback[field.key])
                                          })
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
                        <Sample label={t("display.sample.date")} value={format.date(SAMPLE)} />
                        <Sample label={t("display.sample.time")} value={format.time(SAMPLE)} />
                        <Sample
                            label={t("display.sample.week")}
                            value={weekSample(effective.weekStart, locale, t)}
                        />
                        <Sample
                            label={t("display.sample.timeZone")}
                            value={
                                effective.timeZone === AUTOMATIC_TIME_ZONE
                                    ? t("display.sample.thisDevice")
                                    : effective.timeZone.replace(/_/g, " ")
                            }
                        />
                        <Sample label={t("display.sample.temperature")} value={format.temperature(21.4)} />
                        <Sample label={t("display.sample.amount")} value={format.currency(1234.5)} />
                    </dl>

                    <div className="flex items-center justify-between gap-2">
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        {done && !error ? <p className="text-sm text-success">{t("display.saved")}</p> : null}
                        <Button type="submit" disabled={busy || !changed} className="ml-auto">
                            {busy ? tc("actions.saving") : tc("actions.save")}
                        </Button>
                    </div>
                </form>
            </CardBody>
        </Card>
    );
}

/** The week as the chosen start draws it: the first day, then the last. */
function weekSample(weekStart: WeekStart, locale: Locale, t: Translate): string {
    const order = weekdayOrder(weekStart);
    const days = weekdayNames(locale, "short");
    return t("display.sample.weekRange", {
        first: days[order[0] as number] as string,
        last: days[order[6] as number] as string
    });
}

/** The short name of a value, so "Platform default" can say what it resolves to.
 *  Not every preference is a string - the text size is a number, and it belongs
 *  to another form - so the value is compared as one. */
function shortFor(field: FieldSpec, value: string | number): string {
    const key = String(value);
    return field.options.find((entry) => entry.value === key)?.short ?? key;
}

function Sample({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium">{value}</dd>
        </div>
    );
}
