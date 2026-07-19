"use client";

/**
 * Country/continent allowlist picker for shares and drop points. Continents are a
 * short chip row; countries are added from a searchable datalist and shown as
 * removable chips. Country names come from the browser's Intl.DisplayNames, so no
 * name table ships. Controlled: the parent owns the selected code arrays.
 */

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { CONTINENTS, COUNTRY_CODES } from "@polaris/core";
import { cn } from "@polaris/ui";

/** Map ISO country codes to display names once, falling back to the code. */
function useCountryNames(): (code: string) => string {
    return useMemo(() => {
        let display: Intl.DisplayNames | null = null;
        try {
            display = new Intl.DisplayNames(["en"], { type: "region" });
        } catch {
            display = null;
        }
        return (code: string) => {
            try {
                return display?.of(code) ?? code;
            } catch {
                return code;
            }
        };
    }, []);
}

export function GeoPicker({
    countries,
    continents,
    onCountries,
    onContinents
}: {
    countries: string[];
    continents: string[];
    onCountries: (next: string[]) => void;
    onContinents: (next: string[]) => void;
}) {
    const nameOf = useCountryNames();
    const options = useMemo(
        () =>
            COUNTRY_CODES.map((code) => ({ code, name: nameOf(code) })).sort((a, b) => a.name.localeCompare(b.name)),
        [nameOf]
    );

    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);

    // Suggestions live under the input inside the picker (an in-flow dropdown), not
    // the browser's native <datalist> popup, which a dialog would float off to the
    // side. Show up to eight matches for the current query, excluding chosen ones.
    const suggestions = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return [];
        return options
            .filter((option) => !countries.includes(option.code) && option.name.toLowerCase().includes(needle))
            .slice(0, 8);
    }, [options, countries, query]);

    function toggleContinent(code: string) {
        onContinents(continents.includes(code) ? continents.filter((c) => c !== code) : [...continents, code]);
    }

    function addCountry(value: string) {
        // Accept a display name or a raw 2-letter code.
        const byName = options.find((option) => option.name.toLowerCase() === value.trim().toLowerCase());
        const code = (byName?.code ?? value.trim().toUpperCase()).toUpperCase();
        if (COUNTRY_CODES.includes(code) && !countries.includes(code)) onCountries([...countries, code]);
        setQuery("");
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-2">
            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Continents</span>
                <div className="flex flex-wrap gap-1.5">
                    {CONTINENTS.map((continent) => (
                        <button
                            key={continent.code}
                            type="button"
                            onClick={() => toggleContinent(continent.code)}
                            className={cn(
                                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                                continents.includes(continent.code)
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border text-muted-foreground hover:bg-muted"
                            )}
                        >
                            {continent.name}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Countries</span>
                <div className="relative">
                    <input
                        value={query}
                        placeholder="Type a country to add"
                        autoComplete="off"
                        className="h-9 w-full rounded-md border border-input bg-surface px-3 text-sm"
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setOpen(true);
                        }}
                        onFocus={() => setOpen(true)}
                        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                addCountry(suggestions[0]?.name ?? event.currentTarget.value);
                            } else if (event.key === "Escape") {
                                setOpen(false);
                            }
                        }}
                    />
                    {open && suggestions.length > 0 ? (
                        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-surface py-1 shadow-lg">
                            {suggestions.map((option) => (
                                <li key={option.code}>
                                    <button
                                        type="button"
                                        // Fire before the input's blur so the click is not lost.
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            addCountry(option.name);
                                        }}
                                        className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-muted"
                                    >
                                        {option.name}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
                {countries.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                        {countries.map((code) => (
                            <span
                                key={code}
                                className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/5 px-2 py-0.5 text-xs text-primary"
                            >
                                {nameOf(code)}
                                <button
                                    type="button"
                                    onClick={() => onCountries(countries.filter((c) => c !== code))}
                                    aria-label={`Remove ${code}`}
                                >
                                    <X className="size-3" />
                                </button>
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>
            <span className="text-xs text-muted-foreground">
                Leave both empty to allow every location. Otherwise, only the selected countries and continents are
                allowed.
            </span>
        </div>
    );
}
