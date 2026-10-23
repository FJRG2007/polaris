/**
 * Writes `generated/site-data.json` and copies the README's pictures and logos
 * into `public/`: everything the static pages read, taken from the sources the
 * dashboard and the README already use, so a new catalogue app or a new release
 * appears on the next build with no edit to the site.
 */

import { createElement } from "react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenApi } from "@/lib/api-docs/openapi";
import { renderToStaticMarkup } from "react-dom/server";
import { AppMark, ownAppLogo } from "@/components/app-mark";
import { STREAMDECK_MARKETPLACE_URL } from "@/lib/deck/marketplace";
import {
    appDownload,
    COMPANION_TAG_PREFIX,
    DESKTOP_TAG_PREFIX,
    EXTENSION_TAG_PREFIX,
    STREAMDECK_TAG_PREFIX
} from "@polaris/ui/account-downloads/app-releases";
import { initialsInk, tintFor } from "@polaris/core";
import { appNeeds } from "@/lib/apps/app-needs";
import { appReplaces } from "@/lib/apps/replaces";
import type { AppManifest } from "@/lib/apps/catalog";
import { appProvenance } from "@/lib/apps/provenance";
import { categoryLabel, localizeApp } from "@/lib/apps/app-words";
import { CAPABILITY_KEYS } from "@/lib/apps/capability-words";
import { GAMES, GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";
import { appPreview, appScreenshots, builtInScenes } from "@/lib/apps/app-screenshots";
import {
    ADDED_ON,
    builtInApps,
    featuredApps,
    storeApps,
    storeShelf
} from "@/lib/apps/marketplace-store";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync
} from "node:fs";
import * as site from "../src/data/builders";
import * as docs from "../src/data/docs";
import { marked } from "marked";
import { highlight, type CodeLanguage } from "../src/lib/highlight";
import { apiInventory, type ModuleSource, type RouteSource } from "../src/data/api-inventory";

const siteDir = process.env.POLARIS_SITE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = join(siteDir, "..", "..");
const root = join(dashboard, "..");
const web = join(dashboard, "apps", "web");
const media = join(root, "docs", "assets", "media");
const logosDir = join(root, "docs", "assets", "logos");
// Polaris's own app logos, the files `@polaris/ui` writes from its `AppLogo`.
const appLogosDir = join(dashboard, "packages", "ui", "assets", "app-logos");
const repo = process.env.GITHUB_REPOSITORY || "FJRG2007/polaris";

const read = (path: string) => readFileSync(path, "utf8");
const logos = new Set(readdirSync(logosDir));

/** A dashboard message catalog as the dashboard's translator reads it: `t(key, values)` and `t.has(key)`. */
function translator(messages: Record<string, unknown>) {
    const find = (key: string): unknown =>
        key
            .split(".")
            .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
    const t = (key: string, values: Readonly<Record<string, string | number>> = {}) => {
        const found = find(key);
        return typeof found === "string" ? site.fill(found, values) : key;
    };
    t.has = (key: string) => typeof find(key) === "string";
    return t;
}

const messages = (webLocale: string, name: string) =>
    JSON.parse(read(join(web, "messages", webLocale, `${name}.json`))) as Record<string, unknown>;

/** The version an app's image is pinned to, when its tag says one (the dashboard's `imageVersion`). */
function imageVersion(image: string | undefined): string | null {
    if (!image) return null;
    const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
    return tag && tag !== "latest" ? tag : null;
}

/**
 * The dashboard's Marketplace in one locale: every store app (catalogue apps and
 * Deploy's templates, `storeApps`), localized by the dashboard's own
 * `useLocalizeStoreApp` rules, with what its card and its page show.
 */
