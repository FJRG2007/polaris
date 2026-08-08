/**
 * Stage the Minecraft item icons under public/mcicons so the players screen can
 * draw an inventory the way the game does, same-origin and offline. The set is
 * vendored in resources/mcicons (see its README) rather than installed, so this
 * copies from the repo instead of from node_modules.
 *
 * It also writes items.json - the ids the set covers - which is what the item
 * picker searches. Deriving it here rather than committing it keeps the list and
 * the files that back it from drifting apart. Runs from predev/prebuild.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "..", "resources", "mcicons", "icons");
const target = join(here, "..", "public", "mcicons");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

// "minecraft_diamond_sword.png" -> "diamond_sword". Every file in the set carries
// the namespace as a prefix, and the panel puts it back, so it is dropped here to
// keep the manifest a list of item names.
const items = readdirSync(source)
    .filter((name) => name.startsWith("minecraft_") && name.endsWith(".png"))
    .map((name) => name.slice("minecraft_".length, -".png".length))
    .sort();

writeFileSync(join(target, "items.json"), `${JSON.stringify(items)}\n`);

console.log(`Copied ${items.length} Minecraft item icons to ${target}`);
