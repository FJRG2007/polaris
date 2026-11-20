"use client";

/**
 * A street map around one or more points, drawn from square tiles the way every
 * web map has been since Google Maps: the world in Web Mercator, cut into 256 px
 * squares per zoom level, the ones around the point laid side by side.
 *
 * No map library. The tiles come through Polaris (`/api/chat/location/tile`), so
 * the reader's address never reaches the tile service, and the default service
 * is OpenStreetMap's - free, keyless, credited in the corner as its licence asks.
 */

import { cn } from "@polaris/ui";
import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
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
    className
}: {
    points: readonly MapPoint[];
    height?: number;
    zoom?: number;
    /** Zoom buttons, for the full-size map. */
    controls?: boolean;
    className?: string;
}) {
    const t = useTranslations("chat");
    const [zoom, setZoom] = useState(() => startZoom ?? fittingZoom(points, 320, height));

    const view = useMemo(() => {
        if (points.length === 0) return null;
        const pixels = points.map((point) => worldPixel(point.latitude, point.longitude, zoom));
        const center = {
            x: (Math.min(...pixels.map((pixel) => pixel.x)) + Math.max(...pixels.map((pixel) => pixel.x))) / 2,
            y: (Math.min(...pixels.map((pixel) => pixel.y)) + Math.max(...pixels.map((pixel) => pixel.y))) / 2
        };
        const count = 2 ** zoom;
        const across = Math.ceil(MAX_WIDTH / 2 / TILE) + 1;
        const down = Math.ceil(height / 2 / TILE) + 1;
        const cx = Math.floor(center.x / TILE);
        const cy = Math.floor(center.y / TILE);
        const tiles: { key: string; src: string; left: number; top: number }[] = [];
        for (let dx = -across; dx <= across; dx += 1) {
            for (let dy = -down; dy <= down; dy += 1) {
                const ty = cy + dy;
                if (ty < 0 || ty >= count) continue;
                const tx = (((cx + dx) % count) + count) % count;
                tiles.push({
                    key: `${zoom}/${cx + dx}/${ty}`,
                    src: `/api/chat/location/tile/${zoom}/${tx}/${ty}`,
                    left: (cx + dx) * TILE - center.x,
                    top: ty * TILE - center.y
                });
            }
        }
        const pins = points.map((point, index) => {
            const pixel = pixels[index] ?? { x: center.x, y: center.y };
            const radius = point.accuracy ? point.accuracy / metersPerPixel(point.latitude, zoom) : 0;
            return { point, left: pixel.x - center.x, top: pixel.y - center.y, radius };
        });
        return { tiles, pins };
    }, [points, zoom, height]);

    if (!view) return null;
    return (
        <div
            dir="ltr"
            className={cn("relative isolate w-full select-none overflow-hidden bg-muted", className)}
            style={{ height }}
        >
            {view.tiles.map((tile) => (
                <img
                    key={tile.key}
                    src={tile.src}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    width={TILE}
                    height={TILE}
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
                            className="absolute rounded-full border border-primary/40 bg-primary/15"
                            style={{ width: radius * 2, height: radius * 2, left: -radius, top: -radius }}
                        />
                    ) : null}
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
                </div>
            ))}
            {controls ? (
                <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-md border border-border bg-background shadow">
                    <button
                        type="button"
                        aria-label={t("location.zoomIn")}
                        title={t("location.zoomIn")}
                        disabled={zoom >= MAX_ZOOM}
                        onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + 1))}
                        className="grid size-8 place-items-center hover:bg-muted disabled:opacity-50"
                    >
                        <Plus className="size-4 shrink-0" />
                    </button>
                    <button
                        type="button"
                        aria-label={t("location.zoomOut")}
                        title={t("location.zoomOut")}
                        disabled={zoom <= MIN_ZOOM}
                        onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - 1))}
                        className="grid size-8 place-items-center border-t border-border hover:bg-muted disabled:opacity-50"
                    >
                        <Minus className="size-4 shrink-0" />
                    </button>
                </div>
            ) : null}
            <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => event.stopPropagation()}
                className="absolute bottom-0 right-0 bg-background/80 px-1 text-[10px] text-muted-foreground"
            >
                {t("location.attribution")}
            </a>
        </div>
    );
}
