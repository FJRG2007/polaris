"use client";

/**
 * Value pickers for a condition whose values come from a known set: a row of
 * toggle chips for a short list (systems, weekdays, continents), a searchable
 * picker with flags for countries, and a from-to picker for a time window.
 *
 * Shared by the rule builders and the location allowlist picker, so a country is
 * chosen, shown and removed the same way wherever one is written.
 */

import { Plus, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { COUNTRY_CODES, countryName } from "@polaris/core";
import { Button, CountryFlag, Input, cn } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";

/** A country as the reader's language names it. English keeps core's names, which
 *  are the same list the server writes. */
export function regionName(code: string, locale: string): string {
    if (locale === "en-US") return countryName(code);
    try {
        return new Intl.DisplayNames([locale], { type: "region" }).of(code.toUpperCase()) ?? countryName(code);
    } catch {
        return countryName(code);
    }
}

export interface Choice {
    value: string;
    label: string;
    icon?: ReactNode;
}

/** A short list of values, each a chip that is on or off. Values the list does not
 *  offer (a saved list since deleted) stay visible, marked, so they can be removed. */
export function ChoiceChips({
    options,
    selected,
    onChange,
    label,
    unknownLabel
}: {
    options: readonly Choice[];
    selected: readonly string[];
    onChange: (next: string[]) => void;
    /** What the row is, for assistive technology. */
    label: string;
    /** How a selected value the options do not know reads. */
    unknownLabel?: (value: string) => string;
}) {
    const t = useTranslations("components");
    const known = new Set(options.map((option) => option.value));
    const unknown = selected.filter((value) => !known.has(value));
    const toggle = (value: string) =>
        onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]);
    return (
        <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
            {options.map((option) => {
                const on = selected.includes(option.value);
                return (
                    <button
                        key={option.value}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggle(option.value)}
                        className={cn(
                            "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                            on
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-muted"
                        )}
                    >
                        {option.icon}
                        <span className="min-w-0 truncate" title={option.label}>
                            {option.label}
                        </span>
                    </button>
                );
            })}
            {unknown.map((value) => (
                <span
                    key={value}
                    className="inline-flex max-w-full items-center gap-1 rounded-full border border-danger/40 bg-danger-soft px-2.5 py-1 text-xs text-danger-ink"
                >
                    <span className="min-w-0 truncate">{unknownLabel ? unknownLabel(value) : value}</span>
                    <button
                        type="button"
                        onClick={() => toggle(value)}
                        aria-label={t("ruleList.remove", { entry: unknownLabel ? unknownLabel(value) : value })}
                        className="shrink-0"
                    >
                        <X className="size-3" aria-hidden="true" />
                    </button>
                </span>
            ))}
        </div>
    );
}

/** Countries, searched by name or code and shown with their flags. */
export function CountryPicker({
    selected,
    onChange
}: {
    selected: readonly string[];
    onChange: (next: string[]) => void;
}) {
    const t = useTranslations("components");
    const locale = useLocale();
    const options = useMemo(
        () =>
            COUNTRY_CODES.map((code) => ({ code, name: regionName(code, locale) })).sort((a, b) =>
                a.name.localeCompare(b.name, locale)
            ),
        [locale]
    );
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    // Suggestions live under the input (an in-flow dropdown), not the browser's
    // native <datalist> popup, which a dialog would float off to the side.
    const suggestions = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return [];
        return options
            .filter(
                (option) =>
                    !selected.includes(option.code) &&
                    (option.name.toLowerCase().includes(needle) || option.code.toLowerCase() === needle)
            )
            .slice(0, 8);
    }, [options, selected, query]);

    function add(value: string) {
        // A display name or a raw two-letter code.
        const byName = options.find((option) => option.name.toLowerCase() === value.trim().toLowerCase());
        const code = (byName?.code ?? value.trim()).toUpperCase();
        if (COUNTRY_CODES.includes(code) && !selected.includes(code)) onChange([...selected, code]);
        setQuery("");
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="relative">
                <input
                    value={query}
                    placeholder={t("geo.typeCountry")}
                    aria-label={t("geo.countries")}
                    autoComplete="off"
                    className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm"
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => window.setTimeout(() => setOpen(false), 120)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            add(suggestions[0]?.name ?? event.currentTarget.value);
                        } else if (event.key === "Escape") {
                            setOpen(false);
                        }
                    }}
                />
                {open && suggestions.length > 0 ? (
                    <ul className="absolute start-0 end-0 top-full z-20 mt-1 max-h-56 overflow-auto overscroll-contain rounded-md border border-border-strong bg-surface py-1 shadow-popover">
                        {suggestions.map((option) => (
                            <li key={option.code}>
                                <button
                                    type="button"
                                    // Fire before the input's blur so the click is not lost.
                                    onMouseDown={(event) => {
                                        event.preventDefault();
                                        add(option.name);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted"
                                >
                                    <CountryFlag code={option.code} className="shrink-0" />
                                    <span className="min-w-0 truncate" title={option.name}>{option.name}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
            {selected.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {selected.map((code) => (
                        <span
                            key={code}
                            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs text-primary"
                        >
                            <CountryFlag code={code} className="shrink-0" />
                            <span className="min-w-0 truncate">{regionName(code, locale)}</span>
                            <button
                                type="button"
                                onClick={() => onChange(selected.filter((entry) => entry !== code))}
                                aria-label={t("ruleList.remove", { entry: regionName(code, locale) })}
                                className="shrink-0"
                            >
                                <X className="size-3" aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

/** Time windows as "HH:MM-HH:MM", each chosen as a start and an end. One that ends
 *  before it starts runs past midnight, which the hint under it says. */
export function TimeRangePicker({
    selected,
    onChange,
    labels
}: {
    selected: readonly string[];
    onChange: (next: string[]) => void;
    labels: { from: string; to: string; add: string; overnight: string };
}) {
    const t = useTranslations("components");
    const [from, setFrom] = useState("09:00");
    const [to, setTo] = useState("17:00");
    const valid = /^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to);
    const range = `${from}-${to}`;
    const overnight = valid && to < from;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {labels.from}
                    <Input type="time" value={from} className="w-32" onChange={(event) => setFrom(event.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {labels.to}
                    <Input type="time" value={to} className="w-32" onChange={(event) => setTo(event.target.value)} />
                </label>
                <Button
                    type="button"
                    variant="secondary"
                    disabled={!valid || selected.includes(range)}
                    onClick={() => onChange([...selected, range])}
                >
                    <Plus className="size-4 shrink-0" aria-hidden="true" />
                    {labels.add}
                </Button>
            </div>
            {overnight ? <p className="text-xs text-muted-foreground">{labels.overnight}</p> : null}
            {selected.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {selected.map((entry) => (
                        <span
                            key={entry}
                            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground"
                        >
                            {entry.replace("-", " - ")}
                            <button
                                type="button"
                                onClick={() => onChange(selected.filter((value) => value !== entry))}
                                aria-label={t("ruleList.remove", { entry })}
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                            >
                                <X className="size-3" aria-hidden="true" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
