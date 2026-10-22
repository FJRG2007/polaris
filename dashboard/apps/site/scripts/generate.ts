/**
 * Writes `generated/site-data.json` and copies the README's pictures and logos
 * into `public/`: everything the static pages read, taken from the sources the
 * dashboard and the README already use, so a new catalogue app or a new release
 * appears on the next build with no edit to the site.
 *
 * The release lookup uses `GITHUB_TOKEN` when the workflow provides one. The
 * token only authenticates this request; nothing of it is written out.
 */

import { createElement } from "react";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenApi } from "@/lib/api-docs/openapi";
import { renderToStaticMarkup } from "react-dom/server";
import { cliInstallLine } from "@/lib/cli/install-line";
import { AppMark } from "@/components/app-mark";
import { initialsInk, tintFor } from "@polaris/core";
import { appPreview } from "@/lib/apps/app-screenshots";
import { appProvenance } from "@/lib/apps/provenance";
import { catalogApps, isOffered } from "@/lib/apps/catalog";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as site from "../src/data/builders";

const siteDir = process.env.POLARIS_SITE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const dashboard = join(siteDir, "..", "..");
const root = join(dashboard, "..");
const web = join(dashboard, "apps", "web");
const media = join(root, "docs", "assets", "media");
const logosDir = join(root, "docs", "assets", "logos");
const repo = process.env.GITHUB_REPOSITORY || "FJRG2007/polaris";

const read = (path: string) => readFileSync(path, "utf8");

/** The newest releases, or none when GitHub cannot be reached. */
async function releases(): Promise<site.ReleaseInput[]> {
    const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "polaris-site" };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    try {
        const all: site.ReleaseInput[] = [];
        for (let page = 1; page <= 3; page++) {
            const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
                headers,
                signal: AbortSignal.timeout(15000)
            });
            if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
            const batch = (await response.json()) as site.ReleaseInput[];
            all.push(...batch);
            if (batch.length < 100) break;
        }
        return all;
    } catch (error) {
        console.warn(`[site] releases unavailable, downloads link to the release pages: ${String(error)}`);
        return [];
    }
}

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
const guide = (locale: string): site.GuideWords =>
    JSON.parse(read(join(web, "messages", locale, "account.json"))).downloads.guide;
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

const data: site.SiteData = {
    repo,
    install: site.parseInstallLines(readmeEn),
    cli: { unix: cliInstallLine("linux", repo).command, windows: cliInstallLine("windows", repo).command },
    locales: {
        en: { apps: site.siteApps(catalog, "en", words("en-US")), replaces: replacesEn, showcase: localize(site.parseShowcase(readmeEn), "en"), guide: guide("en-US") },
        es: {
            apps: site.siteApps(catalog, "es", words("es-ES")),
            // The Spanish README has no such table yet; the English one stands in until it does.
            replaces: replacesEs.length ? replacesEs : replacesEn,
            showcase: localize(showcaseEs.length ? showcaseEs : site.parseShowcase(readmeEn), "es"),
            guide: guide("es-ES")
        }
    },
    downloads: site.downloadEntries(await releases(), repo),
    api: {
        title: String(info.title ?? ""),
        description: String(info.description ?? ""),
        groups: site.apiOperations(openapi as Record<string, unknown>)
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
        for (const item of section.items) for (const file of [item.dark, item.light]) if (file) pictures.add(file);
for (const file of pictures) copyFileSync(join(media, file), join(siteDir, "public", "media", file));
for (const file of logos) copyFileSync(join(logosDir, file), join(siteDir, "public", "logos", file));
// The marketplace captures, from the dashboard's own public folder.
mkdirSync(join(siteDir, "public", "marketplace"), { recursive: true });
for (const app of catalog)
    for (const shot of Object.values(app.shots))
        for (const theme of shot ? [shot.dark, shot.light] : [])
            for (const path of [theme.desktop, theme.mobile]) copyFileSync(join(web, "public", path), join(siteDir, "public", path));

const operations = data.api.groups.reduce((sum, group) => sum + group.operations.length, 0);
const released = data.downloads.filter((entry) => entry.released).length;
console.log(`[site] ${catalog.length} apps, ${pictures.size} pictures, ${operations} API operations, ${released} released products`);
