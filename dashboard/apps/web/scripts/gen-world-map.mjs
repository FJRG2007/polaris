/**
 * Rebuild `src/components/map/world-map.json`: Natural Earth's 1:110m countries
 * (as published in world-atlas), projected once with Mercator so the browser
 * draws plain paths and ships no geo library. The projection's own numbers go
 * with them (`k`, `tx`, `ty`), so `src/components/map/projection.ts` can place a
 * latitude and longitude on the same paths with two lines of arithmetic.
 *
 * Mercator, like the analytics tools people compare this one with, because it is
 * the shape everybody recognises; Antarctica is left out, since nobody visits
 * from it and at this latitude it would take a third of the map.
 *
 * The geo libraries are not dependencies of the app. Install them anywhere and
 * pass that folder:
 *
 *   npm install --prefix <dir> d3-geo@3.1.1 topojson-client@3.1.0 world-atlas@2.0.2
 *   node scripts/gen-world-map.mjs <dir>
 *
 * Country codes are carried over from the file being replaced, matched by the
 * Natural Earth name, so the ISO 3166-1 alpha-2 keys never have to be retyped.
 */

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const tools = process.argv[2];
if (!tools) {
    console.error("usage: node scripts/gen-world-map.mjs <folder with d3-geo, topojson-client and world-atlas installed>");
    process.exit(1);
}

const require = createRequire(join(resolve(tools), "node_modules", "noop.js"));
const { geoArea, geoCentroid, geoMercator, geoPath } = require("d3-geo");
const { feature } = require("topojson-client");
const atlas = require("world-atlas/countries-110m.json");

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "src", "components", "map", "world-map.json");
const previous = JSON.parse(readFileSync(target, "utf8"));
const codeByName = new Map(previous.countries.map((country) => [country.n, country.c]));

const WIDTH = 960;
const all = feature(atlas, atlas.objects.countries).features;
const shown = all.filter((country) => country.properties.name !== "Antarctica");
const collection = { type: "FeatureCollection", features: shown };

// Fit the width, then take the height the land actually needs at that scale.
const projection = geoMercator().fitWidth(WIDTH, collection);
const [[, top], [, bottom]] = geoPath(projection).bounds(collection);
projection.translate([projection.translate()[0], projection.translate()[1] - top]);
const height = Math.ceil(bottom - top);
const path = geoPath(projection);

/** One decimal is a tenth of a pixel at full width: invisible, and half the bytes. */
const round = (d) => d.replace(/-?\d+\.\d+/g, (number) => String(Math.round(Number(number) * 10) / 10));

const tenth = (value) => Math.round(value * 10) / 10;

/**
 * The country's biggest piece, so France's marker and zoom are France and not a
 * point between Paris and French Guiana.
 */
function mainland(country) {
    if (country.geometry.type !== "MultiPolygon") return country;
    const pieces = country.geometry.coordinates.map((coordinates) => ({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates }
    }));
    return pieces.reduce((best, piece) => (geoArea(piece) > geoArea(best) ? piece : best));
}

const countries = shown.map((country) => {
    const name = country.properties.name;
    const code = codeByName.get(name);
    if (code === undefined) throw new Error(`no code for ${name}`);
    const main = mainland(country);
    const [x, y] = projection(geoCentroid(main));
    const [[x0, y0], [x1, y1]] = path.bounds(main);
    return {
        c: code,
        n: name,
        d: round(path(country) ?? ""),
        x: tenth(x),
        y: tenth(y),
        b: [tenth(x0), tenth(y0), tenth(x1), tenth(y1)]
    };
});

const [tx, ty] = projection.translate();
const meta = { w: WIDTH, h: height, k: projection.scale(), tx, ty };
writeFileSync(target, `${JSON.stringify({ ...meta, countries })}\n`);
console.log(`${countries.length} countries, ${WIDTH}x${height}`);
