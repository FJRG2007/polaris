/**
 * Rebuild the ARK item catalogue and its pictures.
 *
 * Run by hand - `node resources/arkicons/refresh.mjs` from the dashboard folder -
 * and its output is committed, the same way the Minecraft icons are vendored
 * rather than fetched. Nothing in a build or a test reaches the network.
 *
 * Two sources, because no single one has both halves:
 *
 * - What the items are, from Project Obelisk (the published output of Purlovia,
 *   which reads the game's own assets). It has the name, the blueprint path an
 *   admin command takes and the stack size, and it has them for every item in the
 *   game rather than for the ones somebody got round to writing down.
 * - What they look like, from the official community wiki, whose item pages name
 *   the icon file in their infobox. Asked for at 64 pixels and re-encoded, because
 *   the full-size ones are a hundred times bigger than a slot needs.
 *
 * Written to be re-runnable: an icon already on disk is not fetched again, so a
 * run interrupted halfway carries on from where it stopped.
 */

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, "icons");
const catalogFile = join(here, "..", "..", "apps", "web", "src", "lib", "apps", "ark", "item-catalog.json");

const ITEMS_URL = "https://raw.githubusercontent.com/arkutils/Obelisk/master/data/wiki/items.json";
const WIKI_API = "https://ark.wiki.gg/api.php";
/** Both hosts want to know who is asking, and a script that does not say gets
 *  refused rather than throttled. */
const AGENT = "PolarisDashboard/1.0 (ARK server panel; icon staging script)";
/** How many titles one API call may ask about. The wiki's own limit for an
 *  anonymous caller. */
const BATCH = 50;
/** How wide an icon is fetched and stored. A slot draws them at 32 to 48 CSS
 *  pixels, so 64 covers a retina screen and nothing more. */
const ICON_WIDTH = 64;

/** Politeness, and the only thing keeping this under the wiki's rate limit. */
async function fetchPolitely(url, tries = 5) {
    for (let attempt = 1; attempt <= tries; attempt += 1) {
        const answer = await fetch(url, { headers: { "User-Agent": AGENT } });
        if (answer.ok) return answer;
        if (answer.status === 404) return null;
        // 429 and the 5xx family are worth waiting out; anything else is not.
        if (answer.status !== 429 && answer.status < 500) return null;
        await sleep(500 * attempt * attempt);
    }
    return null;
}

