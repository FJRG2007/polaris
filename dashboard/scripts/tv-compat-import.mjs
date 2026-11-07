/**
 * Writes `packages/core/src/tv-compat/models.json`, the list "Does it work on my
 * TV?" answers from, out of the debloat lists in `tv/examples/<folder>/tv.json`
 * plus the few models other open projects name with a source.
 *
 * Facts only: each list was run by its owner with the upstream launcher, not
 * with Polaris TV, so it is labelled `upstream-community`, dated by the folder's
 * last commit. The tier is the rule of `tv-compat/rules.ts` applied to the
 * list's own OS line, never a guess about the model.
 *
 *   node scripts/tv-compat-import.mjs          rewrite models.json
 *   node scripts/tv-compat-import.mjs --check  fail when models.json is stale
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { majorVersion, tierFor } from "../packages/core/src/tv-compat/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const examples = join(root, "tv", "examples");
const out = join(here, "..", "packages", "core", "src", "tv-compat", "models.json");
const REPO = "https://github.com/FJRG2007/polaris";

/** Models named by other open projects, each with the line that names it. */
const HAND = [
    {
        id: "samsung-ue55tu7125kxxc",
        brand: "Samsung",
        model: "Samsung UE55TU7125KXXC (2020)",
        os: "Tizen 5.5",
        platform: "tizen",
        quirks: ["app-coming"],
        date: "2026-11-06",
        source: "https://github.com/GuillemCortesOvide/hack-tv#readme"
    },
    {
        id: "samsung-ue48ju6100",
        brand: "Samsung",
        model: "Samsung UE48JU6100 (2015)",
        os: "Tizen 2.3",
        platform: "tizen",
        quirks: ["app-coming"],
        date: "2026-10-26",
        source: "https://github.com/simbasjungles/free-my-tv#samsung-tvs-tizen"
    },
    {
        id: "samsung-ue49k5670",
        brand: "Samsung",
        model: "Samsung UE49K5670 (2016, Full HD)",
        os: "Tizen",
        platform: "tizen",
        quirks: ["app-coming", "samsung-dev-refused"],
        date: "2026-10-28",
        source: "https://github.com/simbasjungles/free-my-tv#samsung-tvs-tizen"
    }
];

/** Where the folder's list ran: platform and the version as written. */
export function parseOs(os) {
    const fire = /fire os\s*([\d.]+)?/i.exec(os);
    if (fire) return { platform: "fire-os", osVersion: fire[1] ?? null };
    if (/google tv/i.test(os)) {
        const version = /google tv\s*(\d+)/i.exec(os) ?? /android(?: tv)?\s*(\d+)/i.exec(os);
        return { platform: "google-tv", osVersion: version?.[1] ?? null };
    }
    const tv = /^android tv\s*([\d.]+)/i.exec(os);
    if (tv) return { platform: "android-tv", osVersion: tv[1] };
    const android = /android\s*([\d.]+)/i.exec(os);
    if (android) return { platform: "android", osVersion: android[1] };
    return { platform: "other", osVersion: null };
}

/** The tier, quirks and install route for one list, by the rules of `rules.ts`. */
export function ruling(folder, entry) {
    const { platform, osVersion } = parseOs(entry.os);
    const brand = entry.brand.trim();
    const level = majorVersion(osVersion);
    const base = tierFor(platform, osVersion);
    const quirks = [...base.quirks];
    let tier = base.tier;
    const pairing = /chromecast|streamer/i.test(`${folder} ${entry.tv}`);
    if (tier === "full" && pairing) quirks.push("google-pairing");
    if (tier === "full" && /^tcl$/i.test(brand)) quirks.push("tcl-autostart");
    if (tier === "full" && /^tcl$/i.test(brand) && platform === "google-tv")
        quirks.push("tcl-private-dns-prime");
    // Free My TV refuses the Home switch there: one never started again.
    if (
        tier === "full" &&
        (/huawei|harmony/i.test(`${brand} ${entry.os}`) || folder === "kalley-43g200")
    ) {
        tier = "app";
        quirks.push("huawei-refusal");
    }
    const android = platform === "android-tv" || platform === "google-tv";
    return {
        platform,
        osVersion,
        tier,
        launcher: { full: "home", app: "app", network: "none" }[tier],
        install: tier === "network" ? "none" : pairing ? "desktop-pairing" : "desktop-network",
        blocking: {
            privateDns: android && level !== null ? level >= 9 : null,
            routerDns: true
        },
        quirks
    };
}

/** Each folder's last commit date, from one pass over the history. */
function folderDates() {
    const log = execFileSync("git", ["log", "--format=@%cs", "--name-only", "--", "tv/examples"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
    });
    const dates = new Map();
    let date = null;
    for (const line of log.split("\n")) {
        if (line.startsWith("@")) date = line.slice(1).trim();
        else {
            const folder = /^tv\/examples\/([^/]+)\//.exec(line)?.[1];
            if (folder && date && !dates.has(folder)) dates.set(folder, date);
        }
    }
    return dates;
}

/** The dates models.json already holds, by folder. */
function checkedInDates(text) {
    const dates = new Map();
    for (const model of text ? JSON.parse(text) : [])
        if (model.tested?.by === "upstream-community") dates.set(model.id, model.tested.date);
    return dates;
}

export function buildModels(dates = folderDates()) {
    const models = [];
    for (const folder of readdirSync(examples).sort()) {
        const file = join(examples, folder, "tv.json");
        if (!existsSync(file)) continue;
        const entry = JSON.parse(readFileSync(file, "utf8"));
        models.push({
            id: folder,
            brand: entry.brand.trim(),
            model: entry.tv.trim(),
            aliases: [],
            ...ruling(folder, entry),
            tested: { by: "upstream-community", date: dates.get(folder) ?? "1970-01-01" },
            source: `${REPO}/tree/main/tv/examples/${folder}`
        });
    }
    for (const hand of HAND)
        models.push({
            id: hand.id,
            brand: hand.brand,
            model: hand.model,
            aliases: [hand.model.split(" ")[1]],
            platform: hand.platform,
            osVersion: /[\d.]+/.exec(hand.os)?.[0] ?? null,
            tier: "network",
            launcher: "none",
            install: "none",
            blocking: { privateDns: null, routerDns: true },
            quirks: hand.quirks,
            tested: { by: "community", date: hand.date },
            source: hand.source
        });
    return models;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1]);
if (isMain) {
    if (process.argv.includes("--check")) {
        const current = existsSync(out) ? readFileSync(out, "utf8").replace(/\r\n/g, "\n") : "";
        const text = `${JSON.stringify(buildModels(checkedInDates(current)), null, 4)}\n`;
        if (current !== text) {
            console.error("models.json is stale: run node scripts/tv-compat-import.mjs");
            process.exit(1);
        }
    } else writeFileSync(out, `${JSON.stringify(buildModels(), null, 4)}\n`);
}
