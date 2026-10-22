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
import { AppMark } from "@/components/app-mark";
import { STREAMDECK_MARKETPLACE_URL } from "@/lib/deck/marketplace";
import {
    appDownload,
    COMPANION_TAG_PREFIX,
    DESKTOP_TAG_PREFIX,
    EXTENSION_TAG_PREFIX,
    STREAMDECK_TAG_PREFIX
} from "@polaris/ui/account-downloads/app-releases";
import { initialsInk, tintFor } from "@polaris/core";
import { appPreview } from "@/lib/apps/app-screenshots";
import { appProvenance } from "@/lib/apps/provenance";
import { catalogApps, isOffered } from "@/lib/apps/catalog";
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
const repo = process.env.GITHUB_REPOSITORY || "FJRG2007/polaris";

const read = (path: string) => readFileSync(path, "utf8");

const catalog: site.CatalogInput[] = catalogApps()
    .filter(isOffered)
    .map((app) => ({
        id: app.id,
        name: app.name,
        category: app.category,
        summary: app.summary,
        description: app.description,
        installMethod: app.installMethod,
        comingSoon: app.comingSoon,
        // The dashboard's own mark, drawn once here so the site shows the same one.
        mark: renderToStaticMarkup(createElement(AppMark, { app, size: 40 })),
        markLarge: renderToStaticMarkup(createElement(AppMark, { app, size: 44 })),
        tint: tintFor(app.id),
        ink: initialsInk(tintFor(app.id)),
        ...appProvenance(app),
        shots: { en: appPreview(app.id, "en-US"), es: appPreview(app.id, "es-ES") }
    }));

const logos = new Set(readdirSync(logosDir));
const words = (locale: string): site.CatalogWords => ({
    ...JSON.parse(read(join(web, "messages", locale, "catalog.json"))),
    card: JSON.parse(read(join(web, "messages", locale, "marketplace.json"))).card
});

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

const data: site.SiteData = {
    repo,
    install: site.parseInstallLines(readmeEn),
    locales: {
        en: {
            apps: site.siteApps(catalog, "en", words("en-US")),
            replaces: replacesEn,
            showcase: localize(site.parseShowcase(readmeEn), "en")
        },
        es: {
            apps: site.siteApps(catalog, "es", words("es-ES")),
            // The English table stands in if the Spanish README ever loses its own.
            replaces: replacesEs.length ? replacesEs : replacesEn,
            showcase: localize(showcaseEs.length ? showcaseEs : site.parseShowcase(readmeEn), "es")
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
writeFileSync(join(siteDir, "generated", "site-data.json"), JSON.stringify(data));
writeFileSync(join(siteDir, "public", "openapi.json"), JSON.stringify(openapi, null, 2) + "\n");

// Only the pictures a page shows, not the whole media folder.
const pictures = new Set<string>();
for (const locale of Object.values(data.locales))
    for (const section of locale.showcase)
        for (const item of section.items)
            for (const file of [item.dark, item.light]) if (file) pictures.add(file);
for (const file of docMedia) pictures.add(file);
for (const file of pictures)
    copyFileSync(join(media, file), join(siteDir, "public", "media", file));
for (const file of logos)
    copyFileSync(join(logosDir, file), join(siteDir, "public", "logos", file));
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
// The marketplace captures, from the dashboard's own public folder.
mkdirSync(join(siteDir, "public", "marketplace"), { recursive: true });
for (const app of catalog)
    for (const shot of Object.values(app.shots))
        for (const theme of shot ? [shot.dark, shot.light] : [])
            for (const path of [theme.desktop, theme.mobile])
                copyFileSync(join(web, "public", path), join(siteDir, "public", path));

const operations = data.api.groups.reduce((sum, group) => sum + group.operations.length, 0);
console.log(
    `[site] ${catalog.length} apps, ${pictures.size} pictures, ${operations} documented API operations, ${inventory.routes.length} key-reachable of ${routeSources.length} route files, ${docsEn.length} guides`
);