async function api(params) {
    const url = `${WIKI_API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
    const answer = await fetchPolitely(url);
    return answer ? answer.json() : null;
}

/** "Metal Ingot" -> "Metal_Ingot", which is how a wiki title is written. */
function titleOf(name) {
    return name.replace(/ /g, "_");
}

/** The class an item is, which is what its blueprint path ends with and what it is
 *  keyed by here: two items can share a display name (a mission variant of a gun,
 *  say) and only the class tells them apart. */
function classOf(bp) {
    const tail = bp.split("/").pop() ?? "";
    const name = tail.split(".").pop() ?? "";
    return name.endsWith("_C") ? name.slice(0, -2) : name;
}

/**
 * The blueprint path in the form an admin command takes.
 *
 * Obelisk publishes the class path, which ends in `_C`; every give command
 * published by the wiki and by the game's own admin lists ends at the object.
 */
function givePath(bp) {
    return bp.endsWith("_C") ? bp.slice(0, -2) : bp;
}

console.log("Reading the item list...");
const source = await fetchPolitely(ITEMS_URL);
if (!source) throw new Error("The item list could not be fetched");
const published = await source.json();

/** One row per class. Items are published per map as well as once for the base
 *  game, so the same class arrives more than once and the first wins. */
const items = new Map();
for (const entry of published.items ?? []) {
    if (typeof entry?.name !== "string" || typeof entry?.bp !== "string") continue;
    if (!entry.bp.startsWith("/Game/")) continue;
    const key = classOf(entry.bp);
    if (key.length === 0 || items.has(key)) continue;
    items.set(key, {
        key,
        // Some names are written across several lines in the game's own data -
        // a portal that reads "Generate\nAberration (Gamma)\nPortal" - and a line
        // break inside a label breaks a row of the grid it is drawn in.
        name: entry.name.replace(/\s+/g, " ").trim(),
        bp: givePath(entry.bp),
        // A stack size the game does not publish is one item at a time, which is
        // the safe way round: a give that hands over fewer stacks than it could is
        // a second click, and one that hands over more is items on the floor.
        stack: Number.isFinite(entry.stackSize) ? Math.max(1, Math.trunc(entry.stackSize)) : 1,
        type: typeof entry.type === "string" ? entry.type : "",
        icon: null
    });
}
console.log(`  ${items.size} items, from game version ${published.version}`);

// By name, which is the order the grid opens on before anybody searches. The
// order the data arrives in is the order the game's folders happen to be walked,
// and a picker opening on that looks broken.
const rows = [...items.values()].sort((left, right) => left.name.localeCompare(right.name));

// The wiki names the picture in each item's infobox. Asking the page is worth the
// call: a good few icons are not named after the item (a Tranquilizer Arrow is
// Tranq_Arrow.png), and guessing at those leaves holes in the grid.
console.log("Asking the wiki which picture belongs to each item...");
const wanted = new Map();
for (let at = 0; at < rows.length; at += BATCH) {
    const slice = rows.slice(at, at + BATCH);
    const answer = await api({
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        redirects: "1",
        titles: slice.map((row) => titleOf(row.name)).join("|")
    });
    const pages = answer?.query?.pages ?? [];
    const byTitle = new Map();
    const exists = new Set();
    for (const page of pages) {
        const text = page?.revisions?.[0]?.slots?.main?.content;
        if (typeof text !== "string") continue;
        exists.add(page.title);
        const found = /^\s*\|\s*image\s*=\s*([^|\n{}<]+\.png)\s*$/im.exec(text);
        if (found?.[1]) byTitle.set(page.title, found[1].trim());
    }
    // Redirects and normalisation move the title between what was asked and what
    // came back, so both maps are walked to get from one to the other.
    const moved = new Map();
    for (const step of [...(answer?.query?.normalized ?? []), ...(answer?.query?.redirects ?? [])]) {
        moved.set(step.from, step.to);
    }
    const resolve = (title) => {
        let at = title;
        for (let hop = 0; hop < 4 && moved.has(at); hop += 1) at = moved.get(at);
        return at;
    };
    for (const row of slice) {
        const page = resolve(titleOf(row.name));
        // Failing that, the page's own name - which is what the infobox falls back
        // to when it does not name a picture, and it is the page the item redirects
        // to rather than the name the item is published under.
        const image = byTitle.get(page) ?? `${exists.has(page) ? page : row.name}.png`;
        wanted.set(row.key, `File:${titleOf(image)}`);
    }
    await sleep(150);
}

console.log("Finding the pictures...");
const urls = new Map();
const titles = [...new Set(wanted.values())];
for (let at = 0; at < titles.length; at += BATCH) {
    const slice = titles.slice(at, at + BATCH);
    const answer = await api({
        action: "query",
        prop: "imageinfo",
        iiprop: "url",
        iiurlwidth: String(ICON_WIDTH),
        redirects: "1",
        titles: slice.join("|")
    });
    const moved = new Map();
    for (const step of [...(answer?.query?.normalized ?? []), ...(answer?.query?.redirects ?? [])]) {
        moved.set(step.from, step.to);
    }
    const byTitle = new Map();
    for (const page of answer?.query?.pages ?? []) {
        const url = page?.imageinfo?.[0]?.thumburl ?? page?.imageinfo?.[0]?.url;
        if (typeof url === "string") byTitle.set(page.title, url);
    }
    for (const title of slice) {
        let at = title;
        for (let hop = 0; hop < 4 && moved.has(at); hop += 1) at = moved.get(at);
        const url = byTitle.get(at);
        if (url) urls.set(title, url);
    }
    await sleep(150);
}
console.log(`  ${urls.size} of ${titles.length} pictures exist`);

mkdirSync(iconsDir, { recursive: true });
const already = new Set(readdirSync(iconsDir).filter((name) => name.endsWith(".webp")));

console.log("Fetching them...");
let fetched = 0;
let missing = 0;
for (const row of rows) {
    const file = `${row.key}.webp`;
    if (already.has(file)) {
        row.icon = true;
        continue;
    }
    const url = urls.get(wanted.get(row.key) ?? "");
    if (!url) {
        missing += 1;
        continue;
    }
    const answer = await fetchPolitely(url);
    if (!answer) {
        missing += 1;
        continue;
    }
    const bytes = Buffer.from(await answer.arrayBuffer());
    try {
        // Re-encoded rather than stored as fetched: the same picture as WebP is a
        // third of the size, and this is two thousand of them in a repository.
        await sharp(bytes)
            .resize(ICON_WIDTH, ICON_WIDTH, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82 })
            .toFile(join(iconsDir, file));
        row.icon = true;
        fetched += 1;
    } catch {
        missing += 1;
    }
    if (fetched % 100 === 0 && fetched > 0) console.log(`  ${fetched} fetched`);
    await sleep(80);
}

// A picture left over from a previous run whose item is gone would be staged and
// served forever.
const keep = new Set(rows.filter((row) => row.icon).map((row) => `${row.key}.webp`));
for (const name of readdirSync(iconsDir)) {
    if (!keep.has(name)) rmSync(join(iconsDir, name));
}

for (const row of rows) row.icon = existsSync(join(iconsDir, `${row.key}.webp`));

writeFileSync(
    catalogFile,
    `${JSON.stringify(
        {
            version: published.version,
            items: rows.map((row) => ({
                key: row.key,
                name: row.name,
                bp: row.bp,
                stack: row.stack,
                type: row.type,
                ...(row.icon ? {} : { icon: false })
            }))
        },
        null,
        1
    )}\n`
);

console.log(`Done: ${rows.length} items, ${fetched} pictures fetched, ${missing} without one.`);