function storeList(webLocale: string, showcase: site.ShowcaseSection[]): site.SiteApp[] {
    const t = translator(messages(webLocale, "marketplace"));
    const words = translator(messages(webLocale, "catalog"));
    const deploy = translator(messages(webLocale, "deploy"));
    const nav = translator(messages(webLocale, "nav"));
    const navLabel = (label: string) => (nav.has(`labels.${label}`) ? nav(`labels.${label}`) : label);
    const localize = (app: AppManifest): AppManifest => {
        if (!app.deployTemplate) return localizeApp(words as never, app, navLabel);
        const key = `view.template.catalog.${app.deployTemplate}.description`;
        const line = deploy.has(key) ? deploy(key) : app.summary;
        return { ...app, summary: line, description: line };
    };
    const language = webLocale.startsWith("es") ? "es" : "en";
    const all = storeApps().map(localize);
    const featured = new Set(featuredApps(all).map((app) => app.id));
    const listed = showcase.flatMap((section) => section.items);
    const date = new Intl.DateTimeFormat(webLocale, { dateStyle: "medium", timeZone: "UTC" });
    return all.map((app) => {
        const from = appProvenance(app);
        const tint = tintFor(app.id);
        const image = app.template?.image;
        const version = imageVersion(image);
        const added = ADDED_ON[app.id] ?? null;
        const category = categoryLabel(words as never, app.category, navLabel);
        const facts: site.AppFact[] = [
            { label: t("detail.developer"), value: from.developer },
            { label: t("detail.category"), value: category },
            ...(version ? [{ label: t("detail.version"), value: version }] : []),
            ...(added
                ? [{ label: t("detail.added"), value: date.format(new Date(`${added}T00:00:00Z`)) }]
                : []),
            ...(image ? [{ label: t("detail.image"), value: image, code: true }] : []),
            ...(app.docsUrl
                ? [{ label: t("detail.docs"), value: app.docsUrl, href: app.docsUrl }]
                : [])
        ];
        // Every capture the dashboard's page shows, as the README or a feature
        // page captions it, or numbered the way the dashboard's gallery does.
        const shots = appScreenshots(app.id, webLocale).flatMap((shot, index) => {
            const file = shot.dark.desktop.slice(shot.dark.desktop.lastIndexOf("/") + 1);
            const scene = file.replace(/-dark-.*$/, "");
            const readme = listed.find((item) => item.dark.startsWith(`${scene}-dark-`));
            if (readme) return [readme];
            const own = captured(scene, webLocale);
            if (own.length > 0) return own;
            const dark = `${scene}-dark-${language}-desktop.webp`;
            const light = `${scene}-light-${language}-desktop.webp`;
            const alt = t("detail.screenshotAlt", { name: app.name, index: index + 1 });
            return existsSync(join(media, dark))
                ? [
                      {
                          name: alt,
                          caption: "",
                          dark,
                          light: existsSync(join(media, light)) ? light : null,
                          alt
                      }
                  ]
                : [];
        });
        return {
            id: app.id,
            name: app.name,
            category: app.category,
            categoryLabel: category,
            summary: app.summary,
            description: app.description,
            keywords: [...(app.keywords ?? [])],
            comingSoon: app.comingSoon === true,
            mark: renderToStaticMarkup(createElement(AppMark, { app, size: 40 })),
            markLarge: renderToStaticMarkup(createElement(AppMark, { app, size: 72 })),
            logo: ownAppLogo(app.id),
            tint,
            ink: initialsInk(tint),
            byline:
                from.developer === from.distributor
                    ? t("card.by", { developer: from.developer })
                    : t("card.byImage", {
                          developer: from.developer,
                          distributor: from.distributor
                      }),
            alt: t("card.preview", { name: app.name }),
            shot: appPreview(app.id, webLocale),
            shelf: storeShelf(app),
            featured: featured.has(app.id),
            added,
            capabilities: app.capabilities.map((capability) => t(CAPABILITY_KEYS[capability])),
            consent: app.consent ? { label: app.consent.label, url: app.consent.url } : null,
            needs: appNeeds(t as never, app),
            facts,
            shots,
            replaces: appReplaces(app.id)
                .filter((item) => logos.has(`${item.logo}.svg`))
                .map((item) => ({ name: item.name, logo: item.logo })),
            games:
                app.id === GAME_SERVERS_APP_ID
                    ? GAMES.map((game) => ({
                          id: game.id,
                          name: game.name,
                          summary: t.has(`detail.gameSummaries.${game.id}`)
                              ? t(`detail.gameSummaries.${game.id}`)
                              : game.summary,
                          logo: game.logo.replace(/^\//, "")
                      }))
                    : []
        };
    });
}

/** The dashboard Marketplace's words the site's list and app pages use. */
function storeWords(webLocale: string): site.StoreWords {
    const t = translator(messages(webLocale, "marketplace"));
    return {
        search: t("view.search"),
        sortLabel: t("view.sortLabel"),
        sorts: {
            featured: t("view.sort.featured"),
            name: t("view.sort.name"),
            recent: t("view.sort.recent")
        },
        categories: t("view.categories"),
        allCategories: t("view.allCategories"),
        featured: t("view.featured"),
        shelves: { polaris: t("view.shelves.polaris"), community: t("view.shelves.community") },
        noMatch: t("view.noMatch"),
        details: t("card.details"),
        comingSoon: t("card.comingSoon"),
        consent: t("card.consent"),
        about: t("detail.about"),
        features: t("detail.features"),
        needs: t("detail.needs"),
        information: t("detail.information"),
        games: t("detail.games")
    };
}

/** The picture in the page's language where the README has one, the English one otherwise. */
function localize(sections: site.ShowcaseSection[], locale: "en" | "es"): site.ShowcaseSection[] {
    const swap = (file: string) => {
        const own = file.replace("-en-", `-${locale}-`);
        return existsSync(join(media, own)) ? own : file;
    };
    return sections.map((section) => ({
        ...section,
        items: section.items.map((item) => ({
            ...item,
            dark: swap(item.dark),
            light: item.light ? swap(item.light) : null
        }))
    }));
}

/**
 * The apps every Polaris comes with, named and described in the dashboard's own
 * words, with what each replaces and every capture that shows it.
 */
function builtIn(webLocale: string, showcase: site.ShowcaseSection[]): site.BuiltInSiteApp[] {
    const nav = JSON.parse(read(join(web, "messages", webLocale, "nav.json")));
    const items = showcase.flatMap((section) => section.items);
    return builtInApps().map((app) => ({
        id: app.id,
        name: nav.labels?.[app.label] ?? app.label,
        description: nav.apps?.[app.id]?.description ?? app.description,
        replaces: appReplaces(app.id)
            .filter((item) => logos.has(`${item.logo}.svg`))
            .map((item) => ({ name: item.name, logo: item.logo })),
        shots: builtInScenes(app.id).flatMap((scene) => {
            const listed = items.find((item) => item.dark.startsWith(`${scene}-dark-`));
            return listed ? [listed] : captured(scene, webLocale);
        })
    }));
}

/** The feature pages under `docs/features`, by language, read once. */
const featurePages = (() => {
    const dir = join(root, "docs", "features");
    const all = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".md")) : [];
    const of = (es: boolean) =>
        all.filter((file) => file.endsWith(".es.md") === es).map((file) => read(join(dir, file)));
    return { en: of(false), es: of(true) };
})();

