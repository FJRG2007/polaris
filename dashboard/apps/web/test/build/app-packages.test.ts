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

const DASHBOARD = resolve(__dirname, "../../../..");
const WEB_SRC = join(DASHBOARD, "apps/web/src");

/** The apps that have moved into packages of their own, and where their routes are. */
const PACKAGES: Readonly<Record<string, { dir: string; routes: readonly RegExp[] }>> = {
    "@polaris-app/places": {
        dir: join(DASHBOARD, "apps/places"),
        routes: [/^app\/\(app\)\/places\//, /^app\/api\/home\//]
    }
};

const ROUTE_FILE = /\/(page|layout|route|loading|error|not-found|template|default)\.tsx?$/;
const REGISTRY = [/^lib\/app-extensions\/installed\.ts$/];

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

        it(`a ${name} route bridge only hands the request to the app`, () => {
            const bloated: string[] = [];
            for (const file of walk(WEB_SRC)) {
                const where = posix(relative(WEB_SRC, file));
                if (!app.routes.some((pattern) => pattern.test(where)) || !ROUTE_FILE.test(`/${where}`)) continue;
                const code = readFileSync(file, "utf8")
                    .split("\n")
                    .filter((line) => line.trim() && !line.trim().startsWith("//"));
                const allowed = code.every(
                    (line) =>
                        /^"use client";$/.test(line) ||
                        /^import "@\/lib\/app-host\/server";$/.test(line) ||
                        line.startsWith("export {") ||
                        /^export const (dynamic|runtime|revalidate|maxDuration|dynamicParams|fetchCache) = /.test(line)
                );
                if (!allowed) bloated.push(where);
            }
            expect(bloated).toEqual([]);
        });
    }
});
