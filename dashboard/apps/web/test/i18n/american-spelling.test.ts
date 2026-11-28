/**
 * The English catalogs are US English, so a British spelling is a typo here.
 *
 * "Colour", "cancelled", "recycle bin" and "tick the box" all reached a screen
 * before this ran, one review at a time. Every English message value in the
 * dashboard, each installable app, the extension, the site, the Stream Deck
 * plugin and the office editors is read, and a value carrying a British form
 * fails with the file, the key and the word. Keys, placeholders (`{offences}`)
 * and other locales are never read.
 *
 * "Picture" is not the word here either: a value says image, photo (a person's
 * own) or preview, so `picture` fails the same way. An ICU selector named
 * `picture` is a key, not text, and is left alone. The device plugins' en-US
 * manifest strings are read with the catalogs.
 *
 * A word that is right in US English but looks British (a product name, a
 * Minecraft advancement) goes in `ALLOWED`, which names the whole phrase so the
 * spelling cannot come back anywhere else.
 */

import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");
const APPS = join(DASHBOARD, "apps");
const PLUGINS = resolve(DASHBOARD, "../clients/device-plugins");

/**
 * Apps whose catalog another change is moving to US English right now. Each
 * leaves this list in the change that fixes it, and the last test fails once
 * one is clean, so it cannot stay here by accident.
 */
const MOVING = ["hospitality"];

/** British form -> what US English writes. Each also matches capitalized and in capitals. */
const BRITISH: Record<string, string> = {
    colour: "color", colours: "colors", coloured: "colored", colouring: "coloring", colourful: "colorful",
    favourite: "favorite", favourites: "favorites", favour: "favor", favoured: "favored", favourable: "favorable",
    behaviour: "behavior", behaviours: "behaviors", behavioural: "behavioral", honour: "honor", honoured: "honored",
    labour: "labor", neighbour: "neighbor", neighbours: "neighbors", flavour: "flavor", humour: "humor", armour: "armor",
    harbour: "harbor", rumour: "rumor", endeavour: "endeavor", analyse: "analyze", analysed: "analyzed", analysing: "analyzing",
    centre: "center", centres: "centers", centred: "centered", metre: "meter", metres: "meters", kilometre: "kilometer",
    kilometres: "kilometers", litre: "liter", litres: "liters", theatre: "theater", fibre: "fiber",
    licence: "license", licences: "licenses", defence: "defense", offence: "offense", offences: "offenses", pretence: "pretense",
    cancelled: "canceled", cancelling: "canceling", travelled: "traveled", travelling: "traveling", traveller: "traveler",
    labelled: "labeled", labelling: "labeling", modelled: "modeled", modelling: "modeling", levelled: "leveled",
    signalled: "signaled", signalling: "signaling", fuelled: "fueled", totalled: "totaled", channelled: "channeled",
    tunnelled: "tunneled", marshalled: "marshaled", dialled: "dialed", dialling: "dialing", jewellery: "jewelry",
    catalogue: "catalog", catalogues: "catalogs", dialogue: "dialog", dialogues: "dialogs", analogue: "analog",
    grey: "gray", greyed: "grayed", greyscale: "grayscale", programme: "program", programmes: "programs",
    cheque: "check", cheques: "checks", judgement: "judgment", acknowledgement: "acknowledgment", ageing: "aging",
    aluminium: "aluminum", artefact: "artifact", artefacts: "artifacts", whilst: "while", amongst: "among",
    learnt: "learned", spelt: "spelled", enrol: "enroll", enrolment: "enrollment", fulfil: "fulfill", fulfilment: "fulfillment",
    skilful: "skillful", wilful: "willful", tyre: "tire", tyres: "tires", mould: "mold", cosy: "cozy", sceptical: "skeptical",
    manoeuvre: "maneuver", practise: "practice", practised: "practiced", postcode: "ZIP code", maths: "math",
    pavement: "sidewalk", focussed: "focused", orientated: "oriented", aeroplane: "airplane", speciality: "specialty",
    tick: "check", ticked: "checked", unticked: "unchecked", till: "register", "per cent": "percent",
    "recycle bin": "trash", "the bin": "the trash"
};