/**
 * A capture the README does not list, captioned the way its feature page does:
 * the section heading above the picture, and the picture's own description.
 * Nothing when no feature page shows it or the file is missing - a page never
 * points at a picture that is not there, nor one nobody has described.
 */
function captured(scene: string, webLocale: string): site.ShowcaseItem[] {
    const language = webLocale.startsWith("es") ? "es" : "en";
    const dark = `${scene}-dark-${language}-desktop.webp`;
    const light = `${scene}-light-${language}-desktop.webp`;
    if (!existsSync(join(media, dark))) return [];
    const shown = new RegExp(
        `<img src="\\.\\./assets/media/${dark.replace(/\./g, "\\.")}"[^>]*alt="([^"]*)"`
    );
    for (const page of featurePages[language]) {
        const at = shown.exec(page);
        if (!at) continue;
        const heading = /^## (.+)$/gm;
        let name = "";
        for (
            let match = heading.exec(page);
            match && match.index < at.index;
            match = heading.exec(page)
        )
            name = match[1]!.trim();
        const alt = at[1] ?? "";
        return [
            {
                name: name || alt,
                caption: name ? alt : "",
                dark,
                light: existsSync(join(media, light)) ? light : null,
                alt
            }
        ];
    }
    return [];
}

/** The dashboard's marketplace words the built-in row and an app's page use. */
function builtInWords(webLocale: string): site.BuiltInWords {
    const all = JSON.parse(read(join(web, "messages", webLocale, "marketplace.json")));
    return {
        title: all.polaris.builtIn,
        open: all.card.open,
        replaces: all.detail.replaces,
        back: all.detail.back,
        screenshots: all.detail.screenshots,
        about: all.detail.about,
        needsNothing: all.detail.needsNothing,
        by: all.card.by
    };
}

