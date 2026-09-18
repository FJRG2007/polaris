/**
 * Stage what Game servers ships besides its code, for the bundler to copy into
 * its bundle (`polaris.assets` in package.json): the item icons its panels draw
 * and the manifests their pickers search.
 *
 * The Minecraft set is vendored in resources/mcicons and the ARK set in
 * resources/arkicons (see their READMEs). Each manifest is derived here rather
 * than committed, so a list and the files behind it cannot drift apart. The ARK
 * one is the catalogue minus its blueprint paths: the server needs those and the
 * browser must not have them, since what a screen sends back is an item's class
 * and the path it turns into is looked up on the server.
 *
 * The login mod's jars are built by the image (they need a JDK) and put in
 * .assets/minecraft-mods by the Dockerfile before the bundler runs.
 *
 * Run by the bundler (`polaris.prepare`).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const resources = join(app, "..", "..", "resources");
const staged = join(app, ".assets");

function stage(name, source) {
    const target = join(staged, name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(source, target, { recursive: true });
    return target;
}

// "minecraft_diamond_sword.png" -> "diamond_sword". Every file in the set carries
// the namespace as a prefix, and the panel puts it back, so it is dropped here to
// keep the manifest a list of item names.
const mcicons = join(resources, "mcicons", "icons");
const minecraft = readdirSync(mcicons)
    .filter((name) => name.startsWith("minecraft_") && name.endsWith(".png"))
    .map((name) => name.slice("minecraft_".length, -".png".length))
    .sort();
writeFileSync(join(stage("mcicons", mcicons), "items.json"), `${JSON.stringify(minecraft)}\n`);

// The blueprint path is left behind on purpose; `icon: false` is carried across
// because the picker puts the items nobody has a picture of behind the ones it
// can draw.
const catalog = JSON.parse(readFileSync(join(app, "src", "lib", "ark", "item-catalog.json"), "utf8"));
const ark = catalog.items.map((item) => ({
    key: item.key,
    name: item.name,
    stack: item.stack,
    ...(item.icon === false ? { icon: false } : {})
}));
writeFileSync(join(stage("arkicons", join(resources, "arkicons", "icons")), "items.json"), `${JSON.stringify(ark)}\n`);

console.log(`Staged ${minecraft.length} Minecraft and ${ark.length} ARK item icons in ${staged}`);
