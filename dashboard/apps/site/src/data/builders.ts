/**
 * The public site's data, built from what the repository already has: the app
 * catalogue, the README, the OpenAPI document and the GitHub releases.
 *
 * Pure functions over plain inputs, so the build script feeds them the real
 * sources and the tests feed them fixtures. Nothing here fetches or reads files.
 */

export type SiteLocale = "en" | "es";

export const SITE_LOCALES: readonly SiteLocale[] = ["en", "es"];

/* -------------------------------------------------------------------------- */
/* Marketplace                                                                 */
/* -------------------------------------------------------------------------- */

/** One catalogue entry, in the fields the site reads. */
export interface CatalogInput {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly summary: string;
    readonly description: string;
    readonly installMethod: string;
    readonly comingSoon?: boolean;
    /** The app's mark, already rendered to markup by the build script, at 40px and at 44px. */
    readonly mark: string;
    readonly markLarge: string;
    /** The placeholder preview's colour and the text colour on it. */
    readonly tint: string;
    readonly ink: string;
    /** Who makes it, and who publishes the image it runs, as the dashboard reads them. */
    readonly developer: string;
    readonly distributor: string;
    /** The app's first capture, per language, as the dashboard's marketplace shows it. */
    readonly shots: Readonly<Record<SiteLocale, StoreShot | null>>;
}

/** An app's capture, per theme, for a desktop and a phone (as `@polaris/ui/store-card` takes it). */
export interface StoreShot {
    readonly dark: { readonly desktop: string; readonly mobile: string };
    readonly light: { readonly desktop: string; readonly mobile: string };
}

/** A locale's words for the catalogue: per-app overrides and category names. */
export interface CatalogWords {
    readonly apps?: Readonly<
        Record<string, { name?: string; summary?: string; description?: string }>
    >;
    readonly categories?: Readonly<Record<string, string>>;
    /** The dashboard marketplace's card words: `card.by`, `card.byImage`, `card.preview`. */
    readonly card?: { readonly by: string; readonly byImage: string; readonly preview: string };
}

export interface SiteApp {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly categoryLabel: string;
    readonly summary: string;
    readonly description: string;
    /** Part of every install, rather than installed from the marketplace. */
    readonly builtin: boolean;
    readonly comingSoon: boolean;
    readonly mark: string;
    readonly markLarge: string;
    readonly tint: string;
    readonly ink: string;
    readonly byline: string;
    /** What the preview shows, for a screen reader. */
    readonly alt: string;
    readonly shot: StoreShot | null;
}

/**
 * Every offered app in one locale, sorted by name. A word the locale has not
 * translated falls back to the catalogue's own English, as the dashboard does.
 */
