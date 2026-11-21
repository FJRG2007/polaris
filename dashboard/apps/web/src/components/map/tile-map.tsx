"use client";

/**
 * A street map around one or more points, drawn from square tiles the way every
 * web map has been since Google Maps: the world in Web Mercator, cut into 256 px
 * squares per zoom level, the ones around the point laid side by side.
 *
 * No map library. The tiles come through Polaris (`/api/chat/location/tile`), so
 * the reader's address never reaches the tile service. `style` picks streets,
 * satellite or both (`lib/map-layers.ts`); the satellite imagery is whichever
 * provider the administrator chose (`useImagery`), drawn as deep as it goes and
 * stretched past that, so the zoom never stops short.
 *
 * The credit is the way Apple Maps gives it: a small, quiet "Legal" in the
 * bottom-left corner that opens the full lines on a press. It is never removed -
 * the ODbL and the imagery licence require it on the map.
 *
 * With `controls`, the map is a full one: zoom with the buttons, the mouse
 * wheel or a pinch, and drag (or swipe) to move around.
 */

import { cn } from "@polaris/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { MAP_MAX_ZOOM, TILE_SOURCES, maxZoomOf, sourcesOf, tilePath, type MapStyle } from "@/lib/map-layers";
import { useImagery } from "@/components/map/use-imagery";

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = MAP_MAX_ZOOM;
/** The widest the map is ever drawn; tiles are laid to cover this much. */
const MAX_WIDTH = 1024;

export interface MapPoint {
    readonly latitude: number;
    readonly longitude: number;
    /** Metres; drawn as a faint circle around the pin. */
    readonly accuracy?: number | null;
    /** A name on the pin; its first letters are drawn. */
    readonly label?: string;
    /** A live share still moving, drawn pulsing. */
    readonly live?: boolean;
    /** The reader's own position: the blue dot, not a pin. */
    readonly self?: boolean;
    /** A bubble above a dropped pin: who, and a line under it. */
    readonly callout?: { readonly title: string; readonly detail?: string };
}

/** Pixel position of a point on the whole world at a zoom. Pure; exported for tests. */
export function worldPixel(latitude: number, longitude: number, zoom: number): { x: number; y: number } {
    const size = TILE * 2 ** zoom;
    const lat = Math.max(-85.0511, Math.min(85.0511, latitude)) * (Math.PI / 180);
    return {
        x: ((longitude + 180) / 360) * size,
        y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * size
    };
}

/** Metres one pixel covers at a latitude and zoom. Pure; exported for tests. */
export function metersPerPixel(latitude: number, zoom: number): number {
    return (156_543.034 * Math.cos(latitude * (Math.PI / 180))) / 2 ** zoom;
}

/** The deepest zoom that keeps every point inside a box of this size. Pure; exported for tests. */
export function fittingZoom(points: readonly MapPoint[], width: number, height: number, ceiling = 16): number {
    if (points.length < 2) return ceiling;
    for (let zoom = ceiling; zoom > MIN_ZOOM; zoom -= 1) {
        const pixels = points.map((point) => worldPixel(point.latitude, point.longitude, zoom));
        const xs = pixels.map((pixel) => pixel.x);
        const ys = pixels.map((pixel) => pixel.y);
        if (Math.max(...xs) - Math.min(...xs) < width * 0.8 && Math.max(...ys) - Math.min(...ys) < height * 0.8) {
            return zoom;
        }
    }
    return MIN_ZOOM;
}

function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    return words
        .slice(0, 2)
        .map((word) => Array.from(word)[0] ?? "")
        .join("")
        .toUpperCase();
}

