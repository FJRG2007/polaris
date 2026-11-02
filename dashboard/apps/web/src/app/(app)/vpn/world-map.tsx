"use client";

/**
 * Where the VPN can come out. A country with a server is lit and has a marker;
 * pressing it picks that country's first server. The list beside the map holds
 * the same choices, so the map is never the only way to reach one.
 *
 * Country shapes are Natural Earth (public domain) at 1:110m through the
 * world-atlas package (ISC), drawn ahead of time into `world-map.json` so the page
 * needs no map library and no tile server. The file is fetched with the screen's
 * own chunk, after the first paint.
 */

import { cn, Skeleton } from "@polaris/ui";
import { useEffect, useMemo, useState } from "react";

interface WorldMapData {
    readonly width: number;
    readonly height: number;
    readonly land: string;
    readonly countries: readonly {
        readonly id: string;
        readonly x: number;
        readonly y: number;
        readonly d: string;
    }[];
}

export interface MapPlace {
    readonly id: string;
    readonly country: string;
    readonly label: string;
}

export function WorldMap({
    places,
    selected,
    active,
    onSelect
}: {
    places: readonly MapPlace[];
    selected: string | null;
    active: string | null;
    onSelect: (id: string) => void;
}) {
    const [map, setMap] = useState<WorldMapData | null>(null);

    useEffect(() => {
        void import("./world-map.json")
            .then((module) => setMap(module.default as WorldMapData))
            .catch(() => undefined);
    }, []);

    const byCountry = useMemo(() => {
        const grouped = new Map<string, MapPlace[]>();
        for (const place of places) {
            grouped.set(place.country, [...(grouped.get(place.country) ?? []), place]);
        }
        return grouped;
    }, [places]);

    if (!map) return <Skeleton className="aspect-[2/1] w-full" />;
    const marked = map.countries.filter(({ id }) => byCountry.has(id));
    return (
        <svg
            viewBox={`0 0 ${map.width} ${map.height}`}
            className="h-auto w-full"
            role="group"
            aria-hidden={marked.length === 0 ? true : undefined}
        >
            <path d={map.land} className="fill-muted" />
            {map.countries.map(({ id, d }) => (
                <path
                    key={id}
                    d={d}
                    className={cn(
                        "stroke-background [stroke-width:0.5]",
                        byCountry.has(id) ? "fill-primary/30" : "fill-muted"
                    )}
                />
            ))}
            {marked.map(({ id, x, y }) => {
                const here = byCountry.get(id) ?? [];
                const isSelected = here.some((place) => place.id === selected);
                const isActive = here.some((place) => place.id === active);
                const first = here[0];
                if (!first) return null;
                return (
                    <g
                        key={id}
                        role="button"
                        tabIndex={0}
                        aria-label={here.map((place) => place.label).join(", ")}
                        aria-pressed={isSelected}
                        className="cursor-pointer outline-none"
                        onClick={() => onSelect(first.id)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            onSelect(first.id);
                        }}
                    >
                        <title>{here.map((place) => place.label).join(", ")}</title>
                        {/* A finger needs more than the dot. */}
                        <circle cx={x} cy={y} r={18} className="fill-transparent" />
                        <circle
                            cx={x}
                            cy={y}
                            r={isSelected ? 8 : 6}
                            className={cn(
                                "stroke-background [stroke-width:2]",
                                isActive ? "fill-success" : "fill-primary"
                            )}
                        />
                    </g>
                );
            })}
        </svg>
    );
}