export function siteApps(
    catalog: readonly CatalogInput[],
    locale: SiteLocale,
    words: CatalogWords = {}
): SiteApp[] {
    const card = words.card ?? {
        by: "By {developer}",
        byImage: "By {developer} - image by {distributor}",
        preview: "{name} preview"
    };
    return catalog
        .map((app) => {
            const own = words.apps?.[app.id] ?? {};
            const name = own.name ?? app.name;
            const from = { developer: app.developer, distributor: app.distributor };
            return {
                id: app.id,
                name,
                category: app.category,
                categoryLabel: words.categories?.[app.category] ?? app.category,
                summary: own.summary ?? app.summary,
                description: own.description ?? app.description,
                builtin: app.installMethod === "builtin",
                comingSoon: app.comingSoon === true,
                mark: app.mark,
                markLarge: app.markLarge,
                tint: app.tint,
                ink: app.ink,
                byline: fill(from.developer === from.distributor ? card.by : card.byImage, from),
                alt: fill(card.preview, { name }),
                shot: app.shots[locale]
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** The categories present, in the order they first appear. */
export function siteCategories(apps: readonly SiteApp[]): { id: string; label: string }[] {
    const seen = new Map<string, string>();
    for (const app of apps) if (!seen.has(app.category)) seen.set(app.category, app.categoryLabel);
    return [...seen].map(([id, label]) => ({ id, label }));
}

/** Whether an app matches a search and a category; empty means any. */
export function matchesApp(app: SiteApp, query: string, category: string): boolean {
    if (category && app.category !== category) return false;
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [app.name, app.summary, app.categoryLabel].some((text) =>
        text.toLowerCase().includes(needle)
    );
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
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

/** The products released from this repository, by the prefix of their tags. */
export const PRODUCTS = [
    { id: "extension", prefix: "extension-v" },
    { id: "streamdeck", prefix: "streamdeck-v" },
    { id: "companion", prefix: "companion-v" },
    { id: "cli", prefix: "cli-v" },
    { id: "desktop", prefix: "desktop-v" }
] as const;

export type ProductId = (typeof PRODUCTS)[number]["id"];

/** The release answer, in the fields read; anything else is ignored. */
export interface ReleaseInput {
    readonly tag_name?: unknown;
    readonly html_url?: unknown;
    readonly draft?: unknown;
    readonly prerelease?: unknown;
    readonly published_at?: unknown;
    readonly assets?: unknown;
}

export interface DownloadFile {
    readonly name: string;
    readonly url: string;
    readonly size: number | null;
}

export type DownloadEntry =
    | {
          readonly product: ProductId;
          readonly released: true;
          readonly version: string;
          readonly url: string;
          readonly publishedAt: string | null;
          readonly files: readonly DownloadFile[];
      }
    | {
          readonly product: ProductId;
          readonly released: false;
          /** Where the releases would be listed, so the page still links somewhere real. */
          readonly url: string;
      };

/**
 * The newest published, non-draft, non-prerelease release of each product, or
 * the fact that it has none - which is also the answer for every product when
 * the lookup failed, so the site builds without the network.
 */
export function downloadEntries(releases: readonly ReleaseInput[], repo: string): DownloadEntry[] {
    return PRODUCTS.map(({ id, prefix }) => {
        const found = releases
            .filter(
                (release) =>
                    typeof release.tag_name === "string" &&
                    release.tag_name.startsWith(prefix) &&
                    release.draft !== true &&
                    release.prerelease !== true &&
                    typeof release.html_url === "string"
            )
            .sort((a, b) =>
                String(b.published_at ?? "").localeCompare(String(a.published_at ?? ""))
            )[0];
        if (!found)
            return {
                product: id,
                released: false,
                url: `https://github.com/${repo}/releases?q=${prefix.slice(0, -2)}`
            };
        const assets = Array.isArray(found.assets)
            ? (found.assets as Record<string, unknown>[])
            : [];
        return {
            product: id,
            released: true,
            version: (found.tag_name as string).slice(prefix.length),
            url: found.html_url as string,
            publishedAt: typeof found.published_at === "string" ? found.published_at : null,
            files: assets
                .filter(
                    (asset) =>
                        typeof asset?.name === "string" &&
                        typeof asset?.browser_download_url === "string"
                )
                .map((asset) => ({
                    name: asset.name as string,
                    url: asset.browser_download_url as string,
                    size: typeof asset.size === "number" ? asset.size : null
                }))
        };
    });
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

export interface LocaleData {
    readonly apps: readonly SiteApp[];
    readonly replaces: readonly ReplacesRow[];
    readonly showcase: readonly ShowcaseSection[];
    /** The dashboard's own words for the install guide (`downloads.guide` in its account catalog). */
    readonly guide: GuideWords;
}

export interface GuideWords {
    readonly title: string;
    readonly description: string;
    readonly step: string;
    readonly done: string;
    readonly steps: Readonly<Record<string, string>>;
    readonly items: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Which install guide a released file opens, or none for a file nobody installs by hand. */
export function guideItemFor(product: ProductId, fileName: string): GuideItemId | null {
    const name = fileName.toLowerCase();
    if (product === "streamdeck") return name.endsWith(".streamdeckplugin") ? "streamdeck" : null;
    if (product === "companion") return name.endsWith(".tgz") ? "companion" : null;
    if (product === "extension") {
        if (name.includes("sources") || !name.endsWith(".zip")) return null;
        if (name.includes("firefox")) return "extension-firefox";
        return name.includes("chrome") ? "extension-chromium" : null;
    }
    if (product === "desktop") return /\.(exe|dmg|deb|appimage)$/.test(name) ? "desktop" : null;
    return null;
}

/** The guide items, as `@polaris/ui/install-guide-steps` names them. */
export type GuideItemId =
    "streamdeck" | "companion" | "extension-chromium" | "extension-firefox" | "desktop";

/** A message with `{name}` placeholders filled in. */
export function fill(
    message: string,
    values: Readonly<Record<string, string | number>> = {}
): string {
    return message.replace(/\{(\w+)\}/g, (whole, key: string) =>
        key in values ? String(values[key]) : whole
    );
}

export interface SiteData {
    readonly repo: string;
    readonly install: { unix: string | null; windows: string | null };
    readonly cli: { unix: string; windows: string };
    readonly locales: Readonly<Record<SiteLocale, LocaleData>>;
    readonly downloads: readonly DownloadEntry[];
    readonly api: { title: string; description: string; groups: ReturnType<typeof apiOperations> };
}
