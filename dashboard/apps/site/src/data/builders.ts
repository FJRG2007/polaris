/**
 * The public site's data, built from what the repository already has: the app
 * catalogue, the README, the OpenAPI document and the GitHub releases.
 *
 * Pure functions over plain inputs, so the build script feeds them the real
 * sources and the tests feed them fixtures. Nothing here fetches or reads files.
 */
import type { InventoryRoute } from "@/data/api-inventory";
import type { DocPage } from "@/data/docs";
import type { AppDownload } from "@polaris/ui/account-downloads/app-releases";
import { searchItems, type SearchField } from "@polaris/core/search-text";

export type SiteLocale = "en" | "es";

export const SITE_LOCALES: readonly SiteLocale[] = ["en", "es"];

/* -------------------------------------------------------------------------- */
/* Marketplace                                                                 */
/* -------------------------------------------------------------------------- */

/** An app's capture, per theme, for a desktop and a phone (as `@polaris/ui/store-card` takes it). */
export interface StoreShot {
    readonly dark: { readonly desktop: string; readonly mobile: string };
    readonly light: { readonly desktop: string; readonly mobile: string };
}

export type StoreSort = "featured" | "name" | "recent";

export const STORE_SORTS: readonly StoreSort[] = ["featured", "name", "recent"];

/** Who is behind an app: Polaris, or another developer whose image Polaris runs. */
export type StoreShelf = "polaris" | "community";

/** One line of an app page's Information list. */
export interface AppFact {
    readonly label: string;
    readonly value: string;
    /** A link the value opens, for the documentation. */
    readonly href?: string;
    /** Drawn as code, for an image reference. */
    readonly code?: boolean;
}

/**
 * One app of the dashboard's Marketplace - a catalogue app or a Deploy
 * template - in one locale, already in the dashboard's own words: the build
 * script reads them with the dashboard's localizer, so the two never differ.
 */
export interface SiteApp {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly categoryLabel: string;
    readonly summary: string;
    readonly description: string;
    readonly keywords: readonly string[];
    readonly comingSoon: boolean;
    /** The app's mark, already rendered to markup by the build script, at 40px and at 72px. */
    readonly mark: string;
    readonly markLarge: string;
    /** The Polaris app logo the entry wears instead of `mark`: `app-logos/<logo>.svg`. */
    readonly logo: string | null;
    /** The placeholder preview's colour and the text colour on it. */
    readonly tint: string;
    readonly ink: string;
    readonly byline: string;
    /** What the card's preview shows, for a screen reader. */
    readonly alt: string;
    /** The card's preview: the app's first capture, as the dashboard's card shows it. */
    readonly shot: StoreShot | null;
    readonly shelf: StoreShelf;
    /** In the dashboard's Featured row. */
    readonly featured: boolean;
    /** The day it joined the catalogue (YYYY-MM-DD), for "Recently added". */
    readonly added: string | null;
    /** The dashboard's capability badges, in words. */
    readonly capabilities: readonly string[];
    /** The terms installing it accepts, when it has any. */
    readonly consent: { readonly label: string; readonly url: string } | null;
    /** "What it needs", line by line, as the dashboard's page lists it. */
    readonly needs: readonly string[];
    readonly facts: readonly AppFact[];
    /** Every capture of it, as its page shows them; none for an app nobody has captured. */
    readonly shots: readonly ShowcaseItem[];
    /** What it replaces, with the logo the site ships for each, as its dashboard page lists it. */
    readonly replaces: readonly { readonly name: string; readonly logo: string }[];
    /** The games it runs, for Game servers. */
    readonly games: readonly { readonly id: string; readonly name: string; readonly summary: string; readonly logo: string }[];
}

/** The categories present, in the order they first appear (the dashboard's `storeCategories`). */
export function siteCategories(apps: readonly SiteApp[]): { id: string; label: string }[] {
    const seen = new Map<string, string>();
    for (const app of apps) if (!seen.has(app.category)) seen.set(app.category, app.categoryLabel);
    return [...seen].map(([id, label]) => ({ id, label }));
}

