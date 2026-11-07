/**
 * The TV's themes and add-ons for the site's gallery, read from the same README
 * tables `tv/tools/catalog.py` builds the release catalog from (through
 * `tv/tools/manage.py`), so the site shows what a TV can install without a
 * release at build time. Pure: the generator reads the files and copies the
 * screenshots this names.
 */

import type { TvGalleryItem } from "@polaris/ui/tv-gallery";

/** The ids catalog.py accepts: a plain folder name. */
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IMAGE = /^[A-Za-z0-9_./-]+\.(jpg|jpeg|png|webp)$/i;

/** One gallery entry and the screenshot to copy for it, relative to `tv/`. */
export interface TvGallerySource {
    readonly item: TvGalleryItem;
    readonly from: string;
}

/** What the generator reads for one add-on folder. */
export interface TvAddonFiles {
    readonly gradle: string | null;
    readonly manifest: string | null;
}

/** Rows of the first Markdown table whose header starts with `header`, as cell strings (manage.table_rows). */
export function tableRows(text: string, header: string): string[][] {
    const rows: string[][] = [];
    let inside = false;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith(header)) {
            inside = true;
            continue;
        }
        if (!inside) continue;
        if (!line.startsWith("|")) {
            if (rows.length) break;
            continue;
        }
        if (/^\|[\s:|-]+\|$/.test(line)) continue;
        rows.push(
            line
                .trim()
                .replace(/^\|+|\|+$/g, "")
                .split(" | ")
                .map((cell) => cell.trim())
        );
    }
    return rows;
}

/** A Markdown cell as text: links to their words, code marks dropped (manage.plain). */
const plain = (cell = "") =>
    cell
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replaceAll("`", "")
        .trim();

/** The `<img src>` of a cell, when it is a file inside `id`'s own folder. */
function screenshotIn(cell: string | undefined, id: string): string | null {
    const src = /<img src="([^"]+)"/.exec(cell ?? "")?.[1];
    if (!src || !IMAGE.test(src) || src.split("/").includes("..")) return null;
    return src.startsWith(`${id}/`) ? src : null;
}

/** minSdk from a Gradle file (catalog.min_sdk). */
export function minSdkOf(gradle: string | null): number | null {
    const found = /minSdk(?:Version)?\s*=?\s*\(?\s*(\d+)/.exec(gradle ?? "");
    return found ? Number(found[1]) : null;
}

const human = (id: string) =>
    id
        .split(/[-_]/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");

const extension = (path: string) => path.slice(path.lastIndexOf(".")).toLowerCase();

/**
 * Every theme and add-on the release catalog would list, in its order (kind,
 * then id). A row catalog.py would refuse - no plain id, no screenshot in its
 * own folder - is left out rather than failing the site's build.
 */
export function tvGallerySources({
    themesReadme,
    addonsReadme,
    launcherGradle,
    addon
}: {
    themesReadme: string;
    addonsReadme: string;
    launcherGradle: string | null;
    addon: (id: string) => TvAddonFiles;
}): TvGallerySource[] {
    const out: TvGallerySource[] = [];
    const launcherMin = minSdkOf(launcherGradle);
    for (const cells of tableRows(themesReadme, "| Theme |")) {
        const id = plain(cells[0]).replace(/^\/+|\/+$/g, "");
        const shot = screenshotIn(cells[2], id);
        if (!ID.test(id) || !shot) continue;
        out.push({
            from: `themes/${shot}`,
            item: {
                id,
                kind: "theme",
                name: human(id),
                description: plain(cells[1]),
                network: false,
                minSdk: launcherMin,
                screenshot: `theme-${id}${extension(shot)}`
            }
        });
    }
    for (const cells of tableRows(addonsReadme, "| Add-on |")) {
        const link = /^\[([^\]]+)\]\(([^)/]+)\/\)/.exec(cells[0] ?? "");
        if (!link) continue;
        const [, name = "", id = ""] = link;
        const shot = screenshotIn(cells[5], id);
        if (!ID.test(id) || !shot) continue;
        const files = addon(id);
        out.push({
            from: `addons/${shot}`,
            item: {
                id,
                kind: "addon",
                name,
                description: plain(cells[1]),
                network: /android:name="android\.permission\.INTERNET"/.test(files.manifest ?? ""),
                minSdk: minSdkOf(files.gradle),
                screenshot: `addon-${id}${extension(shot)}`
            }
        });
    }
    return out.sort((a, b) =>
        a.item.kind === b.item.kind
            ? a.item.id < b.item.id
                ? -1
                : 1
            : a.item.kind < b.item.kind
              ? -1
              : 1
    );
}
