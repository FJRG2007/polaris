"use client";

/**
 * The world clock's "Add a city": any city, town or village by name. The
 * zones this runtime knows match at once and offline; places they do not name
 * come from the server's geocoder a moment after typing stops, each with its
 * region and country so two towns of one name tell apart. A newer search
 * supersedes an older one, whose answer is then ignored.
 */

import { useCalendarT } from "../i18n";
import { cn, Input, Button } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import * as placeActions from "../../actions/places";
import { Globe, Loader2, MapPin } from "lucide-react";
import { searchCities, cityOptions } from "../../lib/clock/cities";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

const LOCAL_SHOWN = 8;
const DEBOUNCE_MS = 300;

export interface PickedPlace {
    readonly zone: string;
    /** "Alcobendas, Madrid, Spain"; empty for a zone picked by its own city. */
    readonly label: string;
}

interface Row {
    readonly key: string;
    readonly zone: string;
    readonly title: string;
    readonly detail: string;
    readonly label: string;
    readonly remote: boolean;
}

type Remote =
    | { state: "idle" }
    | { state: "loading"; query: string }
    | { state: "done"; query: string; rows: Row[] }
    | { state: "failed"; query: string; message: string };

export function PlaceSearch({ onPick }: { onPick: (place: PickedPlace) => void }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const listId = useId();
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [remote, setRemote] = useState<Remote>({ state: "idle" });
    const [attempt, setAttempt] = useState(0);
    const latest = useRef(0);
    const input = useRef<HTMLInputElement>(null);
    const options = useMemo(() => cityOptions(locale, new Date()), [locale]);
    const typed = query.trim();

    useEffect(() => input.current?.focus(), []);

    useEffect(() => {
        const ask = ++latest.current;
        if (typed.length < 2) {
            setRemote({ state: "idle" });
            return;
        }
        setRemote({ state: "loading", query: typed });
        const timer = window.setTimeout(() => {
            void placeActions
                .searchPlacesAction({ query: typed, language: locale })
                .then((answer) => {
                    if (ask !== latest.current) return;
                    if (!answer.ok) {
                        setRemote({ state: "failed", query: typed, message: answer.error });
                        return;
                    }
                    setRemote({
                        state: "done",
                        query: typed,
                        rows: answer.places.map((place, index) => {
                            const detail = [place.region, place.country].filter(Boolean).join(", ");
                            return {
                                key: `remote-${index}-${place.latitude}-${place.longitude}`,
                                zone: place.zone,
                                title: place.name,
                                detail,
                                label: [place.name, detail].filter(Boolean).join(", "),
                                remote: true
                            };
                        })
                    });
                })
                .catch(() => {
                    if (ask !== latest.current) return;
                    setRemote({ state: "failed", query: typed, message: "" });
                });
        }, DEBOUNCE_MS);
        return () => window.clearTimeout(timer);
    }, [typed, locale, attempt]);

    const rows = useMemo(() => {
        const local: Row[] =
            typed === ""
                ? []
                : searchCities(options, typed, LOCAL_SHOWN).map((city) => ({
                      key: `zone-${city.zone}`,
                      zone: city.zone,
                      title: city.city,
                      detail: [city.country || city.note, city.offset].filter(Boolean).join(" · "),
                      label: "",
                      remote: false
                  }));
        const seen = new Set(local.map((row) => `${row.title}|${row.zone}`.toLowerCase()));
        const found =
            remote.state === "done"
                ? remote.rows.filter((row) => !seen.has(`${row.title}|${row.zone}`.toLowerCase()))
                : [];
        return [...local, ...found];
    }, [options, typed, remote]);

    const pick = (row: Row) => onPick({ zone: row.zone, label: row.label });

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(rows.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(0, index - 1));
        } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[active];
            if (row) pick(row);
        }
    };

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="relative">
                <Globe
                    aria-hidden
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle"
                />
                <Input
                    ref={input}
                    role="combobox"
                    aria-label={t("time.world.add")}
                    aria-expanded={typed !== ""}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
                    className="pl-8"
                    value={query}
                    maxLength={80}
                    placeholder={t("time.world.searchHint")}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                />
            </div>
            {typed !== "" ? (
                <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-elevated p-1">
                    <ul id={listId} role="listbox" aria-label={t("time.world.add")}>
                        {rows.map((row, index) => (
                            <li
                                key={row.key}
                                id={`${listId}-${index}`}
                                role="option"
                                aria-selected={index === active}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    pick(row);
                                }}
                                onMouseEnter={() => setActive(index)}
                                className={cn(
                                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[0.8125rem]",
                                    index === active && "bg-option-hover"
                                )}
                            >
                                {row.remote ? (
                                    <MapPin aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
                                ) : (
                                    <Globe aria-hidden className="size-4 shrink-0 text-foreground-subtle" />
                                )}
                                <span className="min-w-0 flex-1 truncate" title={[row.title, row.detail].filter(Boolean).join(", ")}>
                                    {row.title}
                                    {row.detail ? (
                                        <span className="text-muted-foreground">{`, ${row.detail}`}</span>
                                    ) : null}
                                </span>
                                <span className="shrink-0 truncate text-xs text-foreground-subtle" title={row.zone}>
                                    {row.zone}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <div aria-live="polite" className="px-2 py-1.5 text-xs text-muted-foreground">
                        {remote.state === "loading" ? (
                            <span className="flex items-center gap-1.5">
                                <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
                                {t("time.world.searching")}
                            </span>
                        ) : remote.state === "failed" ? (
                            <span role="alert" className="flex flex-wrap items-center gap-2">
                                <span className="min-w-0">{remote.message || t("time.world.searchFailed")}</span>
                                <Button size="sm" variant="outline" onClick={() => setAttempt(attempt + 1)}>
                                    {t("screen.retry")}
                                </Button>
                            </span>
                        ) : rows.length === 0 && typed.length >= 2 && remote.state === "done" ? (
                            t("zonePicker.none")
                        ) : typed.length < 2 && rows.length === 0 ? (
                            t("time.world.keepTyping")
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