const APP_FIELDS: readonly SearchField<SiteApp>[] = [
    { text: (app) => app.name, weight: 3 },
    { text: (app) => app.summary, weight: 2 },
    { text: (app) => app.keywords, weight: 1 },
    { text: (app) => app.category, weight: 1 }
];

/**
 * The dashboard's `filterStoreApps`: one category or all, the same weighted
 * search, the chosen order, and anything announced but not out yet last.
 */
export function filterSiteApps(
    apps: readonly SiteApp[],
    filter: { query: string; category: string; sort: StoreSort; locale: SiteLocale }
): SiteApp[] {
    const inCategory = filter.category ? apps.filter((app) => app.category === filter.category) : [...apps];
    const term = filter.query.trim();
    const matched = term ? searchItems(inCategory, term, APP_FIELDS) : inCategory;
    const order = new Map(apps.map((app, index) => [app.id, index]));
    const sorted = [...matched];
    if (filter.sort === "name") {
        const collator = new Intl.Collator(filter.locale, { sensitivity: "base" });
        sorted.sort((left, right) => collator.compare(left.name, right.name));
    } else if (filter.sort === "recent")
        sorted.sort((left, right) => {
            const byDate = (right.added ?? "").localeCompare(left.added ?? "");
            return byDate !== 0 ? byDate : (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0);
        });
    return sorted.sort((left, right) => Number(left.comingSoon) - Number(right.comingSoon));
}

/** The apps split by who is behind them, Polaris's first; an empty shelf is left out. */
export function siteShelves(apps: readonly SiteApp[]): { shelf: StoreShelf; apps: SiteApp[] }[] {
    return (["polaris", "community"] as const)
        .map((shelf) => ({ shelf, apps: apps.filter((app) => app.shelf === shelf) }))
        .filter((group) => group.apps.length > 0);
}

/* -------------------------------------------------------------------------- */
/* README                                                                      */
/* -------------------------------------------------------------------------- */

export interface ReplacedTool {
    readonly name: string;
    /** The logo's file name under docs/assets/logos, when the repository has one. */
    readonly logo: string | null;
}

export interface ReplacesRow {
    readonly tools: readonly ReplacedTool[];
    readonly instead: string;
}

/** A tool's name as a logo file name: "Google Drive" is `google-drive`. */
export function logoSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

/**
 * The "what Polaris replaces" table: the first Markdown table under the heading
 * `heading`. Each left cell is split into tools; a tool gets the logo whose name
 * is its slug, the only one named after it with a suffix ("Fly" is `fly-io.svg`),
 * or the first of its words that is one, or none.
 */
export function parseReplaces(
    markdown: string,
    heading: RegExp,
    logos: ReadonlySet<string>
): ReplacesRow[] {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => /^#{2,3} /.test(line) && heading.test(line));
    if (start < 0) return [];
    const rows: ReplacesRow[] = [];
    let inTable = false;
    for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (/^#{1,3} /.test(line)) break;
        if (!line.startsWith("|")) {
            if (inTable) break;
            continue;
        }
        inTable = true;
        const cells = line
            .split("|")
            .slice(1, -1)
            .map((cell) => cell.trim());
        // The separator line, and the header row right above it.
        if (
            cells.length < 2 ||
            /^-+$/.test(cells[0] ?? "") ||
            SEPARATOR.test(lines[index + 1] ?? "")
        )
            continue;
        const tools = (cells[0] ?? "")
            .split(/,\s*|\s+and\s+|\s+y\s+/)
            .map((name) => name.trim())
            .filter(Boolean)
            .map((name) => ({ name, logo: logoFor(name, logos) }));
        rows.push({ tools, instead: cells[1] ?? "" });
    }
    return rows;
}

/** A table's `| --- |` line, which comes right after its header row. */
const SEPARATOR = /^\|\s*-{3,}/;

function logoFor(name: string, logos: ReadonlySet<string>): string | null {
    const whole = logoSlug(name);
    if (logos.has(`${whole}.svg`)) return `${whole}.svg`;
    const suffixed = [...logos].filter(
        (file) => file.startsWith(`${whole}-`) && file.endsWith(".svg")
    );
    if (whole && suffixed.length === 1) return suffixed[0] ?? null;
    for (const word of name.split(/\s+/)) {
        const slug = logoSlug(word);
        if (slug && logos.has(`${slug}.svg`)) return `${slug}.svg`;
    }
    return null;
}