const readmeEn = read(join(root, "README.md"));
const readmeEs = read(join(root, "README.es.md"));
const replacesEn = site.parseReplaces(readmeEn, /already pay/i, logos);
const replacesEs = site.parseReplaces(readmeEs, /ya pagas/i, logos);
const showcaseEs = site.parseShowcase(readmeEs);
const openapi = buildOpenApi("https://polaris.example.com");
const info = (openapi.info ?? {}) as { title?: string; description?: string };

/** Every file under `dir` whose name passes `keep`, relative to it with forward slashes. */
function walk(dir: string, keep: (name: string) => boolean, prefix = ""): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? entry.name === "node_modules"
                ? []
                : walk(join(dir, entry.name), keep, `${prefix}${entry.name}/`)
            : keep(entry.name)
              ? [`${prefix}${entry.name}`]
              : []
    );
}

const routeSources: RouteSource[] = [];
const moduleSources: ModuleSource[] = [];
for (const app of readdirSync(join(dashboard, "apps"))) {
    const src = join(dashboard, "apps", app, "src");
    for (const file of walk(join(src, "app"), (name) => /^route\.tsx?$/.test(name)))
        if (file.startsWith("api/") || file.includes("/api/"))
            routeSources.push({ app, file, source: read(join(src, "app", file)) });
    for (const file of walk(join(src, "lib"), (name) => /\.tsx?$/.test(name)))
        moduleSources.push({
            app,
            specifier: `@/lib/${file.replace(/(\/index)?\.tsx?$/, "")}`,
            source: read(join(src, "lib", file))
        });
}
const documented = site.apiOperations(openapi as Record<string, unknown>);
const inventory = apiInventory(
    routeSources,
    moduleSources,
    documented.flatMap((group) => group.operations)
);

/** The catalogs the shared Downloads components read, cut to what they use. */
const downloadMessages = (locale: string): site.DownloadsData["messages"]["en"] => {
    const account = JSON.parse(read(join(web, "messages", locale, "account.json")));
    const components = JSON.parse(read(join(web, "messages", locale, "components.json")));
    return {
        account: { downloads: account.downloads },
        components: { installApp: components.installApp, downloads: components.downloads }
    };
};
// The same lookup the dashboard's Downloads makes, so the files offered match.
const [desktop, extension, streamdeck, companion] = await Promise.all(
    [DESKTOP_TAG_PREFIX, EXTENSION_TAG_PREFIX, STREAMDECK_TAG_PREFIX, COMPANION_TAG_PREFIX].map(
        (prefix) => appDownload(repo, prefix).catch(() => null)
    )
);

// The feature guides, one page each, in both languages.
const featuresDir = join(root, "docs", "features");
const featureFiles = readdirSync(featuresDir)
    .filter((file) => file.endsWith(".md") && !file.endsWith(".es.md"))
    .sort();
