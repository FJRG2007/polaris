/**
 * Stage the ARK item icons under public/arkicons so the players screen can draw
 * the item grid same-origin and offline, and write the manifest the picker
 * searches.
 *
 * The pictures are vendored in resources/arkicons (see its README) and the
 * catalogue they belong to is committed beside the code that reads it, because the
 * server needs the blueprint paths and the browser must not have them: what a
 * screen sends back is an item's class, and the path it turns into is looked up on
 * this side. So the manifest written here is the catalogue minus that column.
 *
 * Runs from predev/prebuild, like the Minecraft one.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "resources", "arkicons", "icons");
const target = join(here, "..", "public", "arkicons");
const catalogFile = join(here, "..", "src", "lib", "apps", "ark", "item-catalog.json");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
const items = catalog.items.map((item) => ({ key: item.key, name: item.name, stack: item.stack }));

writeFileSync(join(target, "items.json"), `${JSON.stringify(items)}\n`);

console.log(`Copied ${items.length} ARK item icons to ${target}`);