export interface ShowcaseItem {
    readonly name: string;
    readonly caption: string;
    /** Media file names under docs/assets/media. */
    readonly dark: string;
    readonly light: string | null;
    readonly alt: string;
}

export interface ShowcaseSection {
    readonly heading: string;
    readonly items: readonly ShowcaseItem[];
}

/**
 * The README's screenshots, by section: every `### heading` with the pictures
 * under it, each with its bold name and the caption after it.
 */
export function parseShowcase(markdown: string): ShowcaseSection[] {
    const sections: ShowcaseSection[] = [];
    const parts = markdown.split(/^### /m).slice(1);
    for (const part of parts) {
        const heading = (part.split(/\r?\n/, 1)[0] ?? "").trim();
        const items: ShowcaseItem[] = [];
        for (const cell of part.split(/<td\b/).slice(1)) {
            const dark = /<img src="docs\/assets\/media\/([^"]+)"[^>]*alt="([^"]*)"/.exec(cell);
            if (!dark) continue;
            const light = /srcset="docs\/assets\/media\/([^"]+)"/.exec(cell);
            const sub = /<sub>[\s\S]*?<b>([^<]+)<\/b>(?:<\/a>)?:?\s*([^<]*)<\/sub>/.exec(cell);
            items.push({
                name: sub?.[1]?.trim() ?? dark[2] ?? "",
                caption: sub?.[2]?.trim() ?? "",
                dark: dark[1] ?? "",
                light: light?.[1] ?? null,
                alt: dark[2] ?? ""
            });
        }
        if (items.length) sections.push({ heading, items });
        // The screenshots end where the README's next top-level section starts.
        if (/^## /m.test(part)) break;
    }
    return sections;
}

/** The install lines the README gives, by shell. */
export function parseInstallLines(markdown: string): {
    unix: string | null;
    windows: string | null;
} {
    return {
        unix: /^curl -fsSL \S+install\.sh \| sh$/m.exec(markdown)?.[0] ?? null,
        windows: /^irm \S+install\.ps1 \| iex$/m.exec(markdown)?.[0] ?? null
    };
}

/* -------------------------------------------------------------------------- */
/* API reference                                                               */
/* -------------------------------------------------------------------------- */

export interface ApiParameter {
    readonly name: string;
    readonly in: string;
    readonly required: boolean;
    readonly type: string;
    readonly description: string;
}

export interface ApiOperation {
    readonly id: string;
    readonly method: string;
    readonly path: string;
    readonly tag: string;
    readonly summary: string;
    readonly description: string;
    readonly parameters: readonly ApiParameter[];
    /** The request body's JSON schema, pretty-printed, when it has one. */
    readonly body: string | null;
    readonly responses: readonly { status: string; description: string }[];
}

type Json = Record<string, unknown>;

const METHODS = ["get", "post", "put", "patch", "delete"];

/** Every operation of an OpenAPI 3 document, grouped by its first tag in the document's tag order. */
export function apiOperations(doc: Json): { tag: string; operations: ApiOperation[] }[] {
    const paths = (doc.paths ?? {}) as Record<string, Json>;
    const operations: ApiOperation[] = [];
    for (const [path, item] of Object.entries(paths)) {
        for (const method of METHODS) {
            const op = item[method] as Json | undefined;
            if (!op) continue;
            const params = (Array.isArray(op.parameters) ? op.parameters : []) as Json[];
            const body = ((op.requestBody as Json | undefined)?.content as Json | undefined)?.[
                "application/json"
            ] as Json | undefined;
            operations.push({
                id: String(op.operationId ?? `${method}-${path}`),
                method: method.toUpperCase(),
                path,
                tag: String((op.tags as string[] | undefined)?.[0] ?? "Other"),
                summary: String(op.summary ?? ""),
                description: String(op.description ?? ""),
                parameters: params.map((param) => ({
                    name: String(param.name ?? ""),
                    in: String(param.in ?? ""),
                    required: param.required === true,
                    type: String((param.schema as Json | undefined)?.type ?? "string"),
                    description: String(param.description ?? "")
                })),
                body: body?.schema ? JSON.stringify(body.schema, null, 2) : null,
                responses: Object.entries((op.responses ?? {}) as Record<string, Json>).map(
                    ([status, value]) => ({
                        status,
                        description: String(value?.description ?? "")
                    })
                )
            });
        }
    }
    const order = ((doc.tags ?? []) as Json[]).map((tag) => String(tag.name));
    const groups = new Map<string, ApiOperation[]>();
    for (const tag of order) groups.set(tag, []);
    for (const op of operations)
        (groups.get(op.tag) ?? groups.set(op.tag, []).get(op.tag)!).push(op);
    return [...groups]
        .filter(([, ops]) => ops.length)
        .map(([tag, ops]) => ({ tag, operations: ops }));
}

