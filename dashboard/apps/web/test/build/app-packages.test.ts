/**
 * An app that lives in its own package stays there.
 *
 * `apps/places` is built and shipped apart from the dashboard (see
 * docs/installable-apps-plan.md), so it may import packages and its own files,
 * and nothing else: a path into `apps/web` is a module the app would not have
 * where it is installed. What it needs from the dashboard it takes from
 * `@polaris/app-host`.
 *
 * And the other way: the dashboard names an app's package only in the tables of
 * what this image compiled in (`lib/app-bundles/in-image*.ts`), which a bundle
 * replaces, and in the client registry of the slots an app draws.
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

/** The only places the dashboard names an app's code: the tables of what this
 *  image compiled in, and the client registry of the slots apps draw. */
const REGISTRY = [
    /^lib\/app-bundles\/in-image\.ts$/,
    /^lib\/app-bundles\/in-image-pages\.ts$/,
    /^components\/app-extensions\/installed-client\.tsx$/
];
/** What provides the host, which the app's module reads as it is evaluated. */
const HOST_IMPORT = /^import "@\/lib\/app-host\/server";$/;

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

/** Every route the in-image tables list, as `<path> -> <module>`. */
function inImageRoutes(): string[] {
    const routes = readFileSync(join(WEB_SRC, "lib/app-bundles/in-image.ts"), "utf8");
    const pages = readFileSync(join(WEB_SRC, "lib/app-bundles/in-image-pages.ts"), "utf8");
    const modules = new Map(
        [...pages.matchAll(/^import \* as (\w+) from "([^"]+)";$/gm)].map((match) => [match[1], match[2]])
    );
    return [
        ...[...routes.matchAll(/"(\/[^"]*)":\s*\(\)\s*=>\s*import\(\s*"([^"]+)"\s*\)/g)].map(
            (match) => `${match[1]} -> ${match[2]}`
        ),
        ...[...pages.matchAll(/"(\/[^"]*)":\s*(\w+)/g)].map(
            (match) => `${match[1]} -> ${modules.get(match[2] ?? "")}`
        )
    ];
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

        it(`the dashboard names ${name} only in the in-image tables`, () => {
            const reaches: string[] = [];
            for (const file of walk(WEB_SRC)) {
                const where = posix(relative(WEB_SRC, file));
                if (REGISTRY.some((pattern) => pattern.test(where))) continue;
                const text = readFileSync(file, "utf8");
                if (specifiers(text).some((specifier) => specifier.startsWith(name))) reaches.push(where);
            }
            expect(reaches).toEqual([]);
        });

        // The tables are what a bundle replaces, so they have to be the app's
        // routes exactly: each named by the path it answers, which is where its
        // file sits under the app's `src/routes`.
        it(`the in-image tables list every route of ${name}, at its own path`, () => {
            const routes = join(app.dir, "src", "routes");
            const expected = walk(routes)
                .filter((file) => /[/\\](page\.tsx|route\.ts)$/.test(file))
                .map((file) => {
                    const rel = posix(relative(routes, file));
                    const path = `/${dirname(rel)}`.replace(/\/\.$/, "/");
                    return `${path} -> ${name}/src/routes/${rel.replace(/\.tsx?$/, "")}`;
                })
                .sort();
            const listed = inImageRoutes()
                .filter((entry) => entry.includes(` -> ${name}/`))
                .sort();
            expect(listed).toEqual(expected);
        });

        // An app's module takes the dashboard's services from the host as it is
        // evaluated, and naming the package is what evaluates it. A bridge or a
        // registry line that leaves the host import out, or puts it after the
        // one that loads the app, is a 500 on the first request a cold server
        // sends that way - and every other check here would still pass.
        it(`the dashboard provides the host before it loads ${name}`, () => {
            const cold: string[] = [];
            let loaders = 0;
            for (const file of walk(WEB_SRC)) {
                const code = readFileSync(file, "utf8").split("\n");
                // A client module takes the client host, which the layout provides.
                if (/^["']use client["'];?$/.test(code[0] ?? "")) continue;
                const loads = code.findIndex(
                    (line) =>
                        !line.startsWith("import type") &&
                        specifiers(line).some((specifier) => specifier.startsWith(name))
                );
                if (loads < 0) continue;
                loaders += 1;
                const provides = code.findIndex((line) => HOST_IMPORT.test(line));
                if (provides < 0 || provides > loads) cold.push(posix(relative(WEB_SRC, file)));
            }
            expect(cold).toEqual([]);
            expect(loaders).toBeGreaterThanOrEqual(2);
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
        const orphans = inImageRoutes()
            .map((entry) => entry.split(" -> "))
            .filter(([path = "", module = ""]) => {
                const kind = module.endsWith("/page") ? "page" : "route";
                return !surfaces.some((surface) => surface.kind === kind && under(path, surface.prefix));
            })
            .map(([path]) => path);
        expect(orphans).toEqual([]);
    });
});
