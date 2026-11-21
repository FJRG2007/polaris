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
 *   level is soft. An administrator can pick a sharper keyed provider under
 *   Admin > Integrations > Satellite imagery (`IMAGERY` below, fetched in
 *   `lib/map-imagery.ts`), and `POLARIS_MAP_IMAGERY_URL` still overrides every
 *   one of them with the instance's own source.
 * - Labels (the Hybrid overlay): EOX's transparent "Overlay bright", drawn from
 *   OpenStreetMap data, same EOX::Maps terms. Rendered to zoom 14 only; deeper,
 *   the map stretches the zoom-14 tile (`nativeMaxZoom`).
 *
 * Every style zooms to `MAP_MAX_ZOOM`. Past the deepest level a source draws,
 * the map stretches that level's tiles rather than stopping, so no provider -
 * the default one included - makes the zoom feel capped.
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
    readonly credit: MapCredit;
}

export interface MapCredit {
    readonly text: string;
    readonly href: string;
}

/** The deepest zoom any style is drawn at; past a source's own depth its tiles are stretched. */
export const MAP_MAX_ZOOM = 21;

export const TILE_SOURCES: Readonly<Record<TileSource, TileSourceInfo>> = {
    streets: {
        template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        env: "POLARIS_MAP_TILE_URL",
        nativeMaxZoom: 19,
        // i18n-ignore: licence credit, the same in every language
        credit: { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" }
    },
    imagery: {
        template: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg",
        env: "POLARIS_MAP_IMAGERY_URL",
        nativeMaxZoom: 18,
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
        // i18n-ignore: licence credit, the same in every language
        credit: { text: "Overlay © EOX::Maps, data © OpenStreetMap contributors", href: "https://maps.eox.at" }
    }
};

/** The tile layers a style draws, bottom first. */
export function sourcesOf(style: MapStyle): readonly TileSource[] {
    return style === "map" ? ["streets"] : style === "satellite" ? ["imagery"] : ["imagery", "labels"];
}

/** The deepest zoom a style is drawn at: the same for every style, since tiles past a source's depth are stretched. */
export function maxZoomOf(_style: MapStyle): number {
    return MAP_MAX_ZOOM;
}

/**
 * The address a source's tiles come from in the browser: always through Polaris.
 * `version` names the imagery source in use, so a browser that cached one
 * provider's tiles does not keep showing them after an administrator switches.
 */
export function tilePath(source: TileSource, z: number, x: number, y: number, version?: string): string {
    const path = `/api/chat/location/tile/${z}/${x}/${y}`;
    if (source === "streets") return path;
    if (source === "imagery" && version) return `${path}?layer=imagery&v=${encodeURIComponent(version)}`;
    return `${path}?layer=${source}`;
}

/**
 * The satellite imagery an administrator can choose from. "default" is the free
 * Sentinel-2 mosaic above; the others need the operator's own key, kept
 * encrypted on the server and never sent to a browser - their tiles go through
 * the same proxy as the rest, so a reader's address and what they look at never
 * reach the provider.
 *
 * - MapTiler: the Satellite tileset `satellite-v2`, zoom 0-22, JPEG
 *   (https://docs.maptiler.com/schema-raster/satellite/), through the Tiles API
 *   `https://api.maptiler.com/tiles/{tilesId}/{z}/{x}/{y}?key=` with the key in
 *   the `key` query parameter (https://docs.maptiler.com/cloud/api/tiles/). The
 *   terms require "(c) MapTiler" whenever maps are shown, with the MapTiler logo
 *   on a free account (https://www.maptiler.com/terms/ section 6.1), and the
 *   OpenStreetMap credit beside it
 *   (https://docs.maptiler.com/guides/map-design/attribution/add-attribution/).
 * - Esri ArcGIS Location Platform: the World Imagery map tile service
 *   `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=`
 *   (https://developers.arcgis.com/rest/basemap-styles/service-data/), billed per
 *   tile with 2 million free a month (https://developers.arcgis.com/rest/basemap-styles/).
 *   Its tiling scheme lists levels to 23, but sub-metre imagery is not everywhere
 *   past 19 and a missing tile is a "not yet available" placeholder, so 19 is the
 *   depth drawn and deeper is stretched. Credits: "Powered by Esri" and the
 *   layer's own source line (the item's accessInformation,
 *   https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9),
 *   under the Esri Master License Agreement, which is not for exporting tiles
 *   for offline use - the proxy keeps only tiles people looked at, for a day.
 *
 * The keyless server.arcgisonline.com endpoint is deliberately not offered: its
 * terms for use outside ArcGIS are unclear. Google's tiles are not allowed this
 * way at all, and Bing's are retired.
 */
export type ImageryProvider = "default" | "maptiler" | "esri";
export const IMAGERY_PROVIDERS: readonly ImageryProvider[] = ["default", "maptiler", "esri"];
export type KeyedImageryProvider = Exclude<ImageryProvider, "default">;

export interface ImageryProviderInfo {
    readonly name: string;
    readonly nativeMaxZoom: number;
    readonly credits: readonly MapCredit[];
}

export const IMAGERY: Readonly<Record<ImageryProvider, ImageryProviderInfo>> = {
    default: {
        name: "Sentinel-2 cloudless",
        nativeMaxZoom: TILE_SOURCES.imagery.nativeMaxZoom,
        credits: [TILE_SOURCES.imagery.credit]
    },
    maptiler: {
        name: "MapTiler",
        nativeMaxZoom: 22,
        credits: [
            // i18n-ignore: licence credit, the same in every language
            { text: "© MapTiler", href: "https://www.maptiler.com/copyright/" },
            // i18n-ignore: licence credit, the same in every language
            { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" }
        ]
    },
    esri: {
        name: "Esri World Imagery",
        nativeMaxZoom: 19,
        credits: [
            // i18n-ignore: licence credit, the same in every language
            { text: "Powered by Esri", href: "https://www.esri.com" },
            {
                // i18n-ignore: licence credit, the same in every language
                text: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
                href: "https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9"
            }
        ]
    }
};

/** What the map is told about the imagery in use: never a key, only what it draws and credits. */
export interface ImageryView {
    readonly provider: ImageryProvider | "custom";
    readonly nativeMaxZoom: number;
    readonly credits: readonly MapCredit[];
    /** Changes whenever the source does; part of every imagery tile's address. */
    readonly version: string;
}

/** The imagery a map assumes before the server has said: the free default. */
export const DEFAULT_IMAGERY_VIEW: ImageryView = {
    provider: "default",
    nativeMaxZoom: IMAGERY.default.nativeMaxZoom,
    credits: IMAGERY.default.credits,
    version: "default"
};