const docSlugs = new Set(featureFiles.map(docs.docSlug));
const docMedia = new Set<string>();
const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function renderDoc(slug: string, markdown: string): Promise<docs.DocPage> {
    const { title, body } = docs.splitDoc(markdown);
    const tokens = marked.lexer(body);
    // Code is highlighted the way every other block on the site is.
    const highlighted = new Map<string, string>();
    const blocks: { text: string; lang: string }[] = [];
    marked.walkTokens(tokens, (token) => {
        if (token.type === "code") blocks.push({ text: token.text, lang: token.lang || "text" });
    });
    for (const block of blocks) {
        const html = await highlight(block.text, block.lang as CodeLanguage).catch(() =>
            highlight(block.text, "text" as CodeLanguage)
        );
        highlighted.set(block.text, html);
    }
    const headings: docs.DocHeading[] = [];
    const used = new Set<string>();
    const renderer = new marked.Renderer();
    renderer.heading = (text, level, raw) => {
        let id = docs.headingId(raw) || "section";
        for (let n = 2; used.has(id); n++) id = `${docs.headingId(raw)}-${n}`;
        used.add(id);
        if (level <= 3) headings.push({ id, text: docs.plainText(text) });
        return `<h${level} id="${id}">${text}</h${level}>\n`;
    };
    renderer.code = (code) => {
        const html = highlighted.get(code) ?? `<pre><code>${escapeHtml(code)}</code></pre>`;
        return `<div class="code-block">${html}</div>\n`;
    };
    const rendered = marked.parser(tokens, { renderer, async: false }) as string;
    const { html, media: pictures } = docs.rewriteDocLinks(rendered, {
        slugs: docSlugs,
        repo,
        dir: "docs/features"
    });
    for (const picture of pictures) docMedia.add(picture);
    // The text under each heading, so search can land on the section.
    const text: Record<string, string> = {};
    const parts = html.split(/<h[1-6] id="([^"]+)">/);
    text[""] = docs.plainText(parts[0] ?? "");
    for (let at = 1; at < parts.length; at += 2)
        text[parts[at]!] = docs.plainText(parts[at + 1] ?? "");
    const summary = docs.plainText(/<p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "");
    return { slug, title, summary, headings, html, text };
}

async function guides(spanish: boolean): Promise<docs.DocPage[]> {
    const pages = await Promise.all(
        featureFiles.map((file) => {
            const slug = docs.docSlug(file);
            const own = join(featuresDir, `${slug}.es.md`);
            return renderDoc(
                slug,
                read(spanish && existsSync(own) ? own : join(featuresDir, file))
            );
        })
    );
    return pages.sort((a, b) => a.title.localeCompare(b.title));
}
const [docsEn, docsEs] = await Promise.all([guides(false), guides(true)]);

const showcaseEn = localize(site.parseShowcase(readmeEn), "en");
const showcaseEsLocal = localize(
    showcaseEs.length ? showcaseEs : site.parseShowcase(readmeEn),
    "es"
);

const data: site.SiteData = {
    repo,
    install: site.parseInstallLines(readmeEn),
    locales: {
        en: {
            apps: storeList("en-US", showcaseEn),
            store: storeWords("en-US"),
            builtIn: builtIn("en-US", showcaseEn),
            builtInWords: builtInWords("en-US"),
            replaces: replacesEn,
            showcase: showcaseEn
        },
        es: {
            apps: storeList("es-ES", showcaseEsLocal),
            store: storeWords("es-ES"),
            // The English table stands in if the Spanish README ever loses its own.
            replaces: replacesEs.length ? replacesEs : replacesEn,
            showcase: showcaseEsLocal,
            builtIn: builtIn("es-ES", showcaseEsLocal),
            builtInWords: builtInWords("es-ES")
        }
    },
    docs: { en: docsEn, es: docsEs },
    downloadsPage: {
        files: { desktop, extension, streamdeck, companion },
        storeUrl: STREAMDECK_MARKETPLACE_URL,
        messages: { en: downloadMessages("en-US"), es: downloadMessages("es-ES") }
    },
    api: {
        title: String(info.title ?? ""),
        description: String(info.description ?? ""),
        groups: documented,
        routes: inventory.routes,
        internal: inventory.internal,
        scanned: routeSources.length
    }
};

