/**
 * The dashboard's core does not reach into an installable app's code.
 *
 * An app's code is meant to be present only on a server that installed it (see
 * docs/installable-apps-plan.md). That is only possible if nothing outside the
 * app imports its modules by path: core asks the app extension registry, and the
 * one list of installed extensions is the only place that names an app's code.
 *
 * Catalog data and port policy are not app code. The marketplace describes an
 * app whether or not it is installed, and the ports a router has to forward are
 * the edge's business, so those modules are shared.
 */

import { describe, expect, it } from "vitest";
import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

const SRC = resolve(__dirname, "../../src");

/** Every module that belongs to an installable app, as src-relative paths. */
const APPS: Readonly<Record<string, readonly RegExp[]>> = {
    "game-servers": [
        /^lib\/apps\/(minecraft|ark|fivem)\//,
        /^lib\/apps\/(console-[\w-]+|crash-loop|game-identity|game-install|game-templates(-service)?|mod-image-cache|recent-items|game-sign-in-addresses)\.ts$/,
        /^lib\/apps\/games-(?!catalog\.ts$)[\w-]+\.ts$/,
        /^lib\/apps\/player-[\w-]+\.ts$/,
        /^lib\/backups\/sources\/minecraft\.ts$/,
        /^components\/(game-(access-editor|access-form|blueprint-fields|picker|players-table)|player-(form-dialog|history|timeout-dialog)|use-game-presence)\.tsx?$/,
        /^app\/\(app\)\/apps\/games\//,
        /^app\/\(app\)\/apps\/installed\/\[id\]\/(minecraft|ark|fivem|game)-[\w-]+\.tsx?$/,
        /^app\/api\/apps\/games\//,
        /^app\/api\/minecraft\//,
        /^app\/api\/apps\/installed\/\[id\]\/(minecraft|ark|fivem|game)\//
    ]
};

/** The files allowed to name an app's code: the lists of installed extensions. */
const REGISTRY = [/^lib\/app-extensions\/installed\.ts$/, /^components\/app-extensions\/installed-client\.tsx$/];

function appOf(path: string): string | null {
    for (const [app, patterns] of Object.entries(APPS)) {
        if (patterns.some((pattern) => pattern.test(path))) return app;
    }
    return null;
}

function walk(directory: string, found: string[] = []): string[] {
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full, found);
        else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
    return found;
}

const SPECIFIER = /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveImport(from: string, specifier: string): string | null {
    let base: string;
    if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
    else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
}

const posix = (path: string) => relative(SRC, path).split("\\").join("/");

describe("core and installable apps", () => {
    it("core never imports an app's modules", () => {
        const crossings: string[] = [];
        for (const file of walk(SRC)) {
            const from = posix(file);
            const own = appOf(from);
            if (REGISTRY.some((pattern) => pattern.test(from))) continue;
            const text = readFileSync(file, "utf8");
            for (const match of text.matchAll(SPECIFIER)) {
                const target = resolveImport(file, match[1] ?? match[2] ?? "");
                if (!target) continue;
                const to = posix(target);
                const app = appOf(to);
                if (app && app !== own) crossings.push(`${from} -> ${to}`);
            }
        }
        expect(crossings).toEqual([]);
    });
});
