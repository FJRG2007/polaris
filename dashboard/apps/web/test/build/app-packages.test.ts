/**
 * An app that lives in its own package stays there.
 *
 * `apps/places` is built and shipped apart from the dashboard (see
 * docs/installable-apps-plan.md), so it may import packages and its own files,
 * and nothing else: a path into `apps/web` is a module the app would not have
 * where it is installed. What it needs from the dashboard it takes from
 * `@polaris/app-host`.
 *
 * And the other way: the dashboard never names an app's package. An app reaches
 * a server as a bundle (lib/app-bundles), so nothing in the image may import
 * one - that would put the app back into every image, installed or not.
 */

import tailwind from "../../tailwind.config";
import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";

const DASHBOARD = resolve(__dirname, "../../../..");
const WEB = join(DASHBOARD, "apps/web");
const WEB_SRC = join(WEB, "src");

/** The apps that have moved into packages of their own. */
const PACKAGES: Readonly<Record<string, { dir: string }>> = {
    "@polaris-app/places": { dir: join(DASHBOARD, "apps/places") },
    "@polaris-app/game-servers": { dir: join(DASHBOARD, "apps/game-servers") }
};

function walk(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full, found);
        else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
    return found;
}

const SPECIFIER = /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm;

function specifiers(text: string): string[] {
    return [...text.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

const posix = (path: string) => path.split("\\").join("/");

/** Every route an app has, as `<kind> <path>`: where its file sits under
 *  `src/routes`, which is how the bundler names it. */
function appRoutes(dir: string): string[] {
    const routes = join(dir, "src", "routes");
    return walk(routes)
        .filter((file) => /[/\\](page\.tsx|route\.ts)$/.test(file))
        .map((file) => {
            const rel = posix(relative(routes, file));
            const path = `/${dirname(rel)}`.replace(/\/\.$/, "/");
            return `${rel.endsWith("page.tsx") ? "page" : "route"} ${path}`;
        });
}

describe("apps in packages of their own", () => {
    for (const [name, app] of Object.entries(PACKAGES)) {
        it(`${name} imports only packages and its own files`, () => {
            const src = join(app.dir, "src");
            const escapes: string[] = [];
            for (const file of walk(src)) {
                for (const specifier of specifiers(readFileSync(file, "utf8"))) {
                    const where = posix(relative(src, file));
                    if (specifier.startsWith("@/")) escapes.push(`${where} -> ${specifier}`);
                    if (specifier.startsWith(".")) {
                        const target = resolve(dirname(file), specifier);
                        if (!posix(target).startsWith(posix(src))) escapes.push(`${where} -> ${specifier}`);
                    }
                }
            }
            expect(escapes).toEqual([]);
        });

        // Tailwind only emits the classes it finds in the files it scans, so an
        // app package it does not scan builds and passes every other check
        // while its screens render without the layout they were written with.
        it(`Tailwind scans ${name}`, () => {
            const content = Array.isArray(tailwind.content) ? tailwind.content : tailwind.content.files;
            const scanned = content
                .filter((entry): entry is string => typeof entry === "string")
                .map((glob) => posix(resolve(WEB, glob)));
            expect(scanned).toContain(posix(join(app.dir, "src/**/*.{ts,tsx}")));
        });

        it(`the dashboard names ${name} nowhere`, () => {
            const reaches = walk(WEB_SRC)
                .filter((file) =>
                    specifiers(readFileSync(file, "utf8")).some((specifier) => specifier.startsWith(name))
                )
                .map((file) => posix(relative(WEB_SRC, file)));
            expect(reaches).toEqual([]);
        });
    }
});

/** A catch-all's path with its route groups dropped and its catch-all segment
 *  cut off: what every URL it answers starts with. */
function surfaceOf(file: string): string {
    return `/${posix(relative(join(WEB_SRC, "app"), dirname(file)))}`
        .replace(/\/\([^)]+\)/g, "")
        .replace(/\/\[\[?\.\.\.\w+\]\]?$/, "");
}

describe("the catch-alls that serve apps", () => {
    const surfaces = walk(join(WEB_SRC, "app"))
        .filter((file) => /lib\/app-bundles\/serve-(page|route)"/.test(readFileSync(file, "utf8")))
        .map((file) => ({ kind: file.endsWith("page.tsx") ? "page" : "route", prefix: surfaceOf(file) }));

    it("are found at all, so this cannot pass by reading nothing", () => {
        expect(surfaces.length).toBeGreaterThan(3);
    });

    // A route an app has that no catch-all's surface covers is a 404 the
    // in-image tables and the bundle both claim to answer.
    it("answer every route an app has", () => {
        const under = (path: string, prefix: string) => {
            const want = prefix.split("/");
            const have = path.split("/");
            return want.every((part, index) => part === have[index] || /^\[\w+\]$/.test(part));
        };
        const orphans = Object.values(PACKAGES)
            .flatMap((app) => appRoutes(app.dir))
            .map((entry) => entry.split(" "))
            .filter(
                ([kind = "", path = ""]) =>
                    !surfaces.some((surface) => surface.kind === kind && under(path, surface.prefix))
            )
            .map(([, path]) => path);
        expect(orphans).toEqual([]);
    });
});