export function TileMap({
    points,
    height = 160,
    zoom: startZoom,
    controls = false,
    zoomButtons = controls,
    style = "map",
    creditClassName,
    className
}: {
    points: readonly MapPoint[];
    /** Pixels, or a CSS length for a map that fills its parent. */
    height?: number | string;
    zoom?: number;
    /** Wheel, drag and pinch, for the full-size map. */
    controls?: boolean;
    /** The +/- buttons; a phone pinches instead. */
    zoomButtons?: boolean;
    style?: MapStyle;
    /** Where the "Legal" credit sits, when the bottom-left corner is taken. */
    creditClassName?: string;
    className?: string;
}) {
    const t = useTranslations("chat");
    // Tiles are laid to cover this much height; a fluid map covers a tall phone.
    const tall = typeof height === "number" ? height : MAX_WIDTH;
    const maxZoom = Math.min(MAX_ZOOM, maxZoomOf(style));
    const imagery = useImagery(style !== "map");
    const [zoom, setZoom] = useState(() => Math.min(maxZoom, startZoom ?? fittingZoom(points, 320, tall)));
    // How far the map was dragged from its points, in pixels at the current zoom.
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [credit, setCredit] = useState(false);
    const box = useRef<HTMLDivElement>(null);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const maxRef = useRef(maxZoom);
    maxRef.current = maxZoom;

    /** One zoom step in or out, keeping the middle of the view where it is. */
    const zoomBy = (by: number) => {
        const next = Math.max(MIN_ZOOM, Math.min(maxRef.current, zoomRef.current + by));
        if (next === zoomRef.current) return;
        const scale = 2 ** (next - zoomRef.current);
        zoomRef.current = next;
        setPan((current) => ({ x: current.x * scale, y: current.y * scale }));
        setZoom(next);
    };

    // A style that blurs past some zoom (satellite) steps back out to it.
    useEffect(() => {
        if (zoomRef.current > maxZoom) zoomBy(maxZoom - zoomRef.current);
    }, [maxZoom]);

    // The wheel zooms a full map. Registered by hand: React's wheel listener is
    // passive, and the page must not scroll under the map while it zooms.
    useEffect(() => {
        const element = box.current;
        if (!element || !controls) return;
        let gathered = 0;
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            // A mouse notch is about 100; a trackpad sends many small ones.
            gathered += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
            if (Math.abs(gathered) < 60) return;
            zoomBy(gathered < 0 ? 1 : -1);
            gathered = 0;
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => element.removeEventListener("wheel", wheel);
    }, [controls]);

    // Drag to move, two fingers to pinch.
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const pinch = useRef(0);
    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if ((event.target as HTMLElement).closest("button, a, [role=button], [data-map-credits]")) return;
        setCredit(false);
        if (!controls) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        pinch.current = spread(pointers.current);
    };
    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        const last = pointers.current.get(event.pointerId);
        if (!last) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size >= 2) {
            const now = spread(pointers.current);
            if (pinch.current > 0 && (now / pinch.current > 1.5 || now / pinch.current < 0.67)) {
                zoomBy(now > pinch.current ? 1 : -1);
                pinch.current = now;
            }
            return;
        }
        const dx = event.clientX - last.x;
        const dy = event.clientY - last.y;
        setPan((current) => ({ x: current.x - dx, y: current.y - dy }));
    };
    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(event.pointerId);
        pinch.current = spread(pointers.current);
    };

    const view = useMemo(() => {
        if (points.length === 0) return null;
        const pixels = points.map((point) => worldPixel(point.latitude, point.longitude, zoom));
        const center = {
            x: (Math.min(...pixels.map((pixel) => pixel.x)) + Math.max(...pixels.map((pixel) => pixel.x))) / 2 + pan.x,
            y: (Math.min(...pixels.map((pixel) => pixel.y)) + Math.max(...pixels.map((pixel) => pixel.y))) / 2 + pan.y
        };
        const tiles: { key: string; src: string; left: number; top: number; size: number }[] = [];
        for (const source of sourcesOf(style)) {
            // Past the deepest zoom a source draws, its last tiles are stretched.
            const deepest = source === "imagery" ? imagery.nativeMaxZoom : TILE_SOURCES[source].nativeMaxZoom;
            const z = Math.min(zoom, deepest);
            const size = TILE * 2 ** (zoom - z);
            const count = 2 ** z;
            const across = Math.ceil(MAX_WIDTH / 2 / size) + 1;
            const down = Math.ceil(tall / 2 / size) + 1;
            const cx = Math.floor(center.x / size);
            const cy = Math.floor(center.y / size);
            for (let dx = -across; dx <= across; dx += 1) {
                for (let dy = -down; dy <= down; dy += 1) {
                    const ty = cy + dy;
                    if (ty < 0 || ty >= count) continue;
                    const tx = (((cx + dx) % count) + count) % count;
                    tiles.push({
                        key: `${source}/${source === "imagery" ? imagery.version : ""}/${z}/${cx + dx}/${ty}`,
                        src: tilePath(source, z, tx, ty, source === "imagery" ? imagery.version : undefined),
                        left: (cx + dx) * size - center.x,
                        top: ty * size - center.y,
                        size
                    });
                }
            }
        }
        const pins = points.map((point, index) => {
            const pixel = pixels[index] ?? { x: center.x, y: center.y };
            const radius = point.accuracy ? point.accuracy / metersPerPixel(point.latitude, zoom) : 0;
            return { point, left: pixel.x - center.x, top: pixel.y - center.y, radius };
        });
        return { tiles, pins };
    }, [points, zoom, tall, pan, style, imagery]);
    const credits = sourcesOf(style).flatMap((source) =>
        source === "imagery" ? imagery.credits : [TILE_SOURCES[source].credit]
    );

    if (!view) return null;
    return (
        <div
            ref={box}
            dir="ltr"
            className={cn(
                "relative isolate w-full select-none overflow-hidden bg-muted",
                controls && "cursor-grab touch-none active:cursor-grabbing",
                className
            )}
            style={{ height }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
        >
            {view.tiles.map((tile) => (
                <img
                    key={tile.key}
                    src={tile.src}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    width={tile.size}
                    height={tile.size}
                    className="absolute max-w-none"
                    style={{ left: `calc(50% + ${tile.left}px)`, top: `calc(50% + ${tile.top}px)` }}
                />
            ))}
            {view.pins.map(({ point, left, top, radius }, index) => (
                <div
                    key={index}
                    className="pointer-events-none absolute"
                    style={{ left: `calc(50% + ${left}px)`, top: `calc(50% + ${top}px)` }}
                >
                    {radius > 6 && radius < MAX_WIDTH ? (
                        <span
                            aria-hidden
                            className={cn(
                                "absolute rounded-full border",
                                point.self ? "border-sky-500/40 bg-sky-500/15" : "border-primary/40 bg-primary/15"
                            )}
                            style={{ width: radius * 2, height: radius * 2, left: -radius, top: -radius }}
                        />
                    ) : null}
                    {point.self ? (
                        <span
                            className="absolute -left-2 -top-2 size-4 rounded-full border-[3px] border-white bg-sky-500 shadow-md"
                            title={point.label}
                        />
                    ) : point.callout ? (
                        <>
                            {/* A dropped pin: a red head on a stick, the point at its foot. */}
                            <span aria-hidden className="absolute -left-px -top-6 h-6 w-0.5 rounded-full bg-neutral-500" />
                            <span
                                aria-hidden
                                className="absolute -left-2 -top-9 size-4 rounded-full border border-red-800 bg-red-500 shadow"
                            />
                            {point.live ? (
                                <span
                                    aria-hidden
                                    className="absolute -left-2 -top-2 size-4 animate-ping rounded-full bg-emerald-500 opacity-50"
                                />
                            ) : null}
                            <span className="absolute bottom-11 left-0 flex w-max max-w-[min(18rem,80vw)] -translate-x-1/2 flex-col items-center">
                                <span className="flex min-w-0 max-w-full items-stretch overflow-hidden rounded-xl bg-neutral-800/95 text-white shadow-lg">
                                    <span className="grid w-11 shrink-0 place-items-center bg-emerald-500 text-sm font-semibold">
                                        {point.label ? initials(point.label) : null}
                                    </span>
                                    <span className="flex min-w-0 flex-col justify-center px-3 py-2">
                                        <span className="truncate text-[15px] leading-5">{point.callout.title}</span>
                                        {point.callout.detail ? (
                                            <span className="truncate text-xs leading-4 text-white/70">
                                                {point.callout.detail}
                                            </span>
                                        ) : null}
                                    </span>
                                </span>
                                <span
                                    aria-hidden
                                    className="size-0 border-x-[7px] border-t-[7px] border-x-transparent border-t-neutral-800/95"
                                />
                            </span>
                        </>
                    ) : (
                        <>
                            {point.live ? (
                                <span
                                    aria-hidden
                                    className="absolute -left-3 -top-3 size-6 animate-ping rounded-full bg-primary/40"
                                />
                            ) : null}
                            <span
                                className="absolute -left-3 -top-3 grid size-6 place-items-center overflow-hidden rounded-full border-2 border-background bg-primary text-[10px] font-semibold text-primary-foreground shadow"
                                title={point.label}
                            >
                                {point.label ? initials(point.label) : null}
                            </span>
                        </>
                    )}
                </div>
            ))}
            {zoomButtons ? (
                <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-border bg-background shadow">
                    <button
                        type="button"
                        aria-label={t("location.zoomIn")}
                        title={t("location.zoomIn")}
                        disabled={zoom >= maxZoom}
                        onClick={() => zoomBy(1)}
                        className="grid size-8 place-items-center hover:bg-muted disabled:opacity-50"
                    >
                        <Plus className="size-4 shrink-0" />
                    </button>
                    <button
                        type="button"
                        aria-label={t("location.zoomOut")}
                        title={t("location.zoomOut")}
                        disabled={zoom <= MIN_ZOOM}
                        onClick={() => zoomBy(-1)}
                        className="grid size-8 place-items-center border-t border-border hover:bg-muted disabled:opacity-50"
                    >
                        <Minus className="size-4 shrink-0" />
                    </button>
                </div>
            ) : null}
            {/* The licences ask for the credit on the map; it stays, small and quiet,
                and opens to the full lines. A span, as the map in a card sits in a button. */}
            <div data-map-credits className={cn("absolute bottom-1 start-1.5 z-10", creditClassName)}>
                {credit ? (
                    <div className="absolute bottom-full left-0 mb-1 flex w-max max-w-[min(20rem,calc(100vw-2rem))] flex-col gap-1 rounded-md bg-background/95 p-2 text-[11px] leading-snug text-foreground shadow-lg">
                        {credits.map((line, index) => (
                            <a
                                key={`${index}/${line.href}`}
                                href={line.href}
                                target="_blank"
                                rel="noreferrer noopener"
                                onClick={(event) => event.stopPropagation()}
                                className="hover:underline"
                            >
                                {line.text}
                            </a>
                        ))}
                    </div>
                ) : null}
                <span
                    role="button"
                    tabIndex={0}
                    aria-label={t("location.mapCredits")}
                    aria-expanded={credit}
                    onClick={(event) => {
                        // The map in a card opens the big one when pressed; this does not.
                        event.stopPropagation();
                        event.preventDefault();
                        setCredit((open) => !open);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.stopPropagation();
                        event.preventDefault();
                        setCredit((open) => !open);
                    }}
                    className="cursor-pointer text-[10px] text-white/75 underline decoration-white/40 underline-offset-2 [text-shadow:0_0_2px_rgb(0_0_0/0.8)] hover:text-white"
                >
                    {t("location.legal")}
                </span>
            </div>
        </div>
    );
}

/** How far apart the first two pointers are; 0 with fewer than two. */
function spread(pointers: Map<number, { x: number; y: number }>): number {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
