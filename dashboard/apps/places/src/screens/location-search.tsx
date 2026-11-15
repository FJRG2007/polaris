"use client";

/**
 * A city or an address, found by typing its name: the search is asked a
 * moment after typing stops, an older answer arriving late is dropped, and
 * each result is one press. Shared by a place's location and a weather card's.
 */

import { usePlacesT } from "./use-places-t";
import { Input, Skeleton } from "@polaris/ui";
import { MapPin, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { searchLocationsAction } from "./location-actions";
import { geocodeQuerySchema, type GeoPlace } from "../lib/geocoding-kinds";

const WAIT_MS = 350;

type Found =
    | { readonly state: "idle" }
    | { readonly state: "searching" }
    | { readonly state: "failed" }
    | { readonly state: "done"; readonly places: readonly GeoPlace[] };

export function LocationSearch({
    onPick,
    disabled,
    autoFocus
}: {
    onPick: (place: GeoPlace) => void;
    disabled?: boolean;
    autoFocus?: boolean;
}) {
    const t = usePlacesT();
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<Found>({ state: "idle" });
    const asked = useRef(0);

    useEffect(() => {
        const parsed = geocodeQuerySchema.safeParse(query);
        if (!parsed.success) {
            asked.current += 1;
            setFound({ state: "idle" });
            return;
        }
        const ask = ++asked.current;
        setFound({ state: "searching" });
        const timer = setTimeout(() => {
            searchLocationsAction(parsed.data)
                .then((answer) => {
                    if (ask !== asked.current) return;
                    setFound(
                        answer.failed
                            ? { state: "failed" }
                            : { state: "done", places: answer.places }
                    );
                })
                .catch(() => {
                    if (ask === asked.current) setFound({ state: "failed" });
                });
        }, WAIT_MS);
        return () => clearTimeout(timer);
    }, [query]);

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 shrink-0 text-foreground-subtle" />
                <Input
                    type="search"
                    value={query}
                    autoFocus={autoFocus}
                    disabled={disabled}
                    maxLength={100}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t("locationSearch.placeholder")}
                    aria-label={t("locationSearch.placeholder")}
                    className="pl-8"
                />
            </div>
            {found.state === "searching" ? (
                <div className="flex flex-col gap-1.5" aria-busy>
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                </div>
            ) : found.state === "failed" ? (
                <p role="alert" className="text-[0.75rem] text-danger">
                    {t("locationSearch.failed")}
                </p>
            ) : found.state === "done" && found.places.length === 0 ? (
                <p className="text-[0.75rem] text-muted-foreground">{t("locationSearch.none")}</p>
            ) : found.state === "done" ? (
                <ul
                    className="flex max-h-56 min-w-0 flex-col overflow-y-auto overscroll-contain rounded-md border border-border"
                    aria-label={t("locationSearch.results")}
                >
                    {found.places.map((place) => (
                        <li key={place.id}>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() => onPick(place)}
                                className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                                <MapPin className="size-4 shrink-0 text-muted-foreground" />
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate" title={place.name}>
                                        {place.name}
                                    </span>
                                    {place.detail ? (
                                        <span
                                            className="truncate text-xs text-muted-foreground"
                                            title={place.detail}
                                        >
                                            {place.detail}
                                        </span>
                                    ) : null}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}
