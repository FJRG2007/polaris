"use client";

/**
 * The one map in Polaris. The same outlines serve every use, from the plainest
 * to the richest:
 *
 * - countries shaded by a value (Analytics' visitors by country), named on hover;
 * - places marked where they are, by latitude and longitude when known and at
 *   their country's middle when not, picked by pressing them (VPN's exits);
 * - pressing any spot of land, to say where something is (placing a VPN server).
 *
 * It zooms and pans (wheel once the map has focus or with Ctrl, drag, pinch, the
 * buttons, and the keyboard: arrows, + and -, 0 for the whole world), so several
 * places in one country can be told apart and picked. Places that would sit on
 * top of each other at the current zoom are drawn as one marker with their
 * count, as map pickers have done since Leaflet.markercluster; pressing it zooms
 * until they part, or, when nothing would part them (one town), lays them out
 * around it.
 *
 * Country shapes are Natural Earth (public domain) at 1:110m through the
 * world-atlas package (ISC), drawn ahead of time into `world-map.json` by
 * `scripts/gen-world-map.mjs` so the page needs no map library and no tile
 * server, and works offline. The file is fetched once, after the first paint.
 */

import * as ui from "@polaris/ui";
import * as geo from "./projection";
import { countryName } from "./country-name";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

interface WorldShape extends geo.Projection {
    readonly w: number;
    readonly h: number;
    readonly countries: readonly {
        /** ISO 3166-1 alpha-2, or "" for the few shapes with none. */
        readonly c: string;
        readonly n: string;
        readonly d: string;
        /** The middle of the country's biggest piece. */
        readonly x: number;
        readonly y: number;
        readonly b: geo.Box;
    }[];
}

let world: Promise<WorldShape> | null = null;

function loadWorld(): Promise<WorldShape> {
    world ??= import("./world-map.json")
        .then((module) => (module.default ?? module) as unknown as WorldShape)
        .catch((error: unknown) => {
            world = null;
            throw error;
        });
    return world;
}

export interface MapPlace {
    readonly id: string;
    readonly label: string;
    readonly country: string | null;
    readonly latitude?: number | null;
    readonly longitude?: number | null;
}

/** A spot of land somebody pressed. */
export interface MapPick {
    readonly country: string;
    readonly latitude: number;
    readonly longitude: number;
}

export interface WorldMapProps {
    /** What the map shows, for a screen reader. */
    readonly label: string;
    /** How strongly to shade a country, 0 to 1, or null to leave it plain. */
    readonly shade?: (code: string) => number | null;
    /** What hovering a country says. */
    readonly describe?: (code: string) => string | null;
    readonly places?: readonly MapPlace[];
    readonly selected?: string | null;
    /** A place drawn as in use (connected), apart from the selected one. */
    readonly active?: string | null;
    readonly onSelect?: (id: string) => void;
    /** When given, countries can be pressed, and say where they were pressed. */
    readonly onPick?: (pick: MapPick) => void;
    /** Which countries `onPick` takes; every one with a code when left out. */
    readonly pickable?: (code: string) => boolean;
}

/** Sizes in CSS pixels, turned into the outlines' units as the map is drawn. */
const DOT = 6;
const HIT = 16;
const BUBBLE = 11;
const GROUP = 22;
const FAN = 28;
const KEY_ZOOM = 1.5;
const KEY_PAN = 0.15;

interface Hover {
    readonly text: string;
    readonly x: number;
    readonly y: number;
}

