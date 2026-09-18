/**
 * An app that lives in its own package stays there.
 *
 * `apps/places` is built and shipped apart from the dashboard (see
 * docs/installable-apps-plan.md), so it may import packages and its own files,
 * and nothing else: a path into `apps/web` is a module the app would not have
 * where it is installed. What it needs from the dashboard it takes from
 * `@polaris/app-host`.
 *
 * And the other way: the dashboard names an app's package only in the app
 * registry and in the one-line bridges Next needs for the app's routes.
 */

import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import tailwind from "../../tailwind.config";

const DASHBOARD = resolve(__dirname, "../../../..");
const WEB = join(DASHBOARD, "apps/web");
const WEB_SRC = join(WEB, "src");

/** The apps that have moved into packages of their own, and where their routes are. */
const PACKAGES: Readonly<Record<string, { dir: string; routes: readonly RegExp[] }>> = {
    "@polaris-app/places": {
        dir: join(DASHBOARD, "apps/places"),
        routes: [/^app\/\(app\)\/places\//, /^app\/api\/home\//]
    }
};

const ROUTE_FILE = /\/(page|layout|route|loading|error|not-found|template|default)\.tsx?$/;
const REGISTRY = [/^lib\/app-extensions\/installed\.ts$/];
/** What provides the host, which the app's module reads as it is evaluated. */
const HOST_IMPORT = /^import "@\/lib\/app-host\/server";$/;
/** What hands the request on, and so evaluates the app's module. */
const HAND_OFF = /^export \{/;

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

        it(`the dashboard names ${name} only in the registry and the route bridges`, () => {
            const reaches: string[] = [];
            for (const file of walk(WEB_SRC)) {
                const where = posix(relative(WEB_SRC, file));
                if (REGISTRY.some((pattern) => pattern.test(where))) continue;
                const text = readFileSync(file, "utf8");
                if (!specifiers(text).some((specifier) => specifier.startsWith(name))) continue;
                const bridge =
                    app.routes.some((pattern) => pattern.test(where)) && ROUTE_FILE.test(`/${where}`);
                if (!bridge) reaches.push(where);
            }
            expect(reaches).toEqual([]);
        });

        const bridges = (): { where: string; code: string[] }[] => {
            const found: { where: string; code: string[] }[] = [];
            for (const file of walk(WEB_SRC)) {
                const where = posix(relative(WEB_SRC, file));
                if (!app.routes.some((pattern) => pattern.test(where)) || !ROUTE_FILE.test(`/${where}`)) continue;
                const code = readFileSync(file, "utf8")
                    .split("\n")
                    .filter((line) => line.trim() && !line.trim().startsWith("//"));
                found.push({ where, code });
            }
            return found;
        };

        it(`a ${name} route bridge only hands the request to the app`, () => {
            const bloated: string[] = [];
            for (const { where, code } of bridges()) {
                const allowed = code.every(
                    (line) =>
                        /^"use client";$/.test(line) ||
                        HOST_IMPORT.test(line) ||
                        HAND_OFF.test(line) ||
                        /^export const (dynamic|runtime|revalidate|maxDuration|dynamicParams|fetchCache) = /.test(line)
                );
                if (!allowed) bloated.push(where);
            }
            expect(bloated).toEqual([]);
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
            expect(loaders).toBeGreaterThan(5);
        });
    }
});
