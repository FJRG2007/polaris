"use client";

/**
 * Choosing a time zone: a field to type into and the matching zones under it.
 *
 * Four hundred zones do not fit a plain list, so it is searched - by name, by
 * city, by offset ("+02"). The list opens in the flow of the form rather than
 * floating over it: this sits inside dialogs, whose own scrolling clips a
 * floating list and whose focus trap fights one drawn outside them.
 */

import * as engine from "../engine";
import { useCalendarT } from "./i18n";
import { cn, Input } from "@polaris/ui";
import { Check, Globe } from "lucide-react";
import { hostUi } from "@polaris/app-host/client";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

interface ZoneOption {
    readonly value: string;
    readonly label: string;
    readonly haystack: string;
}

let zoneCache: { locale: string; hour: number; options: ZoneOption[] } | null = null;

function zoneOptions(locale: string, now: Date): ZoneOption[] {
    const hour = Math.floor(now.getTime() / 3_600_000);
    if (zoneCache && zoneCache.locale === locale && zoneCache.hour === hour) return zoneCache.options;
    const options = engine.listZones().map((zone) => {
        const label = engine.zoneLabel(zone, now, locale);
        return { value: zone, label, haystack: `${label} ${zone.replace(/[_/]/g, " ")}`.toLowerCase() };
    });
    zoneCache = { locale, hour, options };
    return options;
}

const MOST_SHOWN = 60;

export function ZonePicker({
    id,
    value,
    onChange,
    allowFloating = false,
    disabled,
    label
}: {
    id?: string;
    /** An IANA zone, or "" for floating when `allowFloating`. */
    value: string;
    onChange: (zone: string) => void;
    allowFloating?: boolean;
    disabled?: boolean;
    /** The accessible name, when no `<label>` points at `id`. */
    label?: string;
}) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const listId = useId();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const options = useMemo(() => zoneOptions(locale, new Date()), [locale]);

    const shownValue = value === "" ? t("zonePicker.floating") : (options.find((option) => option.value === value)?.label ?? value);
    const matches = useMemo(() => {
        const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const found = words.length === 0 ? options : options.filter((option) => words.every((word) => option.haystack.includes(word)));
        const floating: ZoneOption[] = allowFloating && words.length === 0 ? [{ value: "", label: t("zonePicker.floating"), haystack: "" }] : [];
        return [...floating, ...found].slice(0, MOST_SHOWN);
    }, [options, query, allowFloating, t]);

    const choose = (zone: string) => {
        onChange(zone);
        setOpen(false);
        setQuery("");
        input.current?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((index) => Math.min(matches.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter" && open) {
            event.preventDefault();
            event.stopPropagation();
            const option = matches[active];
            if (option) choose(option.value);
        } else if (event.key === "Escape" && open) {
            // The list closes; the dialog around it does not.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            setQuery("");
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="relative">
                <Globe aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" />
                <Input
                    ref={input}
                    id={id}
                    role="combobox"
                    aria-label={label}
                    aria-expanded={open}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
                    disabled={disabled}
                    className="pl-8"
                    value={open ? query : shownValue}
                    placeholder={t("zonePicker.search")}
                    title={shownValue}
                    onFocus={() => setOpen(false)}
                    onClick={() => setOpen(true)}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                        setOpen(true);
                    }}
                    onKeyDown={onKeyDown}
                    onBlur={(event) => {
                        if (!event.currentTarget.parentElement?.parentElement?.contains(event.relatedTarget as Node | null)) {
                            setOpen(false);
                            setQuery("");
                        }
                    }}
                />
            </div>
            {open ? (
                <ul id={listId} role="listbox" aria-label={label ?? t("zonePicker.search")} className="max-h-56 overflow-y-auto rounded-md border border-border bg-elevated p-1">
                    {matches.length === 0 ? (
                        <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("zonePicker.none")}</li>
                    ) : (
                        matches.map((option, index) => (
                            <li
                                key={option.value || "floating"}
                                id={`${listId}-${index}`}
                                role="option"
                                aria-selected={option.value === value}
                                // Chosen on press, before the field's blur closes the list.
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    choose(option.value);
                                }}
                                onMouseEnter={() => setActive(index)}
                                className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem] tabular-nums", index === active && "bg-option-hover")}
                            >
                                <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                                {option.value === value ? <Check aria-hidden className="size-4 text-primary" /> : null}
                            </li>
                        ))
                    )}
                </ul>
            ) : null}
        </div>
    );
}