export function WorldMap(props: WorldMapProps) {
    const [shape, setShape] = useState<WorldShape | null>(null);

    useEffect(() => {
        let live = true;
        void loadWorld()
            .then((loaded) => {
                if (live) setShape(loaded);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, []);

    if (!shape) return <ui.Skeleton className="aspect-[960/621] w-full" />;
    return <DrawnMap shape={shape} {...props} />;
}

function DrawnMap({
    shape,
    label,
    shade,
    describe,
    places = [],
    selected = null,
    active = null,
    onSelect,
    onPick,
    pickable
}: WorldMapProps & { readonly shape: WorldShape }) {
    const t = useTranslations("components");
    const locale = useLocale();
    const box = useRef<HTMLDivElement>(null);
    const svg = useRef<SVGSVGElement>(null);
    const [view, setView] = useState<geo.View>(geo.WHOLE);
    const [fanned, setFanned] = useState<string | null>(null);
    const [hover, setHover] = useState<Hover | null>(null);
    /** The outlines' units in one CSS pixel, so markers keep their size on a phone. */
    const [unit, setUnit] = useState(1);
    const pointers = useRef(new Map<number, geo.Point>());
    const gesture = useRef<{ start: geo.Point | null; dragged: boolean }>({
        start: null,
        dragged: false
    });
    const size = useMemo<geo.Size>(() => ({ w: shape.w, h: shape.h }), [shape]);

    const centroids = useMemo(
        () => new Map(shape.countries.map((country) => [country.c, country])),
        [shape]
    );
    const placed = useMemo(
        () =>
            places.flatMap((place): geo.Located<MapPlace>[] => {
                if (typeof place.latitude === "number" && typeof place.longitude === "number") {
                    return [
                        { ...geo.project(shape, place.latitude, place.longitude), item: place }
                    ];
                }
                const country = place.country ? centroids.get(place.country) : undefined;
                return country ? [{ x: country.x, y: country.y, item: place }] : [];
            }),
        [places, shape, centroids]
    );
    const withPlaces = useMemo(() => new Set(places.map((place) => place.country)), [places]);
    const clusters = useMemo(
        () => geo.cluster(placed, view, GROUP * unit, (place) => place.id),
        [placed, view, unit]
    );

    useEffect(() => {
        const element = svg.current;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            const width = element.getBoundingClientRect().width;
            setUnit(width > 0 ? shape.w / width : 1);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [shape]);

    /** A spot of the page, in the drawn map's units. */
    const toMap = (clientX: number, clientY: number): geo.Point => {
        const rect = svg.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return { x: shape.w / 2, y: shape.h / 2 };
        const scale = shape.w / rect.width;
        return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
    };

    useEffect(() => {
        const element = svg.current;
        if (!element) return;
        // The page keeps scrolling past a map nobody is using: the wheel zooms once
        // the map has focus, or with Ctrl held, the way embedded maps settled on.
        const wheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey && !element.contains(document.activeElement))
                return;
            event.preventDefault();
            const rect = element.getBoundingClientRect();
            const scale = rect.width > 0 ? shape.w / rect.width : 1;
            const at = {
                x: (event.clientX - rect.left) * scale,
                y: (event.clientY - rect.top) * scale
            };
            setView((current) => geo.zoomAt(current, Math.exp(-event.deltaY * 0.002), at, size));
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => element.removeEventListener("wheel", wheel);
    }, [shape, size]);

    const center = { x: size.w / 2, y: size.h / 2 };
    const zoomBy = (factor: number) =>
        setView((current) => geo.zoomAt(current, factor, center, size));

    function down(event: ReactPointerEvent<SVGSVGElement>): void {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        const at = toMap(event.clientX, event.clientY);
        pointers.current.set(event.pointerId, at);
        if (pointers.current.size === 1) gesture.current = { start: at, dragged: false };
    }

    function move(event: ReactPointerEvent<SVGSVGElement>): void {
        const before = pointers.current.get(event.pointerId);
        if (!before) return;
        const now = toMap(event.clientX, event.clientY);
        if (pointers.current.size === 1) {
            const start = gesture.current.start ?? before;
            if (!gesture.current.dragged && Math.hypot(now.x - start.x, now.y - start.y) < 4 * unit)
                return;
            if (!gesture.current.dragged) {
                gesture.current.dragged = true;
                // Only once it is a drag, so a press on a marker still reaches it.
                svg.current?.setPointerCapture?.(event.pointerId);
                setHover(null);
            }
            setView((current) => geo.panBy(current, now.x - before.x, now.y - before.y, size));
        } else if (pointers.current.size === 2) {
            const other = [...pointers.current.entries()].find(
                ([id]) => id !== event.pointerId
            )?.[1];
            if (other) {
                gesture.current.dragged = true;
                const was = Math.hypot(before.x - other.x, before.y - other.y);
                const is = Math.hypot(now.x - other.x, now.y - other.y);
                const middle = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
                if (was > 0) setView((current) => geo.zoomAt(current, is / was, middle, size));
            }
        }
        pointers.current.set(event.pointerId, now);
    }

    function up(event: ReactPointerEvent<SVGSVGElement>): void {
        pointers.current.delete(event.pointerId);
    }

    function keys(event: KeyboardEvent<SVGSVGElement>): void {
        const step = KEY_PAN * size.w;
        const moves: Record<string, () => void> = {
            ArrowLeft: () => setView((current) => geo.panBy(current, step, 0, size)),
            ArrowRight: () => setView((current) => geo.panBy(current, -step, 0, size)),
            ArrowUp: () => setView((current) => geo.panBy(current, 0, step, size)),
            ArrowDown: () => setView((current) => geo.panBy(current, 0, -step, size)),
            "+": () => zoomBy(KEY_ZOOM),
            "=": () => zoomBy(KEY_ZOOM),
            "-": () => zoomBy(1 / KEY_ZOOM),
            "0": () => setView(geo.WHOLE),
            Escape: () => setFanned(null)
        };
        const action = moves[event.key];
        if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        action();
    }

    /** Whatever a press does, unless the press was the end of a drag. */
    const pressed = (action: () => void) => () => {
        if (gesture.current.dragged) return;
        action();
    };
    const activate = (action: () => void) => (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        action();
    };

    function hoverAt(text: string | null, clientX: number, clientY: number): void {
        const rect = box.current?.getBoundingClientRect();
        if (!text || !rect || gesture.current.dragged) return setHover(null);
        setHover({ text, x: clientX - rect.left, y: clientY - rect.top });
    }

    function pickAt(code: string, spot: geo.Point): void {
        if (!onPick) return;
        onPick({ country: code, ...geo.unproject(shape, geo.onMap(view, spot)) });
    }

    function openGroup(group: geo.Cluster<MapPlace>): void {
        const next = geo.openCluster(group.members, size, GROUP * unit);
        if (next.kind === "zoom") {
            setFanned(null);
            setView(next.view);
        } else {
            setFanned(group.key);
        }
    }

    const takes = (code: string) =>
        Boolean(onPick) && code !== "" && (pickable ? pickable(code) : true);
    const width = box.current?.clientWidth ?? 0;

    function marker(place: MapPlace, at: geo.Point, key: string) {
        const isSelected = place.id === selected;
        return (
            <g
                key={key}
                role="button"
                tabIndex={0}
                aria-label={place.label}
                aria-pressed={onSelect ? isSelected : undefined}
                className="group cursor-pointer outline-none"
                onClick={pressed(() => onSelect?.(place.id))}
                onKeyDown={activate(() => onSelect?.(place.id))}
                onPointerMove={(event) => hoverAt(place.label, event.clientX, event.clientY)}
                onPointerLeave={() => setHover(null)}
            >
                <circle cx={at.x} cy={at.y} r={HIT * unit} className="fill-transparent" />
                <circle
                    cx={at.x}
                    cy={at.y}
                    r={(isSelected ? DOT + 2 : DOT) * unit}
                    strokeWidth={2 * unit}
                    className={ui.cn(
                        "stroke-background group-focus-visible:stroke-foreground",
                        place.id === active ? "fill-success" : "fill-primary"
                    )}
                />
                {isSelected ? (
                    <circle
                        cx={at.x}
                        cy={at.y}
                        r={(DOT + 5) * unit}
                        strokeWidth={1.5 * unit}
                        className="pointer-events-none fill-none stroke-primary"
                    />
                ) : null}
            </g>
        );
    }

    return (
        <div ref={box} className="relative min-w-0" onPointerLeave={() => setHover(null)}>
            <svg
                ref={svg}
                viewBox={`0 0 ${shape.w} ${shape.h}`}
                className="block h-auto w-full touch-pan-y select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={view.zoom > 1 ? { touchAction: "none" } : undefined}
                role="group"
                aria-label={label}
                aria-roledescription={t("map.role")}
                tabIndex={0}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onKeyDown={keys}
            >
                <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
                    {shape.countries.map((country, index) => {
                        const value = shade && country.c ? shade(country.c) : null;
                        const canPick = takes(country.c);
                        const name = country.c ? countryName(country.c, locale) : country.n;
                        return (
                            <path
                                key={`${country.c}-${index}`}
                                d={country.d}
                                vectorEffect="non-scaling-stroke"
                                strokeWidth={0.6}
                                fillOpacity={value !== null ? 0.25 + 0.75 * value : undefined}
                                className={ui.cn(
                                    "stroke-background outline-none transition-[fill,fill-opacity] duration-150",
                                    value !== null || (!shade && withPlaces.has(country.c))
                                        ? shade
                                            ? "fill-primary"
                                            : "fill-primary/25"
                                        : "fill-muted-foreground/15",
                                    canPick && "cursor-pointer",
                                    // A shaded country lights up whole; a plain one half way.
                                    canPick &&
                                        (shade
                                            ? "hover:[fill-opacity:1] focus-visible:[fill-opacity:1]"
                                            : "hover:fill-primary hover:[fill-opacity:0.5] focus-visible:fill-primary focus-visible:[fill-opacity:0.5]")
                                )}
                                role={canPick ? "button" : undefined}
                                tabIndex={canPick ? 0 : undefined}
                                aria-label={canPick ? name : undefined}
                                onPointerMove={
                                    describe && country.c
                                        ? (event) =>
                                              hoverAt(
                                                  describe(country.c),
                                                  event.clientX,
                                                  event.clientY
                                              )
                                        : undefined
                                }
                                onClick={
                                    canPick
                                        ? (event) => {
                                              if (gesture.current.dragged) return;
                                              pickAt(
                                                  country.c,
                                                  toMap(event.clientX, event.clientY)
                                              );
                                          }
                                        : undefined
                                }
                                onKeyDown={
                                    canPick
                                        ? activate(() =>
                                              pickAt(country.c, geo.onScreen(view, country))
                                          )
                                        : undefined
                                }
                            >
                                {describe ? null : <title>{name}</title>}
                            </path>
                        );
                    })}
                </g>
                <g>
                    {clusters.map((group) => {
                        const at = geo.onScreen(view, group);
                        const first = group.members[0];
                        if (!first) return null;
                        if (group.members.length === 1) return marker(first.item, at, group.key);
                        if (fanned === group.key) {
                            const spots = geo.fan(at, group.members.length, FAN * unit);
                            return (
                                <g key={group.key}>
                                    {spots.map((spot, index) => (
                                        <line
                                            key={index}
                                            x1={at.x}
                                            y1={at.y}
                                            x2={spot.x}
                                            y2={spot.y}
                                            strokeWidth={unit}
                                            className="pointer-events-none stroke-muted-foreground"
                                        />
                                    ))}
                                    {group.members.map((member, index) =>
                                        marker(member.item, spots[index] ?? at, member.item.id)
                                    )}
                                </g>
                            );
                        }
                        const names = group.members.map((member) => member.item.label).join(", ");
                        const holdsSelected = group.members.some(
                            (member) => member.item.id === selected
                        );
                        const holdsActive = group.members.some(
                            (member) => member.item.id === active
                        );
                        const text = t("map.group", { count: group.members.length, names });
                        return (
                            <g
                                key={group.key}
                                role="button"
                                tabIndex={0}
                                aria-label={text}
                                className="group cursor-pointer outline-none"
                                onClick={pressed(() => openGroup(group))}
                                onKeyDown={activate(() => openGroup(group))}
                                onPointerMove={(event) =>
                                    hoverAt(text, event.clientX, event.clientY)
                                }
                                onPointerLeave={() => setHover(null)}
                            >
                                <circle
                                    cx={at.x}
                                    cy={at.y}
                                    r={HIT * unit}
                                    className="fill-transparent"
                                />
                                <circle
                                    cx={at.x}
                                    cy={at.y}
                                    r={BUBBLE * unit}
                                    strokeWidth={(holdsSelected ? 3 : 2) * unit}
                                    className={ui.cn(
                                        "group-focus-visible:stroke-foreground",
                                        holdsActive ? "fill-success" : "fill-primary",
                                        holdsSelected
                                            ? "stroke-primary-foreground"
                                            : "stroke-background"
                                    )}
                                />
                                <text
                                    x={at.x}
                                    y={at.y}
                                    dy="0.35em"
                                    textAnchor="middle"
                                    fontSize={11 * unit}
                                    className="pointer-events-none fill-primary-foreground font-medium"
                                >
                                    {group.members.length}
                                </text>
                            </g>
                        );
                    })}
                </g>
            </svg>
            <div className="absolute right-2 top-2 flex flex-col gap-1">
                <ui.Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    aria-label={t("map.zoomIn")}
                    title={t("map.zoomIn")}
                    disabled={view.zoom >= geo.MAX_ZOOM}
                    onClick={() => zoomBy(2)}
                >
                    <Plus aria-hidden />
                </ui.Button>
                <ui.Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    aria-label={t("map.zoomOut")}
                    title={t("map.zoomOut")}
                    disabled={view.zoom <= 1}
                    onClick={() => zoomBy(0.5)}
                >
                    <Minus aria-hidden />
                </ui.Button>
                {view.zoom > 1 ? (
                    <ui.Button
                        type="button"
                        variant="secondary"
                        size="icon-sm"
                        aria-label={t("map.whole")}
                        title={t("map.whole")}
                        onClick={() => {
                            setFanned(null);
                            setView(geo.WHOLE);
                        }}
                    >
                        <Maximize2 aria-hidden />
                    </ui.Button>
                ) : null}
            </div>
            {hover ? (
                <div
                    role="tooltip"
                    className="pointer-events-none absolute z-10 max-w-[16rem] truncate rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-border"
                    style={{
                        top: Math.max(0, hover.y - 40),
                        // Flip to the left of the pointer in the right third, so it never runs off the card.
                        ...(hover.x > width * 0.66
                            ? { right: width - hover.x + 12 }
                            : { left: hover.x + 12 })
                    }}
                >
                    {hover.text}
                </div>
            ) : null}
        </div>
    );
}
