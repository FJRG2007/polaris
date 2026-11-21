/**
 * The map styles a location can be looked at in, and the tile sources behind
 * them. Shared by the tile route (which fetches) and the map (which draws and
 * credits), so the credit on screen always names the source that drew it.
 *
 * Every source is free, needs no account or key, and allows this use with
 * attribution:
 *
 * - Streets: OpenStreetMap's standard tiles, ODbL data, under the tile usage
 *   policy (https://operations.osmfoundation.org/policies/tiles/).
 * - Imagery: EOX's Sentinel-2 cloudless mosaic of 2016, the one release under
 *   CC BY 4.0 - later years are CC BY-NC-SA (https://cloudless.eox.at/documentation/license,
 *   and the layer abstract in https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml).
 *   EOX::Maps asks for "a link back to EOX::Maps as well as appropriate
 *   attribution" (https://maps.eox.at/). Sentinel-2 is 10 m a pixel, so street
 *   level is soft; an instance with a sharper keyed source names it with
 *   `POLARIS_MAP_IMAGERY_URL`.
 * - Labels (the Hybrid overlay): EOX's transparent "Overlay bright", drawn from
 *   OpenStreetMap data, same EOX::Maps terms. Rendered to zoom 14 only; deeper,
 *   the map stretches the zoom-14 tile (`nativeMaxZoom`).
 *
 * Pure; safe on both sides.
 */

/** What the reader picks. */
export type MapStyle = "map" | "hybrid" | "satellite";
export const MAP_STYLES: readonly MapStyle[] = ["map", "hybrid", "satellite"];

/** What the tile route serves. */
export type TileSource = "streets" | "imagery" | "labels";

export interface TileSourceInfo {
    /** `{z}/{x}/{y}` template; an operator's own may replace it by its env key. */
    readonly template: string;
    readonly env: string;
    /** The deepest zoom the source draws; the map stretches past it. */
    readonly nativeMaxZoom: number;
    /** The deepest zoom still worth looking at; the map does not go past it. */
    readonly usefulMaxZoom: number;
    readonly credit: { readonly text: string; readonly href: string };
}

export const TILE_SOURCES: Readonly<Record<TileSource, TileSourceInfo>> = {
    streets: {
        template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        env: "POLARIS_MAP_TILE_URL",
        nativeMaxZoom: 19,
        usefulMaxZoom: 19,
        // i18n-ignore: licence credit, the same in every language
        credit: { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" }
    },
    imagery: {
        template: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
        env: "POLARIS_MAP_IMAGERY_URL",
        nativeMaxZoom: 18,
        // 10 m a pixel: from here in it is a blur, so a satellite map stops here.
        usefulMaxZoom: 15,
        credit: {
            // i18n-ignore: licence credit, the same in every language
            text: "Sentinel-2 cloudless 2016 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016), CC BY 4.0",
            href: "https://s2maps.eu"
        }
    },
    labels: {
        template: "https://tiles.maps.eox.at/wmts/1.0.0/overlay_bright_3857/default/g/{z}/{y}/{x}.png",
        env: "POLARIS_MAP_LABELS_URL",
        nativeMaxZoom: 14,
        usefulMaxZoom: 19,
        // i18n-ignore: licence credit, the same in every language
        credit: { text: "Overlay © EOX::Maps, data © OpenStreetMap contributors", href: "https://maps.eox.at" }
    }
};

/** The tile layers a style draws, bottom first. */
export function sourcesOf(style: MapStyle): readonly TileSource[] {
    return style === "map" ? ["streets"] : style === "satellite" ? ["imagery"] : ["imagery", "labels"];
}

/** The deepest zoom a style is drawn at. */
export function maxZoomOf(style: MapStyle): number {
    return Math.min(...sourcesOf(style).map((source) => TILE_SOURCES[source].usefulMaxZoom));
}

/** The address a source's tiles come from in the browser: always through Polaris. */
export function tilePath(source: TileSource, z: number, x: number, y: number): string {
    const path = `/api/chat/location/tile/${z}/${x}/${y}`;
    return source === "streets" ? path : `${path}?layer=${source}`;
}