mkdirSync(join(siteDir, "generated"), { recursive: true });
mkdirSync(join(siteDir, "public", "media"), { recursive: true });
mkdirSync(join(siteDir, "public", "logos"), { recursive: true });
mkdirSync(join(siteDir, "public", "app-logos"), { recursive: true });
writeFileSync(join(siteDir, "generated", "site-data.json"), JSON.stringify(data));
writeFileSync(join(siteDir, "public", "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");

// Only the pictures a page shows, not the whole media folder.
const pictures = new Set<string>();
for (const locale of Object.values(data.locales))
    for (const section of locale.showcase)
        for (const item of section.items)
            for (const file of [item.dark, item.light]) if (file) pictures.add(file);
for (const locale of Object.values(data.locales))
    for (const app of [...locale.builtIn, ...locale.apps])
        for (const item of app.shots)
            for (const file of [item.dark, item.light]) if (file) pictures.add(file);
for (const file of docMedia) pictures.add(file);
for (const file of pictures)
    copyFileSync(join(media, file), join(siteDir, "public", "media", file));
for (const file of logos)
    copyFileSync(join(logosDir, file), join(siteDir, "public", "logos", file));
for (const file of readdirSync(appLogosDir))
    copyFileSync(join(appLogosDir, file), join(siteDir, "public", "app-logos", file));
// The dashboard's own mark, so a tab, a home screen and a shared link show the
// same Polaris icon the product does.
copyFileSync(join(web, "src", "app", "icon.svg"), join(siteDir, "public", "icon.svg"));
for (const file of [
    "favicon.ico",
    "apple-touch-icon.png",
    "polaris-mark-192.png",
    "polaris-mark-512.png"
])
    copyFileSync(join(web, "public", file), join(siteDir, "public", file));
const base = process.env.SITE_BASE_PATH ?? "/polaris";
writeFileSync(
    join(siteDir, "public", "manifest.webmanifest"),
    JSON.stringify(
        {
            name: "Polaris",
            short_name: "Polaris",
            start_url: `${base}/`,
            display: "browser",
            background_color: "#0b0c0e",
            theme_color: "#0b0c0e",
            icons: [
                { src: `${base}/icon.svg`, sizes: "any", type: "image/svg+xml" },
                { src: `${base}/polaris-mark-192.png`, sizes: "192x192", type: "image/png" },
                { src: `${base}/polaris-mark-512.png`, sizes: "512x512", type: "image/png" }
            ]
        },
        null,
        2
    ) + "\n"
);
// The games Game servers runs, with the logos the dashboard serves.
for (const game of data.locales.en.apps.flatMap((app) => app.games)) {
    mkdirSync(dirname(join(siteDir, "public", game.logo)), { recursive: true });
    copyFileSync(join(web, "public", game.logo), join(siteDir, "public", game.logo));
}
// The marketplace captures, from the dashboard's own public folder.
mkdirSync(join(siteDir, "public", "marketplace"), { recursive: true });
for (const locale of Object.values(data.locales))
    for (const app of locale.apps)
        for (const theme of app.shot ? [app.shot.dark, app.shot.light] : [])
            for (const path of [theme.desktop, theme.mobile])
                copyFileSync(join(web, "public", path), join(siteDir, "public", path));

const operations = data.api.groups.reduce((sum, group) => sum + group.operations.length, 0);
console.log(
    `[site] ${data.locales.en.apps.length} apps, ${pictures.size} pictures, ${operations} documented API operations, ${inventory.routes.length} key-reachable of ${routeSources.length} route files, ${docsEn.length} guides`
);