/** Words the English UI does not use, and what it says instead. */
const AVOIDED: Record<string, string> = { picture: "image, photo or preview", pictures: "images, photos or previews" };
const AVOID = /\bpictures?\b(?!\s*\{)/gi;

/** `-ise` words that keep their `s` in US English too. */
const KEEPS_S = new Set(
    `
        advertise advertised advertises advertising exercise exercised exercises exercising surprise surprised
        surprises surprising compromise compromised compromises compromising revise revised revises revising supervise
        supervised supervises supervising televise televised promise promised promises promising raise raised raises
        raising arise arises arising rise rises rising noise noises poise poised praise praised praises praising
        precise imprecise concise wise otherwise likewise clockwise counterclockwise anticlockwise lengthwise expertise
        franchise franchises merchandise merchandising enterprise enterprises disguise disguised despise devise devised
        devises improvise improvised premise premises paradise cerise turquoise tortoise porpoise mortise treatise
        demise incise excise excised apprise comprise comprised comprises comprising chastise bruise bruised cruise
        cruises cruising cruiser cruisers sunrise sunrises moonrise reprise upraise appraise appraised appraiser raiser
        riser risers miser unwise streetwise edgewise crosswise stepwise pairwise bitwise piecewise guise anise valise
        chaise`
        .trim()
        .split(/\s+/)
);
const IZE = /\b[A-Za-z]+(?:isation|isations|ise|ised|ises|ising|iser|isers)\b/g;

/** Phrases that are right as written: names, quoted UI of other products, game terms. */
const ALLOWED = ["Countdown tick", "Calibre", "A Complete Catalogue", "MAJESTIC THEATRE"];

const PHRASE = new RegExp(
    `\\b(${Object.keys(BRITISH)
        .sort((a, b) => b.length - a.length)
        .map((word) => word.replace(/ /g, "\\s+"))
        .join("|")})\\b`,
    "gi"
);

/** The British forms in one message value, placeholders and allowed phrases left out. */
export function britishIn(value: string): string[] {
    let text = value.replace(/\{\s*\w+\s*(?=[,}])/g, " ");
    for (const phrase of ALLOWED) text = text.split(phrase).join(" ");
    const found = [...text.matchAll(PHRASE)].map((m) => m[0]);
    for (const m of text.matchAll(IZE)) if (!KEEPS_S.has(m[0].toLowerCase())) found.push(m[0]);
    for (const m of text.matchAll(AVOID)) found.push(m[0]);
    return found;
}

/** What the English UI writes in place of a word `britishIn` found. */
function instead(word: string): string {
    const key = word.toLowerCase().replace(/\s+/g, " ");
    return BRITISH[key] ?? AVOIDED[key] ?? "-ize";
}

/** `[key, value]` for every en-US string a device plugin's manifest holds. */
function pluginValues(node: unknown, key: string, out: Array<[string, string]>): void {
    if (Array.isArray(node)) node.forEach((item, i) => pluginValues(item, `${key}[${i}]`, out));
    else if (node && typeof node === "object")
        for (const [k, v] of Object.entries(node)) {
            if (k === "en-US" && typeof v === "string") out.push([key, v]);
            else pluginValues(v, key ? `${key}.${k}` : k, out);
        }
}

function walk(node: unknown, key: string, out: Array<[string, string]>): void {
    if (typeof node === "string") out.push([key, node]);
    else if (node && typeof node === "object")
        for (const [k, v] of Object.entries(node)) walk(v, key ? `${key}.${k}` : k, out);
}

/** `[key, value]` for every string a TypeScript catalog (`export const en = {...}`) holds. */
function tsValues(source: string): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const entry = /^\s*([\w$]+|'[^']*'|"[^"]*")\s*:\s*('((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/gm;
    for (const m of source.matchAll(entry)) out.push([m[1], m[3] ?? m[4] ?? m[5] ?? ""]);
    return out;
}

/** Every English catalog file, relative to the dashboard. */
function englishCatalogs(): string[] {
    const files: string[] = [];
    for (const app of readdirSync(APPS).sort()) {
        if (MOVING.includes(app)) continue;
        const dir = join(APPS, app, "messages", "en-US");
        if (existsSync(dir)) for (const file of readdirSync(dir).sort()) if (file.endsWith(".json")) files.push(`apps/${app}/messages/en-US/${file}`);
    }
    files.push(
        "apps/extension/src/messages/en-US.json",
        "apps/extension/public/_locales/en/messages.json",
        "apps/site/src/messages/en.json",
        "apps/streamdeck/io.github.fjrg2007.polaris.sdPlugin/en.json"
    );
    for (const editor of ["genoffice-docs", "genoffice-slides"]) {
        const root = join(DASHBOARD, "packages", editor, "src", "renderer", "i18n");
        for (const group of readdirSync(root).sort())
            if (existsSync(join(root, group, "en.ts"))) files.push(`packages/${editor}/src/renderer/i18n/${group}/en.ts`);
    }
    return files.filter((file) => existsSync(join(DASHBOARD, file)));
}

describe("US English catalogs", () => {
    const files = englishCatalogs();

    it("finds every English catalog", () => {
        expect(files.length).toBeGreaterThan(100);
        expect(files).toContain("apps/web/messages/en-US/admin.json");
        expect(files).toContain("packages/genoffice-slides/src/renderer/i18n/ribbon/en.ts");
    });

    it("spell every value the US way", () => {
        const found: string[] = [];
        for (const file of files) {
            const source = readFileSync(join(DASHBOARD, file), "utf8");
            const entries: Array<[string, string]> = [];
            if (file.endsWith(".ts")) entries.push(...tsValues(source));
            else walk(JSON.parse(source), "", entries);
            for (const [key, value] of entries)
                for (const word of britishIn(value))
                    found.push(`${file}:${key}: "${word}" -> "${instead(word)}"`);
        }
        expect(found).toEqual([]);
    });

    it("say the device plugins' screens the US way", () => {
        const plugins = readdirSync(PLUGINS).filter((dir) => existsSync(join(PLUGINS, dir, "manifest.json")));
        expect(plugins).toContain("hercules-stream100");
        const found: string[] = [];
        for (const plugin of plugins) {
            const entries: Array<[string, string]> = [];
            pluginValues(JSON.parse(readFileSync(join(PLUGINS, plugin, "manifest.json"), "utf8")), "", entries);
            for (const [key, value] of entries)
                for (const word of britishIn(value)) found.push(`${plugin}:${key}: "${word}" -> "${instead(word)}"`);
        }
        expect(found).toEqual([]);
    });

    it("lists only apps that still carry a British spelling", () => {
        for (const app of MOVING) {
            const dir = join(APPS, app, "messages", "en-US");
            const values: Array<[string, string]> = [];
            for (const file of existsSync(dir) ? readdirSync(dir) : [])
                if (file.endsWith(".json")) walk(JSON.parse(readFileSync(join(dir, file), "utf8")), "", values);
            expect(values.some(([, value]) => britishIn(value).length > 0), app).toBe(true);
        }
    });

    it("catches the British forms and leaves the US ones and placeholders alone", () => {
        expect(britishIn("Background colour")).toEqual(["colour"]);
        expect(britishIn("The run was Cancelled.")).toEqual(["Cancelled"]);
        expect(britishIn("Move it to the recycle bin")).toEqual(["recycle bin"]);
        expect(britishIn("Polaris does not recognise it")).toEqual(["recognise"]);
        expect(britishIn("Tick Enabled, then Apply")).toEqual(["Tick"]);
        expect(britishIn("After {offences} separate offenses")).toEqual([]);
        expect(britishIn("Otherwise advertise the sunrise, organized and canceled")).toEqual([]);
        expect(britishIn("Countdown tick")).toEqual([]);
        expect(britishIn("Browse books from a Calibre library")).toEqual([]);
        expect(britishIn("Choose a picture")).toEqual(["picture"]);
        expect(britishIn("Pictures that load on their own")).toEqual(["Pictures"]);
        expect(britishIn("Show this {kind, select, picture {image} other {file}}")).toEqual([]);
    });
});
