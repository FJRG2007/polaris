// Turn a geography module (`export const GEO = {...}`) into the binary file the
// game ships (`game/new-york/data/geo.bin`). Run by hand when the map changes:
//   node scripts/encode-geo.mjs <geography.js>
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeGeo, decodeGeo } from "../game/new-york/engine/geo-codec.js";
import { isDeepStrictEqual } from "node:util";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/encode-geo.mjs <geography.js>");
const { GEO } = await import(pathToFileURL(source).href);
const bytes = encodeGeo(GEO);
if (!isDeepStrictEqual(decodeGeo(bytes), GEO)) throw new Error("round trip changed the data");
const target = fileURLToPath(new URL("../game/new-york/data/geo.bin", import.meta.url));
writeFileSync(target, bytes);
console.log(`${bytes.length} bytes -> ${target}`);