/* -------------------------------------------------------------------------- */
/* The whole document                                                          */
/* -------------------------------------------------------------------------- */

/** One app every Polaris comes with, as its row and its own page show it. */
export interface BuiltInSiteApp {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    /** The products it replaces; `logo` names a tile in `public/logos`. */
    readonly replaces: readonly { readonly name: string; readonly logo: string }[];
    /** Every capture of it, the README's first; none for an app nobody has captured yet. */
    readonly shots: readonly ShowcaseItem[];
}

/** The dashboard's own words for the built-in row and an app's page. */
export interface BuiltInWords {
    readonly title: string;
    readonly open: string;
    readonly replaces: string;
    readonly back: string;
    readonly screenshots: string;
    readonly about: string;
    readonly needsNothing: string;
    /** "By {developer}". */
    readonly by: string;
}

/** The dashboard Marketplace's own words for the list and an app's page. */
export interface StoreWords {
    readonly search: string;
    readonly sortLabel: string;
    readonly sorts: Readonly<Record<StoreSort, string>>;
    readonly categories: string;
    readonly allCategories: string;
    readonly featured: string;
    readonly shelves: Readonly<Record<StoreShelf, string>>;
    readonly noMatch: string;
    readonly details: string;
    readonly comingSoon: string;
    /** "Installing accepts the <link>{label}</link>." */
    readonly consent: string;
    readonly about: string;
    readonly features: string;
    readonly needs: string;
    readonly information: string;
    readonly games: string;
}

export interface LocaleData {
    /** The dashboard's Marketplace, in its order. */
    readonly apps: readonly SiteApp[];
    readonly store: StoreWords;
    /** The apps every Polaris comes with, in the dashboard's order. */
    readonly builtIn: readonly BuiltInSiteApp[];
    readonly builtInWords: BuiltInWords;
    readonly replaces: readonly ReplacesRow[];
    readonly showcase: readonly ShowcaseSection[];
}

/** A message with `{name}` placeholders filled in. */
export function fill(
    message: string,
    values: Readonly<Record<string, string | number>> = {}
): string {
    return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
        key in values ? String(values[key]) : whole
    );
}

/** What the shared Downloads page is fed with on the site. */
export interface DownloadsData {
    readonly files: Readonly<
        Record<"desktop" | "extension" | "streamdeck" | "companion", AppDownload | null>
    >;
    readonly storeUrl: string | null;
    /** The dashboard's own catalogs, cut to the Downloads keys, per site locale. */
    readonly messages: Readonly<
        Record<
            SiteLocale,
            { account: Record<string, unknown>; components: Record<string, unknown> }
        >
    >;
}

export interface SiteData {
    readonly repo: string;
    readonly install: { unix: string | null; windows: string | null };
    readonly locales: Readonly<Record<SiteLocale, LocaleData>>;
    /** The feature guides from `docs/features`, rendered per locale. */
    readonly docs: Readonly<Record<SiteLocale, readonly DocPage[]>>;
    readonly downloadsPage: DownloadsData;
    readonly api: {
        title: string;
        description: string;
        groups: ReturnType<typeof apiOperations>;
        /** Every route that answers to an API key, from the code. */
        routes: InventoryRoute[];
        /** Route handlers left out as the interface's own. */
        internal: number;
        /** Route files read. */
        scanned: number;
    };
}
